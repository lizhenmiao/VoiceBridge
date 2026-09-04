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

  var IN_RATE = 24000;   // 会话 config 下发后覆盖（上游 pcm16 固定 24k）
  var OUT_RATE = 24000;
  var CHUNK_MS = 200;    // 采集攒块时长

  var ws = null;
  var audioCtx = null;
  var micStream = null;
  var captureNode = null;   // AudioWorkletNode 或 ScriptProcessor
  var muteNode = null;
  var active = false;       // 通话中（含连接中）
  var busy = false;         // 正在握手
  var timerId = 0;
  var awaitTimer = 0;

  // 客户端 VAD（网关 server_vad 的自动应答路径有缺陷，改为前端静音检测
  // + 主动 commit/response.create。静音阈值 350ms：必须抢在网关转写完成
  // 触发关闭连接之前提交，800ms 会输掉时序）
  var vad = {
    speaking: false,
    lastVoiceAt: 0,
    noiseFloor: 0.02,   // 自适应噪声底
    voiceStreak: 0,     // 连续超阈值块数（起音判定用，防吸气/碰麦误触发）
    silenceMs: 600,     // 静音超过该时长视为说完
    awaiting: false,    // 已提交 commit+create，等待 response.done
    playing: false,     // 回复音频播放中（打断判定用）
    lastCommitAt: 0     // 上次提交时刻（提交后短暂屏蔽起音判定）
  };

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
    captionItems = {};
    botAcc = {};
  }

  // ================= 字幕 =================
  // 上游转写是"渐进式"的：同一 item 会多次 updated/completed，网关还可能
  // 重放 delta。因此按 item_id 建卡、每次整体替换文本（以最新为准），
  // 不做字符串追加，避免同一句话重复多张卡或重复拼贴。

  var captionItems = {};  // item_id -> {el}
  var botAcc = {};        // item_id -> 已累计的 bot delta 文本

  function upsertCaption(role, itemId, text) {
    if (!text) return;
    var key = itemId || ('_anon_' + role);
    var entry = captionItems[key];
    if (!entry) {
      var el = document.createElement('div');
      el.className = 'cap ' + (role === 'user' ? 'cap-user' : 'cap-bot');
      callCaptions.appendChild(el);
      entry = captionItems[key] = { el: el };
      // 只保留最近 12 张字幕卡
      var keys = Object.keys(captionItems);
      if (keys.length > 12) {
        captionItems[keys[0]].el.remove();
        delete captionItems[keys[0]];
      }
    }
    entry.el.textContent = text;
    callCaptions.scrollTop = callCaptions.scrollHeight;
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
        // 音频就绪后再连 WS，握手成功即刻置 active，避免竞态丢块
        return connectWS();
      })
      .then(function (socket) {
        ws = socket; // 关键：绑定全局 ws，否则 send() 全部空转、音频不发
        busy = false;
        active = true;
        setOrb('idle');
        setStatus('请开始说话');
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
        setStatus('请开始说话');
        break;
      case 'input_audio_buffer.speech_started':
        stopPlayback();          // 用户开口 → 立即打断播放
        setOrb('listening');
        setStatus('正在聆听…');
        break;
      case 'input_audio_buffer.speech_stopped':
        break; // 客户端 VAD 负责断句
      case 'conversation.item.input_audio_transcription.delta':
      case 'conversation.item.input_audio_transcription_partial':
      case 'conversation.item.input_audio_transcription.updated':
        // 部分/增量转写：同一 item 整体刷新
        upsertCaption('user', data.item_id, data.transcript || data.delta || '');
        break;
      case 'conversation.item.input_audio_transcription.completed':
        // 终稿（可能多次触发）：覆盖为最终文本
        upsertCaption('user', data.item_id, data.transcript || '');
        break;
      case 'response.created':
        setOrb('speaking');
        setStatus('正在回应…');
        break;
      case 'response.audio_transcript.delta':
      case 'response.output_audio_transcript.delta':
        // bot 的 delta 是纯增量，累计到该 item；done 事件会整体覆盖，不重复拼
        var bKey = data.item_id || '_bot';
        botAcc[bKey] = (botAcc[bKey] || '') + (data.delta || '');
        upsertCaption('bot', data.item_id, botAcc[bKey]);
        break;
      case 'response.audio_transcript.done':
      case 'response.output_audio_transcript.done':
        if (data.transcript !== undefined) {
          upsertCaption('bot', data.item_id, data.transcript);
          delete botAcc[data.item_id || '_bot'];
        }
        break;
      case 'ping':
      case 'rate_limits.updated':
      case 'conversation.created':
      case 'conversation.item.created':
      case 'response.content_part.added':
      case 'response.content_part.done':
      case 'response.output_item.added':
      case 'response.output_item.done':
      case 'response.output_audio.done':
      case 'response.output_audio_transcript.done':
        break;
      case 'response.done':
        vad.awaiting = false;
        clearTimeout(awaitTimer);
        // 音频播完或排队播完后复位播放标记（延迟等队列排空）
        setTimeout(function () {
          if (!playQueue.length) vad.playing = false;
        }, 800);
        setOrb('idle');
        setStatus('请继续说…');
        break;
      case 'response.cancelled':
        vad.awaiting = false;
        clearTimeout(awaitTimer);
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
      // Chrome 的 AudioContext 可能以 suspended 状态启动（自动播放策略），
      // 不 resume 的话 onaudioprocess / worklet 永远不产出数据 → 音频块=0
      if (audioCtx.state === 'suspended') {
        audioCtx.resume().catch(function () {});
      }
      var source = audioCtx.createMediaStreamSource(stream);

      // 静音输出节点：维持处理图活跃但零输出（不产生啸叫），Safari 兼容
      muteNode = audioCtx.createGain();
      muteNode.gain.value = 0;
      muteNode.connect(audioCtx.destination);

      var acc = [];
      var accLen = 0;
      var chunkLen = Math.round(audioCtx.sampleRate * CHUNK_MS / 1000);
      var sendCount = 0;      // 已发送块数（前端自检 + 日志对照）
      var dropCount = 0;      // 因未激活被丢弃的块数
      var lastVadLog = 0;     // VAD 状态变化日志节流

      function feed(f32) {
        // 能量检测（客户端 VAD）
        var sum = 0;
        for (var k = 0; k < f32.length; k++) sum += f32[k] * f32[k];
        var rms = Math.sqrt(sum / f32.length);
        if (rms < vad.noiseFloor) vad.noiseFloor = vad.noiseFloor * 0.9 + rms * 0.1;
        var thresh = Math.max(vad.noiseFloor * 2.5, 0.015);
        var now = Date.now();
        if (rms > thresh) {
          vad.lastVoiceAt = now;
          vad.voiceStreak += 1;
          // 起音判定：连续 2 块超阈值才算开口（防吸气/短促噪声误触发）；
          // 刚提交应答后 1.2s 内屏蔽新起音（等回复开始，避免自我打断）
          if (!vad.speaking && vad.voiceStreak >= 2 &&
              now - vad.lastCommitAt > 1200) {
            vad.speaking = true;
            setOrb('listening');
            setStatus('正在聆听…');
            // 仅在确实播放回复时才需要 cancel，避免 "no active response" 报错
            if (vad.playing) {
              send({ type: 'response.cancel' });
              stopPlayback();
            }
          }
        } else {
          vad.voiceStreak = 0;
          if (vad.speaking && now - vad.lastVoiceAt > vad.silenceMs) {
            vad.speaking = false;
            if (!vad.awaiting) {
              vad.awaiting = true;
              vad.lastCommitAt = now;
              send({ type: 'input_audio_buffer.commit' });
              send({ type: 'response.create' });
              setOrb('thinking');
              setStatus('思考中…');
              // 看门狗：上游迟迟不回 response.done 时解除等待，避免卡死
              clearTimeout(awaitTimer);
              awaitTimer = setTimeout(function () {
                if (vad.awaiting) {
                  vad.awaiting = false;
                  setOrb('idle');
                  setStatus('响应超时，请再说一次');
                }
              }, 20000);
            }
          }
        }

        acc.push(f32);
        accLen += f32.length;
        if (accLen < chunkLen) return;
        var merged = new Float32Array(accLen);
        var off = 0;
        for (var i = 0; i < acc.length; i++) {
          merged.set(acc[i], off);
          off += acc[i].length;
        }
        acc = [];
        accLen = 0;
        // 会话未就绪时丢弃（正常：握手需要约 1s，期间的块无法发送）
        if (!active || !ws || ws.readyState !== 1) {
          dropCount += 1;
          return;
        }
        var resampled = resampleLinear(merged, audioCtx.sampleRate, IN_RATE);
        var i16 = floatTo16(resampled);
        try {
          ws.send(i16.buffer);
          sendCount += 1;
          // 心跳：首次发送与每 50 块（10 秒）打一次状态，帮助自检
          if (sendCount === 1 || sendCount % 50 === 0) {
            setStatus('已发送 ' + sendCount + ' 块 · ' + (vad.speaking ? '聆听中' : '待机'));
          }
        } catch (e) {
          /* 连接刚断开时的竞态，忽略 */
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
    vad.playing = true;
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
    vad.playing = false;
  }

  window.addEventListener('beforeunload', function () {
    if (ws) { try { ws.close(); } catch (e) {} }
  });
})();
