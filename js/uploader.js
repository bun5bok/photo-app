// 업로드 대기열: 찍은 사진을 먼저 휴대폰(IndexedDB)에 저장하고, 조건이 되면 순서대로 드라이브에 올린다
(function () {
  const MAX_ATTEMPTS = 3;
  const KEEP_DONE = 300; // 완료 기록은 최근 것만 남긴다
  const listeners = new Set();
  const progress = new Map(); // id -> 0..1 (화면 표시용, DB에는 쓰지 않음)
  let running = false;
  let hold = null; // null | 'offline' | 'cellular' | 'auth'

  function emit(type, detail) {
    listeners.forEach((fn) => fn(type, detail));
  }

  function loadImage(blob) {
    if (window.createImageBitmap) {
      return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(blob);
    });
  }

  function drawScaled(img, maxSide) {
    const w = img.width, h = img.height;
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  function canvasToBlob(canvas, quality) {
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  }

  function fileName(date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  }

  async function uniqueName(base, ext) {
    const all = await Store.photos.all();
    const names = new Set(all.map((p) => p.name));
    let name = `${base}.${ext}`;
    for (let i = 2; names.has(name); i++) name = `${base}_${i}.${ext}`;
    return name;
  }

  function videoExt(type) {
    return /mp4/.test(type) ? 'mp4' : /quicktime/.test(type) ? 'mov' : 'webm';
  }

  // 동영상은 크기를 줄이지 않고 그대로 올린다. 미리보기는 촬영 화면이 만든 thumb를 쓴다
  // opts: { thumb, duration, startedAt, takenAt, source }
  //  - startedAt: 녹화 시작 시각 (목록 순서와 파일 이름에 씀)
  //  - takenAt: 앨범에서 고른 파일이 실제로 찍힌 시각 (파일 이름과 드라이브 수정일에만 쓰고, 목록 순서는 가져온 시각)
  async function add(blob, folder, opts) {
    opts = opts || {};
    const settings = Store.getSettings();
    const isVideo = /^video\//.test(blob.type);
    let thumb = opts.thumb || '';
    let data = blob;
    if (!isVideo) {
      try {
        const img = await loadImage(blob);
        thumb = drawScaled(img, 320).toDataURL('image/jpeg', 0.75);
        if (!settings.original) data = await canvasToBlob(drawScaled(img, 1920), 0.88);
        if (img.close) img.close();
      } catch (e) {
        // 브라우저가 열 수 없는 형식(일부 HEIC 등)은 미리보기 없이 원본 그대로 올린다
        thumb = '';
        data = blob;
      }
    }
    const photoExt = data.type === 'image/png' ? 'png' : /heic|heif/.test(data.type) ? 'heic' : 'jpg';
    const now = opts.startedAt ? new Date(opts.startedAt) : new Date();
    const taken = opts.takenAt ? new Date(opts.takenAt) : now;
    const photo = {
      id: Store.uid(),
      kind: isVideo ? 'video' : 'photo',
      source: opts.source || 'camera',
      sourceKey: opts.sourceKey || null,
      takenAt: taken.getTime(),
      name: await uniqueName(fileName(taken), isVideo ? videoExt(blob.type) : photoExt),
      folderId: folder.id,
      folderName: folder.name,
      blob: data,
      size: data.size,
      duration: opts.duration || null,
      thumb,
      status: 'waiting',
      attempts: 0,
      error: null,
      uploadUrl: null,
      createdAt: now.getTime(),
      doneAt: null
    };
    await Store.photos.put(photo);
    emit('change');
    kick();
    return photo;
  }

  // ---------- 대기열 엔진 ----------
  // 아이폰은 화면이 꺼지거나 다른 앱으로 가면 앱을 얼리고 연결을 끊는다.
  // 그래서 (1) 멈춘 업로드를 감시해 다시 시작하고 (2) 실패하면 간격을 늘려 가며 다시 시도하고
  // (3) 앱이 깨어나면 바로 확인한다
  const STALL_MS = 60000; // 이만큼 아무 진척이 없으면 멈춘 것으로 본다
  const BACKOFF = [5, 15, 30, 60, 120, 300]; // 연결 실패 뒤 다시 시도할 간격(초)
  let gen = 0;             // 업로드 작업 번호: 다시 시작하면 늘려서 이전 작업을 버린다
  let lastBeat = 0;        // 마지막으로 진척이 있었던 시각
  let backoffIdx = 0;
  let nextRetryAt = null;
  let retryTimer = null;
  let netFailed = false;   // 직전 실패가 연결 문제였는지
  let currentId = null;

  function beat() {
    lastBeat = Date.now();
  }

  function onCellular() {
    const c = navigator.connection;
    return !!c && c.type === 'cellular';
  }

  function holdReason() {
    if (!navigator.onLine) return 'offline';
    if (!Store.getSettings().useData && onCellular()) return 'cellular';
    if (!Drive.hasToken()) return 'auth';
    return null;
  }

  function setHold(next) {
    if (hold !== next) {
      hold = next;
      emit('hold', hold);
    }
  }

  function scheduleRetry() {
    const delay = BACKOFF[Math.min(backoffIdx, BACKOFF.length - 1)];
    backoffIdx++;
    nextRetryAt = Date.now() + delay * 1000;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => kick(), delay * 1000);
    emit('hold', hold);
  }

  function resetBackoff() {
    backoffIdx = 0;
    nextRetryAt = null;
    clearTimeout(retryTimer);
  }

  async function nextWaiting() {
    const all = await Store.photos.all();
    const waiting = all.filter((p) => p.status === 'waiting');
    if (!waiting.length) return null;
    // [다시 시도]를 누른 사진을 먼저, 그다음 오래된 것부터
    waiting.sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.createdAt - b.createdAt);
    return waiting[0];
  }

  async function uploadOne(photo, my) {
    if (!(await Store.photos.update(photo.id, { status: 'uploading' }))) return; // 그사이 지워짐
    currentId = photo.id;
    progress.set(photo.id, 0);
    emit('change');
    beat();

    const folders = Store.getFolders();
    const folder = folders.find((f) => f.id === photo.folderId) || { id: photo.folderId, name: photo.folderName, driveId: null };
    const driveId = await Drive.ensureFolder(folder);
    beat();
    if (folder.driveId !== driveId) {
      const idx = folders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) { folders[idx].driveId = driveId; Store.setFolders(folders); }
    }

    let last = 0;
    // 드라이브의 '수정한 날짜'를 찍은 시각으로 맞춰 두면 드라이브와 폴더 화면에서 찍은 순서대로 정렬된다
    const meta = { name: photo.name, modifiedTime: new Date(photo.takenAt || photo.createdAt).toISOString() };
    const file = await Drive.upload(photo.blob, meta, driveId, (ratio) => {
      beat();
      progress.set(photo.id, ratio);
      if (Date.now() - last > 150) { last = Date.now(); emit('progress', { id: photo.id, ratio }); }
    }, photo.uploadUrl, (url) => Store.photos.update(photo.id, { uploadUrl: url }));
    beat();
    progress.delete(photo.id);
    if (my !== gen) return; // 그사이 다시 시작됨: 새 작업이 이어서 처리한다

    // 올리는 동안 사용자가 지웠거나 다른 폴더로 옮겼으면 드라이브에도 그대로 반영한다
    const current = await Store.photos.get(photo.id);
    if (!current) {
      await Drive.trash(file.id).catch(() => {});
      emit('change');
      return;
    }
    if (current.folderId !== photo.folderId) {
      const fs0 = Store.getFolders();
      const target = fs0.find((f) => f.id === current.folderId);
      if (target) {
        const targetDriveId = await Drive.ensureFolder(target);
        if (target.driveId !== targetDriveId) { target.driveId = targetDriveId; Store.setFolders(fs0); }
        await Drive.move(file.id, driveId, targetDriveId);
      }
    }

    // 올라간 사진은 원본을 지워 휴대폰 저장 공간을 아낀다 (썸네일만 남김)
    await Store.photos.update(photo.id, { status: 'done', blob: null, uploadUrl: null, priority: 0, doneAt: Date.now(), driveFileId: file.id, webViewLink: file.webViewLink || null, error: null });

    const fs = Store.getFolders();
    const i = fs.findIndex((f) => f.id === current.folderId);
    if (i >= 0) { fs[i].count = (fs[i].count || 0) + 1; fs[i].lastAt = Date.now(); Store.setFolders(fs); }
    emit('uploaded', { id: photo.id, folderName: photo.folderName });
  }

  // 멈춘 작업을 버리고 진행 중인 요청을 끊는다 (보관함 연결도 새로 연다)
  function resetLoop() {
    gen++;
    running = false;
    currentId = null;
    progress.clear();
    Drive.abortAll();
    Store.photos.reset();
  }

  // force: 기다리는 간격을 무시하고 바로 시도 (앱이 깨어났을 때, [지금 올리기])
  async function kick(force) {
    if (running) {
      if (Date.now() - lastBeat < STALL_MS) return;
      // 오래 진척이 없다: 멈춘 작업을 버리고 새로 시작한다
      resetLoop();
      emit('stalled');
    }
    if (!force && nextRetryAt && Date.now() < nextRetryAt) return;
    running = true;
    const my = ++gen;
    beat();
    try {
      // 이전 작업이 '올리는 중'으로 남겨 둔 사진은 다시 대기로 (이어서 올라간다)
      const all = await Store.photos.all();
      if (my !== gen) return;
      for (const p of all.filter((x) => x.status === 'uploading')) await Store.photos.update(p.id, { status: 'waiting' });
      for (;;) {
        beat();
        const photo = await nextWaiting();
        if (my !== gen) return;
        if (!photo) { setHold(null); resetBackoff(); netFailed = false; break; }
        const reason = holdReason();
        if (reason) { setHold(reason); break; }
        // 직전에 연결이 끊겼다면 실제로 구글에 닿는지 먼저 확인한다
        if (netFailed && !(await Drive.reachable())) {
          if (my !== gen) return;
          setHold('offline');
          scheduleRetry();
          break;
        }
        setHold(null);
        try {
          await uploadOne(photo, my);
          if (my !== gen) return;
          netFailed = false;
          resetBackoff();
        } catch (err) {
          if (my !== gen) return; // 다시 시작돼 끊긴 요청: 새 작업이 처리한다
          progress.delete(photo.id);
          if (err instanceof Drive.AuthError) {
            await Store.photos.update(photo.id, { status: 'waiting' });
            setHold('auth');
            break;
          }
          if (err.restart) {
            await Store.photos.update(photo.id, { status: 'waiting', uploadUrl: null });
            continue;
          }
          if (err.network || err.dbTimeout || !navigator.onLine) {
            await Store.photos.update(photo.id, { status: 'waiting' }).catch(() => {});
            netFailed = true;
            setHold('offline');
            scheduleRetry();
            break;
          }
          const attempts = (photo.attempts || 0) + 1;
          const failed = attempts >= MAX_ATTEMPTS;
          await Store.photos.update(photo.id, { status: failed ? 'failed' : 'waiting', attempts, error: err.message });
          if (failed) emit('failed', { id: photo.id, message: err.message });
          else await new Promise((r) => setTimeout(r, 2000 * attempts));
        }
        emit('change');
      }
    } catch (e) {
      // 보관함 오류 등: 잠시 뒤 다시 시도
      if (my === gen) { netFailed = true; setHold('offline'); scheduleRetry(); }
    } finally {
      if (my === gen) { running = false; currentId = null; }
      emit('change');
    }
    if (my === gen) prune().catch(() => {});
  }

  async function prune() {
    const all = await Store.photos.all();
    const done = all.filter((p) => p.status === 'done');
    for (const p of done.slice(KEEP_DONE)) await Store.photos.remove(p.id);
  }

  // [지금 올리기]: 기다리지 않고, 멈춰 있으면 새로 시작해서 바로 올린다
  function retryNow() {
    resetBackoff();
    if (running) resetLoop();
    kick(true);
  }

  async function retry(id) {
    await Store.photos.update(id, { status: 'waiting', attempts: 0, error: null, priority: Date.now() });
    emit('change');
    retryNow();
  }

  async function retryAll() {
    const all = await Store.photos.all();
    for (const p of all.filter((x) => x.status === 'failed')) {
      await Store.photos.update(p.id, { status: 'waiting', attempts: 0, error: null });
    }
    emit('change');
    retryNow();
  }

  // 앱이 다시 보이거나, 인터넷이 돌아오거나, 화면이 켜졌을 때
  function wake() {
    if (document.hidden) return;
    kick(true);
  }

  async function init() {
    window.addEventListener('online', () => { resetBackoff(); wake(); });
    window.addEventListener('pageshow', wake);
    window.addEventListener('focus', wake);
    if (navigator.connection && navigator.connection.addEventListener) {
      navigator.connection.addEventListener('change', wake);
    }
    document.addEventListener('visibilitychange', wake);
    // 감시: 10초마다 멈춘 작업이 있는지, 다시 시도할 때가 됐는지 확인
    setInterval(() => kick(), 10000);
    kick(true);
  }

  window.Uploader = {
    init, add, kick, retry, retryAll, retryNow,
    on: (fn) => listeners.add(fn),
    progressOf: (id) => progress.get(id),
    hold: () => hold,
    // 화면 표시용 상태
    state: () => ({ hold, nextRetryAt, running, currentId, stalledFor: running ? Date.now() - lastBeat : 0 })
  };
})();
