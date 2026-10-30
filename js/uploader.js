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

  async function uniqueName(base) {
    const all = await Store.photos.all();
    const names = new Set(all.map((p) => p.name));
    let name = base + '.jpg';
    for (let i = 2; names.has(name); i++) name = `${base}_${i}.jpg`;
    return name;
  }

  async function add(blob, folder) {
    const settings = Store.getSettings();
    const img = await loadImage(blob);
    const thumb = drawScaled(img, 320).toDataURL('image/jpeg', 0.75);
    let data = blob;
    if (!settings.original) {
      data = await canvasToBlob(drawScaled(img, 1920), 0.88);
    }
    if (img.close) img.close();
    const now = new Date();
    const photo = {
      id: Store.uid(),
      name: await uniqueName(fileName(now)),
      folderId: folder.id,
      folderName: folder.name,
      blob: data,
      size: data.size,
      thumb,
      status: 'waiting',
      attempts: 0,
      error: null,
      createdAt: now.getTime(),
      doneAt: null
    };
    await Store.photos.put(photo);
    emit('change');
    kick();
    return photo;
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

  async function nextWaiting() {
    const all = await Store.photos.all();
    const waiting = all.filter((p) => p.status === 'waiting');
    return waiting.length ? waiting[waiting.length - 1] : null; // 오래된 것부터
  }

  async function uploadOne(photo) {
    await Store.photos.update(photo.id, { status: 'uploading' });
    progress.set(photo.id, 0);
    emit('change');

    const folders = Store.getFolders();
    const folder = folders.find((f) => f.id === photo.folderId) || { id: photo.folderId, name: photo.folderName, driveId: null };
    const driveId = await Drive.ensureFolder(folder);
    if (folder.driveId !== driveId) {
      const idx = folders.findIndex((f) => f.id === folder.id);
      if (idx >= 0) { folders[idx].driveId = driveId; Store.setFolders(folders); }
    }

    let last = 0;
    const file = await Drive.upload(photo.blob, photo.name, driveId, (ratio) => {
      progress.set(photo.id, ratio);
      if (Date.now() - last > 150) { last = Date.now(); emit('progress', { id: photo.id, ratio }); }
    });

    progress.delete(photo.id);
    // 올라간 사진은 원본을 지워 휴대폰 저장 공간을 아낀다 (썸네일만 남김)
    await Store.photos.update(photo.id, { status: 'done', blob: null, doneAt: Date.now(), driveFileId: file.id, webViewLink: file.webViewLink || null, error: null });

    const fs = Store.getFolders();
    const i = fs.findIndex((f) => f.id === photo.folderId);
    if (i >= 0) { fs[i].count = (fs[i].count || 0) + 1; fs[i].lastAt = Date.now(); Store.setFolders(fs); }
    emit('uploaded', { id: photo.id, folderName: photo.folderName });
  }

  async function kick() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const photo = await nextWaiting();
        if (!photo) { setHold(null); break; }
        const reason = holdReason();
        setHold(reason);
        if (reason) break;
        try {
          await uploadOne(photo);
        } catch (err) {
          progress.delete(photo.id);
          if (err instanceof Drive.AuthError) {
            await Store.photos.update(photo.id, { status: 'waiting' });
            setHold('auth');
            break;
          }
          if (err.network || !navigator.onLine) {
            await Store.photos.update(photo.id, { status: 'waiting' });
            setHold('offline');
            setTimeout(kick, 15000);
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
    } finally {
      running = false;
      emit('change');
    }
    prune();
  }

  async function prune() {
    const all = await Store.photos.all();
    const done = all.filter((p) => p.status === 'done');
    for (const p of done.slice(KEEP_DONE)) await Store.photos.remove(p.id);
  }

  async function retry(id) {
    await Store.photos.update(id, { status: 'waiting', attempts: 0, error: null });
    emit('change');
    kick();
  }

  async function retryAll() {
    const all = await Store.photos.all();
    for (const p of all.filter((x) => x.status === 'failed')) {
      await Store.photos.update(p.id, { status: 'waiting', attempts: 0, error: null });
    }
    emit('change');
    kick();
  }

  async function init() {
    // 앱이 업로드 도중 닫혔던 사진은 다시 대기 상태로
    const all = await Store.photos.all();
    for (const p of all.filter((x) => x.status === 'uploading')) {
      await Store.photos.update(p.id, { status: 'waiting' });
    }
    window.addEventListener('online', kick);
    if (navigator.connection && navigator.connection.addEventListener) {
      navigator.connection.addEventListener('change', kick);
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
    setInterval(kick, 30000);
    kick();
  }

  window.Uploader = {
    init, add, kick, retry, retryAll,
    on: (fn) => listeners.add(fn),
    progressOf: (id) => progress.get(id),
    hold: () => hold
  };
})();
