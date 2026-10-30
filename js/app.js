// 화면 연결: 탭 전환, 폴더 관리, 목록 그리기, 카메라 화면
(function () {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const FOLDER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
  const CHECK_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1E7B4A" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="완료"><path d="M5 12l5 5 9-10"/></svg>';

  let tab = 'home';
  let photos = [];
  let shotsThisSession = 0;
  let toastTimer = null;
  let camToastTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  function relTime(ts) {
    if (!ts) return '아직 없음';
    const diff = Date.now() - ts;
    if (diff < 60000) return '방금 전';
    if (diff < 3600000) return Math.floor(diff / 60000) + '분 전';
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return Math.floor(diff / 3600000) + '시간 전';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '어제';
    return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }

  function isToday(ts) {
    return ts && new Date(ts).toDateString() === new Date().toDateString();
  }

  // ---------- 폴더 ----------
  function folders() {
    return Store.getFolders();
  }

  function currentFolder() {
    const id = Store.getCurrent();
    return folders().find((f) => f.id === id) || null;
  }

  function pickFolder(id) {
    Store.setCurrent(id);
    render();
  }

  async function createFolder(name) {
    name = name.trim().replace(/[\\/]/g, '·');
    if (!name) return;
    const list = folders();
    const dup = list.find((f) => f.name === name);
    if (dup) {
      pickFolder(dup.id);
      toast('이미 있는 폴더라 저장 위치로 지정했어요');
      return;
    }
    const folder = { id: Store.uid(), name, driveId: null, count: 0, lastAt: null };
    list.push(folder);
    Store.setFolders(list);
    Store.setCurrent(folder.id);
    render();
    toast(`‘${name}’ 폴더를 만들었어요`);
    // 연결돼 있으면 드라이브에도 바로 만든다 (아니면 첫 업로드 때 만든다)
    if (Drive.hasToken()) {
      try {
        const driveId = await Drive.ensureFolder(folder);
        const fs = folders();
        const i = fs.findIndex((f) => f.id === folder.id);
        if (i >= 0) { fs[i].driveId = driveId; Store.setFolders(fs); render(); }
      } catch (e) { /* 업로드 때 다시 시도 */ }
    }
  }

  // 드라이브에 있는 사진촬영 폴더를 가져와 목록에 합친다
  async function syncFolders() {
    if (!Drive.hasToken()) return;
    try {
      const remote = await Drive.listFolders();
      const list = folders();
      remote.forEach((r) => {
        const byId = list.find((f) => f.driveId === r.id);
        if (byId) { byId.name = r.name; return; }
        const byName = list.find((f) => !f.driveId && f.name === r.name);
        if (byName) { byName.driveId = r.id; return; }
        list.push({ id: Store.uid(), name: r.name, driveId: r.id, count: 0, lastAt: null });
      });
      Store.setFolders(list);
      if (!currentFolder() && list.length) Store.setCurrent(list[0].id);
      render();
    } catch (e) {
      if (!(e instanceof Drive.AuthError)) console.warn(e);
    }
  }

  // ---------- 연결 ----------
  async function connect(btn) {
    if (btn) btn.disabled = true;
    try {
      await Drive.connect();
      let info = null;
      try {
        info = await Drive.userInfo();
      } catch (e) {
        // 기관 계정 제한이 있으면 계정을 확인할 수 없을 때 연결하지 않는다
        if (Drive.allowedDomain()) { await Drive.disconnect(); throw new Error('계정 정보를 확인하지 못했어요. 다시 시도해 주세요.'); }
      }
      if (info && !Drive.isAllowedAccount(info)) {
        await Drive.disconnect();
        throw new Error(`기관 계정(@${Drive.allowedDomain()})으로만 사용할 수 있어요.`);
      }
      if (info) Store.setAccount({ email: info.email, name: info.name, picture: info.picture });
      await Drive.ensureRoot();
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      showApp();
      await syncFolders();
      Uploader.kick();
    } catch (e) {
      toast(e.message || '연결하지 못했어요');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function disconnect() {
    const pending = photos.filter((p) => p.status !== 'done').length;
    const msg = pending
      ? `아직 올라가지 않은 사진이 ${pending}장 있어요. 연결을 해제해도 사진은 휴대폰에 남고, 다시 연결하면 올라갑니다. 해제할까요?`
      : '구글 드라이브 연결을 해제할까요? 드라이브에 올라간 사진은 그대로 남아요.';
    if (!confirm(msg)) return;
    await Drive.disconnect();
    Drive.forgetVerified();
    Store.setAccount(null);
    Store.setRoot(null);
    showConnect();
  }

  function showConnect() {
    $('#app').hidden = true;
    $('#connect').hidden = false;
    const ok = Drive.isConfigured();
    $('#setup-warning').hidden = ok;
    $('#btn-connect').disabled = !ok;
    const domain = Drive.allowedDomain();
    if (domain) $('#step1-hint').textContent = `기관 계정(@${domain})으로 한 번만 하면 됩니다`;
  }

  function showApp() {
    $('#connect').hidden = true;
    $('#app').hidden = false;
    render();
  }

  // ---------- 탭 ----------
  function setTab(next) {
    tab = next;
    $$('.tab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    ['home', 'folders', 'upload', 'settings'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
    window.scrollTo(0, 0);
  }

  // ---------- 그리기 ----------
  function render() {
    renderHome();
    renderFolderList();
    renderUploads();
    renderSettings();
    renderChips();
  }

  function stats() {
    const active = photos.filter((p) => p.status === 'waiting' || p.status === 'uploading');
    const failed = photos.filter((p) => p.status === 'failed');
    const doneToday = photos.filter((p) => p.status === 'done' && isToday(p.doneAt));
    return { active, failed, doneToday };
  }

  function overallProgress(active) {
    if (!active.length) return 0;
    const uploading = active.find((p) => p.status === 'uploading');
    const r = uploading ? (Uploader.progressOf(uploading.id) || 0) : 0;
    return Math.round((r / active.length) * 100);
  }

  function holdText(reason) {
    return {
      offline: '인터넷이 연결되면 자동으로 올려요',
      cellular: 'Wi-Fi에 연결되면 올려요 (설정에서 모바일 데이터 업로드를 켤 수 있어요)',
      auth: '드라이브 연결이 만료됐어요. 위의 ‘다시 연결’을 눌러 주세요'
    }[reason] || '';
  }

  function renderHome() {
    const d = new Date();
    $('#today').textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${'일월화수목금토'[d.getDay()]}요일`;

    const cur = currentFolder();
    const root = Store.getRoot();
    $('#target-name').textContent = cur ? cur.name : '폴더를 선택하세요';
    $('#target-path').textContent = cur ? `내 드라이브 › ${root ? root.name : Drive.rootName()} › ${cur.name}` : '';

    const { active, doneToday } = stats();
    const hold = Uploader.hold();
    $('#home-progress-title').textContent = active.length ? `${active.length}장 ${hold ? '대기 중' : '업로드 중'}` : '대기 중인 사진 없음';
    $('#home-progress-sub').textContent = `오늘 ${doneToday.length}장 완료`;
    $('#home-progress-bar').style.width = (active.length ? Math.max(overallProgress(active), 4) : (doneToday.length ? 100 : 0)) + '%';

    const pill = $('#conn-pill');
    const connected = Drive.hasToken();
    pill.className = 'pill ' + (connected ? 'pill-ok' : 'pill-warn');
    $('#conn-text').textContent = connected ? '드라이브 연결됨' : (navigator.onLine ? '연결 필요' : '오프라인');

    const recent = photos.slice(0, 4);
    $('#recent-grid').innerHTML = recent.length
      ? recent.map((p) => `<button class="thumb" type="button" data-photo="${esc(p.id)}" aria-label="${esc(p.name)} 보기"><img src="${p.thumb}" alt=""></button>`).join('')
      : '<p class="recent-empty">찍은 사진이 여기에 보여요</p>';

    // 현재 저장 위치를 맨 앞에, 나머지는 최근에 쓴 순서로 3개까지
    const others = folders().filter((f) => !cur || f.id !== cur.id).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const list = (cur ? [cur] : []).concat(others).slice(0, 3);
    $('#home-folders').innerHTML = list.map((f) => `
      <button class="folder-card" type="button" data-folder="${esc(f.id)}" aria-pressed="${cur && cur.id === f.id}">
        ${FOLDER_SVG}<strong>${esc(f.name)}</strong><span class="small muted">${f.count || 0}장</span>
      </button>`).join('') + `
      <button class="folder-card add" type="button" data-action="new-folder">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>새 폴더
      </button>`;
  }

  function renderFolderList() {
    const term = $('#folder-search').value.trim();
    const cur = currentFolder();
    const list = folders().filter((f) => !term || f.name.includes(term));
    $('#folder-list').innerHTML = list.length ? list.map((f) => {
      const on = cur && cur.id === f.id;
      return `<li><button class="folder-row" type="button" data-folder="${esc(f.id)}" aria-pressed="${!!on}">
        <span class="folder-icon">${FOLDER_SVG}</span>
        <span class="grow min0"><strong>${esc(f.name)}</strong><span class="small muted">${f.count || 0}장 · ${relTime(f.lastAt)}${f.driveId ? '' : ' · <span class="chip-sync">드라이브에 아직 없음</span>'}</span></span>
        ${on ? '<span class="chip-selected">저장 위치</span>' : ''}
      </button></li>`;
    }).join('') : `<li class="empty">${term ? '찾는 폴더가 없어요' : '새 폴더를 만들어 시작하세요'}</li>`;
  }

  function renderUploads() {
    const { active, failed, doneToday } = stats();
    $('#stat-active').textContent = active.length;
    $('#stat-done').textContent = doneToday.length;
    $('#stat-failed').textContent = failed.length;
    $('#btn-retry-all').hidden = failed.length < 2;

    const badge = $('#tab-badge');
    badge.hidden = !active.length;
    badge.textContent = active.length;

    const reason = active.length ? Uploader.hold() : null;
    $('#upload-hold').hidden = !reason;
    $('#upload-hold').textContent = holdText(reason);
    $('#reconnect-banner').hidden = !(reason === 'auth' || (!Drive.hasToken() && active.length));

    $('#upload-empty').hidden = photos.length > 0;
    $('#upload-list').innerHTML = photos.slice(0, 100).map((p) => {
      let right = '';
      let bar = '';
      if (p.status === 'uploading') {
        const pct = Math.round((Uploader.progressOf(p.id) || 0) * 100);
        right = `<span class="status-pct" data-pct="${esc(p.id)}">${pct}%</span>`;
        bar = `<span class="bar"><span class="bar-fill" data-bar="${esc(p.id)}" style="width:${pct}%"></span></span>`;
      } else if (p.status === 'waiting') {
        right = '<span class="status-text">대기</span>';
      } else if (p.status === 'failed') {
        right = `<button class="btn-retry" type="button" data-retry="${esc(p.id)}">다시 시도</button>`;
      } else {
        right = CHECK_SVG;
      }
      const sub = p.status === 'failed' && p.error ? `<span class="small c-err ellipsis">${esc(p.error)}</span>` : `<span class="small muted">${esc(p.folderName)} · ${relTime(p.createdAt)}</span>`;
      return `<li class="upload-item">
        <button class="thumb" type="button" data-photo="${esc(p.id)}" aria-label="${esc(p.name)} 보기"><img src="${p.thumb}" alt=""></button>
        <span class="upload-info"><span class="name ellipsis">${esc(p.name)}</span>${sub}${bar}</span>
        ${right}
      </li>`;
    }).join('');
  }

  function renderSettings() {
    const acc = Store.getAccount();
    const s = Store.getSettings();
    $('#account-email').textContent = acc && acc.email ? acc.email : '구글 계정';
    const avatar = $('#account-initial');
    if (acc && acc.picture) avatar.innerHTML = `<img src="${esc(acc.picture)}" alt="" referrerpolicy="no-referrer">`;
    else avatar.textContent = acc && acc.name ? acc.name.slice(0, 1) : 'G';
    const connected = Drive.hasToken();
    $('#account-status').textContent = connected ? '드라이브 연결됨' : '연결 만료 · 촬영은 계속 가능';
    $('#account-status').className = 'small ' + (connected ? 'c-ok' : 'muted');
    const rootName = (Store.getRoot() || {}).name || Drive.rootName();
    $('#root-name').textContent = rootName;
    $$('.root-name-inline').forEach((el) => { el.textContent = rootName; });
    $('#opt-data').checked = s.useData;
    $('#opt-original').checked = s.original;
    $('#opt-notify').checked = s.notify;
  }

  function renderChips() {
    const cur = currentFolder();
    $('#cam-chips').innerHTML = folders().map((f) =>
      `<button class="chip" type="button" data-chip="${esc(f.id)}" aria-pressed="${!!(cur && cur.id === f.id)}">${esc(f.name)}</button>`
    ).join('');
    const count = $('#cam-count');
    count.hidden = !shotsThisSession;
    count.textContent = shotsThisSession;
    const last = photos[0];
    $('#cam-last').style.backgroundImage = last ? `url("${last.thumb}")` : '';
  }

  // 업로드 진행률은 목록 전체를 다시 그리지 않고 막대만 바꾼다
  function paintProgress(id, ratio) {
    const pct = Math.round(ratio * 100);
    const bar = document.querySelector(`[data-bar="${id}"]`);
    const label = document.querySelector(`[data-pct="${id}"]`);
    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = pct + '%';
    const { active } = stats();
    $('#home-progress-bar').style.width = Math.max(overallProgress(active), 4) + '%';
  }

  async function refresh() {
    photos = await Store.photos.all();
    render();
  }

  // ---------- 카메라 ----------
  async function openCamera() {
    if (!currentFolder()) {
      toast('먼저 사진을 올릴 폴더를 만들어 주세요');
      openFolderDialog();
      return;
    }
    shotsThisSession = 0;
    renderChips();
    $('#camera').hidden = false;
    $('#cam-toast').hidden = true;
    $('#cam-error').hidden = true;
    if (location.hash !== '#camera') history.pushState({ camera: true }, '', '#camera');
    try {
      await Camera.open($('#video'));
      $('#video').classList.toggle('mirror', Camera.facing() === 'user');
      const torch = Camera.hasTorch();
      $('#btn-torch').hidden = !torch;
      $('#torch-spacer').hidden = torch;
      $('#btn-torch').setAttribute('aria-pressed', 'false');
    } catch (e) {
      $('#cam-error-text').textContent = e.message;
      $('#cam-error').hidden = false;
    }
  }

  function closeCamera(fromPopState) {
    Camera.stop();
    $('#camera').hidden = true;
    if (!fromPopState && location.hash === '#camera') history.back();
  }

  function camToast(folderName) {
    const el = $('#cam-toast');
    el.innerHTML = `<span class="ok-dot"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1E7B4A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></span><span><strong>${esc(folderName)}</strong> 폴더에 저장됨 · ${Uploader.hold() ? '연결되면 업로드' : '업로드 중'}</span>`;
    el.hidden = false;
    clearTimeout(camToastTimer);
    camToastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  async function savePhoto(blob) {
    const folder = currentFolder();
    if (!blob || !folder) return;
    await Uploader.add(blob, folder);
    shotsThisSession++;
    await refresh();
    camToast(folder.name);
  }

  async function shoot() {
    const btn = $('#btn-shutter');
    if (btn.disabled) return;
    btn.disabled = true;
    const flash = $('#flash');
    flash.classList.remove('on');
    void flash.offsetWidth;
    flash.classList.add('on');
    if (navigator.vibrate) navigator.vibrate(30);
    try {
      await savePhoto(await Camera.capture());
    } catch (e) {
      toast(e.message || '촬영하지 못했어요');
    } finally {
      btn.disabled = false;
    }
  }

  // ---------- 다이얼로그 ----------
  function openFolderDialog() {
    const dlg = $('#dlg-folder');
    $('#new-folder-name').value = '';
    renderSettings();
    dlg.showModal();
    setTimeout(() => $('#new-folder-name').focus(), 50);
  }

  async function openViewer(id) {
    const p = await Store.photos.get(id);
    if (!p) return;
    const img = $('#viewer-img');
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    if (p.blob) {
      const url = URL.createObjectURL(p.blob);
      img.dataset.url = url;
      img.src = url;
    } else {
      img.dataset.url = '';
      img.src = p.thumb;
    }
    img.alt = p.name;
    const where = p.status === 'done' ? '드라이브에 올라감' : p.status === 'failed' ? '업로드 실패' : '업로드 대기';
    $('#viewer-meta').textContent = `${p.folderName} · ${p.name} · ${where}`;
    $('#dlg-photo').showModal();
  }

  // ---------- 알림 ----------
  function notify(title, body) {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
    try { new Notification(title, { body, icon: 'icons/icon-192.png' }); } catch (e) { /* 일부 브라우저는 서비스워커 알림만 허용 */ }
  }

  // ---------- 이벤트 ----------
  function bind() {
    document.addEventListener('click', (e) => {
      const t = e.target.closest('button, a');
      if (!t) return;
      if (t.dataset.tab) return setTab(t.dataset.tab);
      if (t.dataset.go) return setTab(t.dataset.go);
      if (t.dataset.folder) return pickFolder(t.dataset.folder);
      if (t.dataset.chip) { Store.setCurrent(t.dataset.chip); render(); return; }
      if (t.dataset.retry) return Uploader.retry(t.dataset.retry);
      if (t.dataset.photo) return openViewer(t.dataset.photo);
      if (t.dataset.goClose) { closeCamera(); setTab(t.dataset.goClose); return; }
      switch (t.dataset.action) {
        case 'open-camera': return openCamera();
        case 'close-camera': return closeCamera();
        case 'new-folder': return openFolderDialog();
        case 'close-dialog': return t.closest('dialog').close();
        case 'close-viewer': return $('#dlg-photo').close();
        case 'native-camera': return $('#native-input').click();
      }
    });

    $('#btn-connect').addEventListener('click', (e) => connect(e.currentTarget));
    $('#btn-reconnect').addEventListener('click', (e) => connect(e.currentTarget));
    $('#btn-disconnect').addEventListener('click', disconnect);
    $('#btn-retry-all').addEventListener('click', () => Uploader.retryAll());
    $('#btn-shutter').addEventListener('click', shoot);
    $('#btn-flip').addEventListener('click', async () => {
      try {
        await Camera.flip();
        $('#video').classList.toggle('mirror', Camera.facing() === 'user');
        const torch = Camera.hasTorch();
        $('#btn-torch').hidden = !torch;
        $('#torch-spacer').hidden = torch;
      } catch (e) { toast(e.message); }
    });
    $('#btn-torch').addEventListener('click', async (e) => {
      const on = await Camera.toggleTorch();
      e.currentTarget.setAttribute('aria-pressed', String(on));
    });
    $('#native-input').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) await savePhoto(file);
    });

    $('#form-folder').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'ok') createFolder($('#new-folder-name').value);
    });
    $('#dlg-photo').addEventListener('close', () => {
      const img = $('#viewer-img');
      if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
      img.dataset.url = '';
    });

    $('#folder-search').addEventListener('input', renderFolderList);

    $('#opt-data').addEventListener('change', (e) => {
      Store.setSettings(Object.assign(Store.getSettings(), { useData: e.target.checked }));
      Uploader.kick();
    });
    $('#opt-original').addEventListener('change', (e) => {
      Store.setSettings(Object.assign(Store.getSettings(), { original: e.target.checked }));
    });
    $('#opt-notify').addEventListener('change', (e) => {
      Store.setSettings(Object.assign(Store.getSettings(), { notify: e.target.checked }));
      if (e.target.checked && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    });

    window.addEventListener('popstate', () => {
      if (!$('#camera').hidden && location.hash !== '#camera') closeCamera(true);
    });
    window.addEventListener('online', render);
    window.addEventListener('offline', render);

    let doneBatch = 0;
    Uploader.on((type, detail) => {
      if (type === 'progress') return paintProgress(detail.id, detail.ratio);
      if (type === 'failed') {
        toast('업로드 실패: ' + detail.message);
        notify('업로드 실패', detail.message);
      }
      if (type === 'uploaded') doneBatch++;
      refresh().then(() => {
        // 대기열이 다 비었을 때 한 번만 알린다
        if (type === 'uploaded' && !stats().active.length) {
          if (Store.getSettings().notify) notify('업로드 완료', `${doneBatch}장을 드라이브에 올렸어요`);
          doneBatch = 0;
        }
      });
    });
  }

  async function boot() {
    bind();
    await Uploader.init();
    await refresh();
    if (Store.getAccount() || Store.getRoot()) {
      showApp();
      syncFolders();
    } else {
      showConnect();
    }
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  boot();
})();
