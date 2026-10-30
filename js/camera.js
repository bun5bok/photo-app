// 앱 안 카메라: 후면 카메라 미리보기, 촬영, 전환, 플래시(지원 기기만)
(function () {
  let stream = null;
  let facing = 'environment';
  let torchOn = false;
  let video = null;

  function track() {
    return stream ? stream.getVideoTracks()[0] : null;
  }

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  }

  async function open(videoEl) {
    video = videoEl;
    stop();
    if (!supported()) {
      throw new Error(window.isSecureContext ? '이 브라우저는 앱 안 카메라를 지원하지 않아요.' : '카메라는 https 주소에서만 쓸 수 있어요.');
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facing }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
    } catch (err) {
      if (err.name === 'NotAllowedError') throw new Error('카메라 권한이 꺼져 있어요. 브라우저 설정에서 카메라를 허용해 주세요.');
      if (err.name === 'NotFoundError') throw new Error('사용할 수 있는 카메라가 없어요.');
      throw new Error('카메라를 열 수 없어요.');
    }
    video.srcObject = stream;
    await video.play().catch(() => {});
    torchOn = false;
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

  async function capture() {
    const t = track();
    if (!t) throw new Error('카메라가 준비되지 않았어요.');
    // 안드로이드 크롬은 ImageCapture로 센서 최대 해상도 사진을 얻을 수 있다
    if (window.ImageCapture && facing === 'environment') {
      try {
        const ic = new ImageCapture(t);
        const blob = await ic.takePhoto(torchOn ? { fillLightMode: 'flash' } : undefined);
        if (blob && blob.size) return blob;
      } catch (e) { /* 아래 방식으로 대체 */ }
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0);
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
  }

  function stop() {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    if (video) video.srcObject = null;
  }

  window.Camera = { open, capture, flip, stop, hasTorch, toggleTorch, facing: () => facing };
})();
