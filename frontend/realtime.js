/* VoiceBridge — 实时通话（Realtime WebSocket）
 * 链路：麦克风 PCM → 本服务 /ws/realtime（key 由后端代持）→ 上游 Realtime
 * 音频：上行二进制 PCM16（按 session.config 的 in_rate 重采样）
 *       下行二进制 PCM16（按 out_rate 建播放缓冲，Web Audio 自动重采样）
 * 交互：服务端 VAD 自动断句；用户开口即打断播放；字幕实时上屏
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var btnCall = $('btnCall');
  var callOverlay = $('callOverlay');
  var btnCallClose = $('btnCallClose');
  var btnCallAction = $('btnCallAction');
  var callOrb = $('callOrb');
  var callStatus = $('callStatus');
  var callTimer = $('callTimer');
  var callCaptions = $('callCaptions');

  var IN_RATE = 16000;   // 会话 config 下发后覆盖
  var OUT_RATE = 24000;
  var CHUNK_SAMPLES = 3200; // 采集端攒块大小（按 in_rate 计，200ms）

  var ws = null;
  var audioCtx = null;
  var micStream = null;
  var captureNode = null;   // AudioWorkletNode 或 ScriptProcessor
  var muteNode = null;
  var active = false;       // 通话中（含连接中）
  var busy = false;         // 正在握手
  var timerId = 0;
  var captionUser = null;
  var captionBot = null;

  // ================= 状态 UI =================

  function setStatus(text) { callStatus.textContent = text; }
  function setOrb(state) { callOrb.className = 'orb ' + state; }

  function startTimer() {
    var startAt = Date.now();
    timerId = setInterval(function () {
      var s = Math.floor((Date.now() - startAt) / 1000);
      callTimer.textContent = Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
    }, 250);
  }
  function stopTimer() { clearInterval(timerId); callTimer.textContent = ''; }

  function clearCaptions() {
    callCaptions.innerHTML = '';
    captionUser = null;
    captionBot = null;
  }

  // ================= 字幕 =================

  function appendDelta(kind, text) {
    if (!text) return;
    var el = kind === 'user' ? captionUser : captionBot;
    if (!el) {
      el = document.createElement('div');
      el.className = 'cap ' + (kind === 'user' ? 'cap-user' : 'cap-bot');
      callCaptions.appendChild(el);
      if (kind === 'user') captionUser = el; else captionBot = el;
    }
    el.textContent += text;
    callCaptions.scrollTop = callCaptions.scrollHeight;
  }
  function closeCaption(kind) {
    if (kind === 'user') captionUser = null; else captionBot = null;
  }

  // ================= 入口 / 生命周期 =================

  btnCall.addEventListener('click', function () {
    if (busy || active) return;
    callOverlay.classList.remove('hidden');
    setOrb('idle');
    setStatus('点击下方按钮开始通话');
  });

  btnCallClose.addEventListener('click', endCall);
  btnCallAction.addEventListener('click', function () {
    if (busy || active) endCall();
    else startCall();
  });

  function startCall() {
    if (busy || active) return;
    busy = true;
    clearCaptions();
    setOrb('connecting');
    setStatus('连接中…');
    btnCallAction.classList.add('active');

    setupAudio()
      .then(function () {
        return connectWS();
      })
      .then(function () {
        busy = false;
        active = true;
        setOrb('idle');
        setStatus('正在聆听…');
        startTimer();
      })
      .catch(function (err) {
        busy = false;
        setOrb('idle');
        setStatus(err && err.message ? err.message : '连接失败');
        teardown();
        setTimeout(function () {
          callOverlay.classList.add('hidden');
        }, 1600);
      });
  }

  function endCall() {
    teardown();
    callOverlay.classList.add('hidden');
  }

  function teardown() {
    busy = false;
    active = false;
    stopTimer();
    stopPlayback();
    if (captureNode) { try { captureNode.disconnect(); } catch (e) {} captureNode = null; }
    if (muteNode) { try { muteNode.disconnect(); } catch (e) {} muteNode = null; }
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
      audioCtx = null;
    }
    if (ws) {
      var s = ws;
      ws = null;
      try { s.close(); } catch (e) {}
    }
    setOrb('idle');
    btnCallAction.classList.remove('active');
  }

  // ================= WebSocket =================

  function wsUrl() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    return proto + location.host + '/ws/realtime';
  }

  function connectWS() {
    return new Promise(function (resolve, reject) {
      var socket = new WebSocket(wsUrl());
      socket.binaryType = 'arraybuffer';
      var opened = false;
      socket.onopen = function () {
        opened = true;
        resolve(socket);
      };
      socket.onerror = function () {
        if (!opened) reject(new Error('无法连接实时服务'));
      };
      socket.onclose = function () {
        if (active) {
          // 通话中被服务端断开
          active = false;
          teardown();
          callOverlay.classList.add('hidden');
        }
      };
      socket.onmessage = onServerEvent;
    });
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ================= 服务端事件 =================

  function onServerEvent(ev) {
    if (ev.data instanceof ArrayBuffer) {
      onAudioChunk(new Uint8Array(ev.data));
      return;
    }
    var data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    var type = data.type || '';

    switch (type) {
      case 'session.config':
        IN_RATE = data.in_rate || IN_RATE;
        OUT_RATE = data.out_rate || OUT_RATE;
        break;
      case 'error':
        setStatus('错误：' + ((data.error && data.error.message) || '未知'));
        break;
      case 'session.created':
      case 'session.updated':
        setOrb('idle');
        setStatus('正在聆听…');
        break;
      case 'input_audio_buffer.speech_started':
        stopPlayback();          // 用户开口 → 立即打断播放
        setOrb('listening');
        setStatus('正在聆听…');
        break;
      case 'input_audio_buffer.speech_stopped':
        setOrb('thinking');
        setStatus('思考中…');
        break;
      case 'conversation.item.input_audio_transcription.delta':
        appendDelta('user', data.delta || '');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        appendDelta('user', data.transcript || '');
        closeCaption('user');
        break;
      case 'response.created':
        setOrb('speaking');
        setStatus('正在回应…');
        break;
      case 'response.audio_transcript.delta':
        appendDelta('bot', data.delta || '');
        break;
      case 'response.audio_transcript.done':
        if (data.transcript) appendDelta('bot', data.transcript);
        closeCaption('bot');
        break;
      case 'response.done':
        closeCaption('bot');
        setOrb('idle');
        setStatus('正在聆听…');
        break;
    }
  }

  // ================= 采集 =================

  function setupAudio() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('当前浏览器不支持麦克风采集（需 https 或 localhost）'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      micStream = stream;
      // 采集 context 不指定采样率（跟随设备），由 resampleLinear 统一到 IN_RATE
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var source = audioCtx.createMediaStreamSource(stream);

      // 静音输出节点：维持处理图活跃但零输出（不产生啸叫），Safari 兼容
      muteNode = audioCtx.createGain();
      muteNode.gain.value = 0;
      muteNode.connect(audioCtx.destination);

      var acc = [];
      var accLen = 0;

      function feed(f32) {
        acc.push(f32);
        accLen += f32.length;
        if (accLen < CHUNK_SAMPLES * (audioCtx.sampleRate / IN_RATE) * 0.9) return;
        var merged = new Float32Array(accLen);
        var off = 0;
        for (var i = 0; i < acc.length; i++) {
          merged.set(acc[i], off);
          off += acc[i].length;
        }
        acc = [];
        accLen = 0;
        if (!active && !busy) return;
        var resampled = resampleLinear(merged, audioCtx.sampleRate, IN_RATE);
        // 固定按 CHUNK_SAMPLES 切块发送
        for (var p = 0; p + CHUNK_SAMPLES <= resampled.length; p += CHUNK_SAMPLES) {
          var slice = resampled.subarray(p, p + CHUNK_SAMPLES);
          var i16 = floatTo16(slice);
          if (ws && ws.readyState === 1) ws.send(i16.buffer);
        }
      }

      if (audioCtx.audioWorklet) {
        return audioCtx.audioWorklet.addModule(
          URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
        ).then(function () {
          captureNode = new AudioWorkletNode(audioCtx, 'pcm-capture');
          captureNode.port.onmessage = function (ev) { feed(ev.data); };
          source.connect(captureNode);
          captureNode.connect(muteNode);
        });
      }
      // 兜底：ScriptProcessor（老浏览器）
      return new Promise(function (resolve) {
        captureNode = audioCtx.createScriptProcessor(4096, 1, 1);
        captureNode.onaudioprocess = function (ev) {
          feed(new Float32Array(ev.inputBuffer.getChannelData(0)));
        };
        source.connect(captureNode);
        captureNode.connect(muteNode);
        resolve();
      });
    });
  }

  var WORKLET_SRC = [
    'class PCMCapture extends AudioWorkletProcessor {',
    '  constructor() {',
    '    super();',
    '    this._chunk = new Float32Array(4800);',
    '    this._pos = 0;',
    '  }',
    '  process(inputs) {',
    '    const input = inputs[0];',
    '    if (!input || !input[0]) return true;',
    '    const ch = input[0];',
    '    for (let i = 0; i < ch.length; i++) {',
    '      this._chunk[this._pos++] = ch[i];',
    '      if (this._pos >= this._chunk.length) {',
    '        this.port.postMessage(this._chunk.slice(0));',
    '        this._pos = 0;',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    'registerProcessor("pcm-capture", PCMCapture);'
  ].join('\n');

  // 线性插值重采样
  function resampleLinear(f32, fromRate, toRate) {
    if (fromRate === toRate) return f32;
    var ratio = fromRate / toRate;
    var n = Math.floor(f32.length / ratio);
    var out = new Float32Array(n);
    for (var i = 0; i < n; i++) {
      var pos = i * ratio;
      var i0 = Math.floor(pos);
      var frac = pos - i0;
      var i1 = Math.min(i0 + 1, f32.length - 1);
      out[i] = f32[i0] * (1 - frac) + f32[i1] * frac;
    }
    return out;
  }

  function floatTo16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var s = Math.max(-1, Math.min(1, f32[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  // ================= 播放 =================

  var playQueue = [];
  var scheduled = [];
  var nextAt = 0;

  function onAudioChunk(bytes) {
    // 上游 PCM（out_rate）；Web Audio 会自动把 AudioBuffer 重采样到 context 率
    playQueue.push(bytes);
    drain();
  }

  function drain() {
    if (!audioCtx) return;
    while (playQueue.length) {
      var bytes = playQueue.shift();
      var i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
      var f32 = new Float32Array(i16.length);
      for (var i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
      var buf;
      try {
        buf = audioCtx.createBuffer(1, f32.length, OUT_RATE);
      } catch (e) {
        return; // 采样率非法等异常：放弃本次播放
      }
      buf.copyToChannel(f32, 0);
      var src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      var now = audioCtx.currentTime;
      if (nextAt < now + 0.03) nextAt = now + 0.03;
      src.start(nextAt);
      nextAt += buf.duration;
      scheduled.push(src);
    }
  }

  function stopPlayback() {
    playQueue.length = 0;
    scheduled.forEach(function (s) {
      try { s.stop(); } catch (e) {}
    });
    scheduled = [];
    nextAt = 0;
  }

  window.addEventListener('beforeunload', function () {
    if (ws) { try { ws.close(); } catch (e) {} }
  });
})();
