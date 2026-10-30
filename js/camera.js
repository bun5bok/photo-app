// 앱 안 카메라: 미리보기, 사진 촬영, 동영상 녹화, 줌, 전환, 플래시(지원 기기만)
(function () {
  let stream = null;
  let facing = 'environment';
  let mode = 'photo'; // 'photo' | 'video'
  let torchOn = false;
  let video = null;
  let zoom = 1;
  let hwZoom = null; // { min, max, step } — 기기 카메라가 줌을 지원할 때
  let recorder = null;
  let recording = null; // { chunks, startedAt, thumb, resolve, reject }

  const DIGITAL_MAX = 4;

  function track() {
    return stream ? stream.getVideoTracks()[0] : null;
  }

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  function constraints(withAudio) {
    // 동영상은 용량 때문에 1080p, 사진은 가능한 최대 해상도
    const size = mode === 'video'
      ? { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
      : { width: { ideal: 3840 }, height: { ideal: 2160 } };
    return { audio: withAudio, video: Object.assign({ facingMode: { ideal: facing } }, size) };
  }

  async function getStream() {
    if (mode !== 'video') return navigator.mediaDevices.getUserMedia(constraints(false));
    try {
      return await navigator.mediaDevices.getUserMedia(constraints(true));
    } catch (err) {
      // 마이크를 거부해도 소리 없이 녹화는 할 수 있게 한다
      if (err.name === 'NotAllowedError' || err.name === 'NotFoundError') {
        const s = await navigator.mediaDevices.getUserMedia(constraints(false));
        s.noAudio = true;
        return s;
      }
      throw err;
    }
  }

  async function open(videoEl, nextMode) {
    video = videoEl;
    if (nextMode) mode = nextMode;
    stop();
    if (!supported()) {
      throw new Error(window.isSecureContext ? '이 브라우저는 앱 안 카메라를 지원하지 않아요.' : '카메라는 https 주소에서만 쓸 수 있어요.');
    }
    try {
      stream = await getStream();
    } catch (err) {
      if (err.name === 'NotAllowedError') throw new Error('카메라 권한이 꺼져 있어요. 브라우저 설정에서 카메라를 허용해 주세요.');
      if (err.name === 'NotFoundError') throw new Error('사용할 수 있는 카메라가 없어요.');
      throw new Error('카메라를 열 수 없어요.');
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    torchOn = false;
    const t = track();
    const caps = t && t.getCapabilities ? t.getCapabilities() : {};
    hwZoom = caps.zoom && caps.zoom.max > caps.zoom.min ? caps.zoom : null;
    zoom = 1;
    applyPreview();
    if (hwZoom) await setZoom(Math.max(1, hwZoom.min));
  }

  function hasAudio() {
    return !!stream && !stream.noAudio;
  }

  function hasTorch() {
    const t = track();
    if (!t || !t.getCapabilities) return false;
    return !!t.getCapabilities().torch;
  }

  async function toggleTorch() {
    const t = track();
    if (!t) return false;
    torchOn = !torchOn;
    try {
      await t.applyConstraints({ advanced: [{ torch: torchOn }] });
    } catch (e) {
      torchOn = false;
    }
    return torchOn;
  }

  async function flip() {
    facing = facing === 'environment' ? 'user' : 'environment';
    await open(video);
  }

  // ---------- 줌 ----------
  // 기기 줌을 지원하면 실제 광학/센서 줌, 아니면 화면을 잘라 확대하는 디지털 줌.
  // 디지털 줌은 녹화 중인 동영상에는 담기지 않아서 동영상 모드에서는 쓰지 않는다
  function zoomRange() {
    if (hwZoom) return { min: Math.max(1, hwZoom.min), max: Math.min(hwZoom.max, 10), hardware: true };
    if (mode === 'video') return { min: 1, max: 1, hardware: false };
    return { min: 1, max: DIGITAL_MAX, hardware: false };
  }

  function applyPreview() {
    if (!video) return;
    const mirror = facing === 'user' ? ' scaleX(-1)' : '';
    const scale = hwZoom ? 1 : zoom;
    video.style.transform = `scale(${scale})${mirror}`;
  }

  async function setZoom(z) {
    const r = zoomRange();
    zoom = Math.min(r.max, Math.max(r.min, z));
    if (hwZoom) {
      const step = hwZoom.step || 0.1;
      const value = Math.round(zoom / step) * step;
      try { await track().applyConstraints({ advanced: [{ zoom: value }] }); } catch (e) { /* 일부 기기는 무시 */ }
    }
    applyPreview();
    return zoom;
  }

  function getZoom() {
    return zoom;
  }

  // ---------- 사진 ----------
  async function capture() {
    const t = track();
    if (!t) throw new Error('카메라가 준비되지 않았어요.');
    const digital = !hwZoom && zoom > 1;
    // 안드로이드 크롬은 ImageCapture로 센서 최대 해상도 사진을 얻을 수 있다
    if (window.ImageCapture && facing === 'environment' && !digital) {
      try {
        const ic = new ImageCapture(t);
        const blob = await ic.takePhoto(torchOn ? { fillLightMode: 'flash' } : undefined);
        if (blob && blob.size) return blob;
      } catch (e) { /* 아래 방식으로 대체 */ }
    }
    const vw = video.videoWidth, vh = video.videoHeight;
    const z = digital ? zoom : 1;
    const sw = vw / z, sh = vh / z;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    const ctx = canvas.getContext('2d');
    if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  }

  // ---------- 동영상 ----------
  function pickMime() {
    const list = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    if (!window.MediaRecorder) return null;
    return list.find((m) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) || '';
  }

  function canRecord() {
    return !!window.MediaRecorder && pickMime() !== null;
  }

  function frameThumb() {
    if (!video || !video.videoWidth) return '';
    const scale = 320 / Math.max(video.videoWidth, video.videoHeight);
    const c = document.createElement('canvas');
    c.width = Math.round(video.videoWidth * scale);
    c.height = Math.round(video.videoHeight * scale);
    const ctx = c.getContext('2d');
    if (facing === 'user') { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.75);
  }

  // 녹화를 시작하고, 끝나면 { blob, duration, thumb, startedAt }를 돌려주는 Promise를 반환한다
  function startRecording() {
    if (!stream) return Promise.reject(new Error('카메라가 준비되지 않았어요.'));
    if (!canRecord()) return Promise.reject(new Error('이 브라우저는 동영상 녹화를 지원하지 않아요. 휴대폰 카메라 앱으로 찍어 주세요.'));
    const mime = pickMime();
    const opts = { videoBitsPerSecond: 2500000, audioBitsPerSecond: 128000 };
    if (mime) opts.mimeType = mime;
    recorder = new MediaRecorder(stream, opts);
    return new Promise((resolve, reject) => {
      recording = { chunks: [], startedAt: Date.now(), thumb: frameThumb() };
      recorder.ondataavailable = (e) => { if (e.data && e.data.size) recording.chunks.push(e.data); };
      recorder.onerror = (e) => { reject(e.error || new Error('녹화 중 오류가 났어요.')); };
      recorder.onstop = () => {
        const r = recording;
        recording = null;
        const type = (recorder.mimeType || mime || 'video/webm').split(';')[0];
        recorder = null;
        if (!r || !r.chunks.length) return reject(new Error('녹화된 내용이 없어요.'));
        resolve({ blob: new Blob(r.chunks, { type }), duration: Math.round((Date.now() - r.startedAt) / 1000), thumb: r.thumb, startedAt: r.startedAt });
      };
      recorder.start(1000);
    });
  }

  function stopRecording() {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  function isRecording() {
    return !!recorder && recorder.state === 'recording';
  }

  function elapsed() {
    return recording ? Math.floor((Date.now() - recording.startedAt) / 1000) : 0;
  }

  function stop() {
    if (isRecording()) stopRecording();
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  window.Camera = {
    open, capture, flip, stop, hasTorch, toggleTorch, hasAudio,
    zoomRange, setZoom, getZoom,
    canRecord, startRecording, stopRecording, isRecording, elapsed,
    facing: () => facing,
    mode: () => mode
  };
})();
