/* VoiceBridge — Apple 风格语音对话
 * 数据流：录音/文字 → POST /api/chat (multipart) → {user_text, reply_text, audio(base64 wav)}
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var chatList = $('chatList');
  var connStatus = $('connStatus');
  var statusText = $('statusText');
  var welcome = $('welcome');
  var textInput = $('textInput');
  var inputWrap = $('inputWrap');
  var recWrap = $('recWrap');
  var recTime = $('recTime');
  var actionBtn = $('actionBtn');
  var toastEl = $('toast');

  var MAX_UPLOAD_MB = 20;
  var MAX_RECORD_SECONDS = 60;
  var REQUEST_TIMEOUT_MS = 120000;

  // 微信内置浏览器(iOS)的 MediaRecorder 只认 audio/mp4，按优先级探测
  var MIME_CANDIDATES = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];

  var recorder = null;
  var audioStream = null;
  var chunks = [];
  var chosenMime = '';
  var recordStartTime = 0;
  var recordTimerId = 0;
  var recording = false;
  var history = [];        // [{role, content}] LLM 上下文
  var busy = false;        // 正在等待后端回复
  var toastTimer = 0;
  var llmHintShown = false;

  var sharedAudio = new Audio();
  var currentCard = null;  // 正在播放的语音条 DOM
  var liveUrls = [];       // 会话期间保留的所有 blob 播放地址，页面卸载时统一释放

  function trackUrl(url) {
    liveUrls.push(url);
    return url;
  }

  // ================= UI 基础 =================

  function toast(msg, isError) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('hidden', false);
    toastEl.style.background = isError ? 'rgba(255,59,48,0.88)' : '';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.add('hidden'); }, 3600);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function scrollBottom() {
    requestAnimationFrame(function () {
      chatList.scrollTop = chatList.scrollHeight;
    });
  }

  function hideWelcome() {
    if (welcome) { welcome.remove(); welcome = null; }
  }

  // ================= 消息渲染 =================

  // 行结构：[气泡][可选转写]，flex 列对齐到左/右
  function newRow(role) {
    hideWelcome();
    var row = document.createElement('div');
    row.className = 'msg ' + role;
    chatList.appendChild(row);
    return row;
  }

  function addTextRow(role, text) {
    var row = newRow(role);
    var bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    scrollBottom();
    return row;
  }

  // 伪随机但稳定的波形（每条消息形状不同且固定）
  function buildWave(container, seed) {
    for (var i = 0; i < 18; i++) {
      var bar = document.createElement('i');
      var h = 22 + ((seed * 97 + i * 37) % 78);
      bar.style.height = h + '%';
      bar.style.animationDelay = (i * 45) + 'ms';
      container.appendChild(bar);
    }
  }

  function addVoiceRow(role, audioUrl, seconds, transcript, seed) {
    var row = newRow(role);
    var sec = Math.max(1, Math.round(seconds || 1));
    var mins = Math.floor(sec / 60);
    var durText = mins + ':' + (sec % 60 < 10 ? '0' : '') + (sec % 60);

    var bubble = document.createElement('div');
    bubble.className = 'bubble voice-bubble';
    bubble.innerHTML =
      '<button class="play-btn" type="button" aria-label="播放">' +
      '<svg class="icon icon-play" viewBox="0 0 24 24"><path d="M8.2 5.6c0-.9.97-1.45 1.75-1L18.9 10c.77.45.77 1.55 0 2l-8.95 5.4c-.78.45-1.75-.1-1.75-1V5.6z"/></svg>' +
      '<svg class="icon icon-pause" viewBox="0 0 24 24"><path d="M7 5.5h3.4v13H7zM13.6 5.5H17v13h-3.4z"/></svg>' +
      '</button>' +
      '<span class="wave"></span>' +
      '<span class="voice-sec">' + durText + '</span>';
    row.appendChild(bubble);

    if (transcript) {
      var t = document.createElement('div');
      t.className = 'transcript';
      t.textContent = transcript;
      row.appendChild(t);
    }

    buildWave(bubble.querySelector('.wave'), seed || (history.length + 3) * 7 + sec);

    var card = bubble; // .voice-bubble 兼任卡片
    card.classList.add('voice-card');
    card.addEventListener('click', function () {
      // 正在播放本条 → 再点一次停止
      if (currentCard === card && !sharedAudio.paused) {
        stopPlayback();
        return;
      }
      stopPlayback();
      sharedAudio.src = audioUrl;
      currentCard = card;
      card.classList.add('playing');
      sharedAudio.play().catch(function () {
        card.classList.remove('playing');
        toast('播放失败，请重试');
      });
    });

    scrollBottom();
    return { row: row, bubble: bubble };
  }

  function appendTranscript(row, text) {
    if (!text) return;
    var t = document.createElement('div');
    t.className = 'transcript';
    t.textContent = text;
    row.appendChild(t);
    scrollBottom();
  }

  function addSysline(text) {
    hideWelcome();
    var el = document.createElement('div');
    el.className = 'sysline';
    el.textContent = text;
    chatList.appendChild(el);
    scrollBottom();
  }

  function addTypingRow() {
    hideWelcome();
    var row = document.createElement('div');
    row.className = 'msg bot';
    row.innerHTML =
      '<div class="bubble typing-bubble"><span class="typing"><i></i><i></i><i></i></span></div>';
    chatList.appendChild(row);
    scrollBottom();
    return function () { row.remove(); };
  }

  function stopPlayback() {
    sharedAudio.pause();
    if (currentCard) {
      currentCard.classList.remove('playing');
      currentCard = null;
    }
  }

  sharedAudio.addEventListener('ended', stopPlayback);
  sharedAudio.addEventListener('error', stopPlayback);

  // ================= 服务状态 =================

  function setStatus(state, text) {
    connStatus.dataset.state = state;
    statusText.textContent = text;
  }

  function checkHealth() {
    fetch('/api/health')
      .then(function (r) { return r.json(); })
      .then(function (h) {
        if (h.status === 'ok') {
          setStatus('ok', '在线');
        } else if (h.status === 'loading') {
          setStatus('warn', '启动中');
          setTimeout(checkHealth, 5000);
        } else {
          var err = (h.asr && h.asr.error) || (h.tts && h.tts.error) || '';
          setStatus('bad', /未配置/.test(err) ? '未配置语音 Key' : '服务受限');
        }
      })
      .catch(function () {
        setStatus('bad', '无法连接');
      });
  }

  // ================= 输入按钮（麦克风 / 发送 / 停止） =================

  function updateActionBtn() {
    actionBtn.classList.remove('mode-mic', 'mode-send', 'mode-stop');
    if (recording) {
      actionBtn.classList.add('mode-stop');
      actionBtn.setAttribute('aria-label', '停止并发送');
    } else if (textInput.value.trim()) {
      actionBtn.classList.add('mode-send');
      actionBtn.setAttribute('aria-label', '发送');
    } else {
      actionBtn.classList.add('mode-mic');
      actionBtn.setAttribute('aria-label', '按住录音');
    }
  }

  // ================= 录音 =================

  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return '';
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(MIME_CANDIDATES[i])) {
          return MIME_CANDIDATES[i];
        }
      } catch (e) { /* try next */ }
    }
    return '';
  }

  function extensionFor(mime) {
    if (!mime) return '.webm';
    if (mime.indexOf('webm') >= 0) return '.webm';
    if (mime.indexOf('mp4') >= 0) return '.mp4';
    if (mime.indexOf('ogg') >= 0) return '.ogg';
    return '.webm';
  }

  function micErrorMessage(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
      return '麦克风权限被拒绝：请在浏览器设置中允许本页面使用麦克风';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '未检测到麦克风设备';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麦克风被其他应用占用';
    }
    return '获取麦克风失败：' + ((err && err.message) || name || '未知错误');
  }

  function ensureMic(cb) {
    if (audioStream && audioStream.active) { cb(null, audioStream); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cb(new Error('当前浏览器不支持麦克风采集，请用 Chrome / Edge / Firefox / iOS Safari 14.3+ 并通过 https 或 localhost 访问'));
      return;
    }
    navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
    }).then(function (stream) {
      audioStream = stream;
      cb(null, stream);
    }).catch(cb);
  }

  function startRecording(stream) {
    chunks = [];
    chosenMime = pickMimeType();
    try {
      recorder = new MediaRecorder(stream, chosenMime ? { mimeType: chosenMime } : undefined);
    } catch (e) {
      recorder = new MediaRecorder(stream);
      chosenMime = '';
    }
    recorder.ondataavailable = function (ev) {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    recorder.onerror = function () {
      toast('录音出错，请重试', true);
      resetRecordUI();
    };
    recorder.onstop = onRecorderStop;

    recorder.start(200);
    recording = true;
    recordStartTime = Date.now();
    inputWrap.classList.add('hidden');
    recWrap.classList.remove('hidden');
    updateActionBtn();
    recordTimerId = setInterval(function () {
      var sec = (Date.now() - recordStartTime) / 1000;
      recTime.textContent = Math.floor(sec / 60) + ':' + (Math.floor(sec) % 60 < 10 ? '0' : '') + Math.floor(sec) % 60;
      if (sec >= MAX_RECORD_SECONDS) {
        toast('已达最长录音 ' + MAX_RECORD_SECONDS + ' 秒，自动发送');
        stopRecording();
      }
    }, 200);
  }

  function onRecorderStop() {
    var duration = (Date.now() - recordStartTime) / 1000;
    clearInterval(recordTimerId);
    var blob = new Blob(chunks, { type: chosenMime || 'audio/webm' });
    chunks = [];
    resetRecordUI();

    if (duration < 0.5 || blob.size < 2000) {
      toast('说话时间太短');
      return;
    }
    if (blob.size > MAX_UPLOAD_MB * 1024 * 1024) {
      toast('录音文件超过 ' + MAX_UPLOAD_MB + 'MB，请缩短时长', true);
      return;
    }
    // 每条消息发完就释放麦克风
    if (audioStream) {
      audioStream.getTracks().forEach(function (t) { t.stop(); });
      audioStream = null;
    }
    sendChat(blob, duration);
  }

  function resetRecordUI() {
    recording = false;
    clearInterval(recordTimerId);
    recWrap.classList.add('hidden');
    inputWrap.classList.remove('hidden');
    updateActionBtn();
  }

  function stopRecording() {
    if (!recording) { resetRecordUI(); return; }
    try {
      if (recorder && recorder.state !== 'inactive') recorder.stop();
    } catch (e) { resetRecordUI(); }
  }

  // ================= 发送对话 =================

  function sendChat(audioBlob, seconds) {
    if (busy) { toast('上一条还在处理中，稍等一下'); return; }
    var text = '';
    if (!audioBlob) {
      text = (textInput.value || '').trim();
      if (!text) return;
      textInput.value = '';
      autoGrow();
      updateActionBtn();
    }

    busy = true;
    updateActionBtn();

    var localUrl = null;
    var userRow = null;
    if (audioBlob) {
      localUrl = trackUrl(URL.createObjectURL(audioBlob));
      userRow = addVoiceRow('user', localUrl, seconds, '', Math.floor(seconds * 10) + 5).row;
    } else {
      userRow = addTextRow('user', text);
    }
    var removeTyping = addTypingRow();

    var controller = new AbortController();
    var timeoutId = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS);

    var form = new FormData();
    form.append('history', JSON.stringify(history.slice(-12)));
    if (audioBlob) {
      form.append('file', audioBlob, 'voice' + extensionFor(audioBlob.type));
    } else {
      form.append('text', text);
    }

    fetch('/api/chat', { method: 'POST', body: form, signal: controller.signal })
      .then(function (resp) {
        return resp.json().catch(function () { return null; }).then(function (data) {
          if (!resp.ok) {
            var msg = data && data.detail ? (typeof data.detail === 'string' ? data.detail : data.detail.message) : null;
            throw new Error(msg || '服务端错误（HTTP ' + resp.status + '）');
          }
          return data;
        });
      })
      .then(function (data) {
        // 用户语音条下补识别文字
        if (audioBlob) {
          appendTranscript(userRow, data.user_text || '（未识别到内容）');
        }
        if (!data.user_text && !data.reply_text) {
          throw new Error('没有识别到有效内容');
        }

        if (data.audio) {
          var bin = atob(data.audio);
          var bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          var wavBlob = new Blob([bytes], { type: 'audio/wav' });
          // 16kHz 单声道 16bit = 32000 字节/秒
          addVoiceRow('bot', trackUrl(URL.createObjectURL(wavBlob)), wavBlob.size / 32000, data.reply_text, data.reply_text.length);
        } else {
          addTextRow('bot', data.reply_text || '（空回复）');
          if (data.tts_engine === 'none') {
            addSysline('语音合成暂不可用，本次为文字回复');
          }
        }
        if (!data.llm_configured && !llmHintShown) {
          llmHintShown = true;
          addSysline('当前为本地演示回复 · 配置 LLM_KEY 后接入真实大模型');
        }

        history.push({ role: 'user', content: data.user_text });
        history.push({ role: 'assistant', content: data.reply_text });
        history = history.slice(-12);
        checkHealth();
      })
      .catch(function (err) {
        if (err.name === 'AbortError') {
          toast('请求超时，请重试', true);
        } else if (err instanceof TypeError) {
          toast('网络错误：无法连接后端', true);
        } else {
          toast(err.message || '发送失败', true);
        }
        addSysline('这条消息处理失败：' + (err.message || '未知错误'));
      })
      .then(function () {
        clearTimeout(timeoutId);
        removeTyping();
        busy = false;
        updateActionBtn();
        // 不释放 blob 地址：语音条要支持整个会话期间反复回听
      });
  }

  actionBtn.addEventListener('click', function () {
    if (recording) {
      stopRecording();
      return;
    }
    var text = (textInput.value || '').trim();
    if (text) {
      sendChat(null, 0);
      return;
    }
    if (busy) { toast('上一条还在处理中'); return; }
    ensureMic(function (err, stream) {
      if (err) { toast(micErrorMessage(err), true); return; }
      startRecording(stream);
    });
  });

  textInput.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
      ev.preventDefault();
      sendChat(null, 0);
    }
  });

  // 输入框自适应高度 + 按钮状态
  function autoGrow() {
    textInput.style.height = 'auto';
    textInput.style.height = Math.min(textInput.scrollHeight, 120) + 'px';
    updateActionBtn();
  }
  textInput.addEventListener('input', autoGrow);

  // 欢迎页快捷提问
  document.addEventListener('click', function (ev) {
    var chip = ev.target.closest ? ev.target.closest('.chip') : null;
    if (chip && !busy) {
      textInput.value = chip.getAttribute('data-text') || '';
      if (textInput.value.trim()) sendChat(null, 0);
    }
  });

  // 页面卸载清理
  window.addEventListener('beforeunload', function () {
    if (recording) { try { recorder.stop(); } catch (e) { /* ignore */ } }
    if (audioStream) audioStream.getTracks().forEach(function (t) { t.stop(); });
    liveUrls.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
  });

  updateActionBtn();
  checkHealth();
})();
