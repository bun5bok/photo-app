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
    if (fv.folderId) closeFolderView(false, true);
    $$('.tab').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
    ['home', 'folders', 'upload', 'settings'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
    window.scrollTo(0, 0);
  }

  // ---------- 폴더 상세 (폴더 안 사진 보기) ----------
  const fv = { folderId: null, files: [], next: null, loading: false, error: null };
  const fvThumbs = new Map(); // 드라이브 파일 id -> 미리보기 (이번 실행 동안만)
  let fvQueue = [];
  let fvWorking = 0;

  function openFolderView(id) {
    const folder = folders().find((f) => f.id === id);
    if (!folder) return;
    Object.assign(fv, { folderId: id, files: [], next: null, loading: false, error: null });
    ['home', 'folders', 'upload', 'settings'].forEach((t) => { $('#tab-' + t).hidden = true; });
    $('#folder-view').hidden = false;
    window.scrollTo(0, 0);
    if (location.hash !== '#folder') history.pushState({ folder: true }, '', '#folder');
    renderFolderView();
    loadFolderFiles();
  }

  function closeFolderView(fromPopState, keepTab) {
    fv.folderId = null;
    fvQueue = [];
    $('#folder-view').hidden = true;
    if (!keepTab) ['home', 'folders', 'upload', 'settings'].forEach((t) => { $('#tab-' + t).hidden = t !== tab; });
    if (!fromPopState && location.hash === '#folder') history.back();
  }

  async function loadFolderFiles(more) {
    const folder = folders().find((f) => f.id === fv.folderId);
    if (!folder || !folder.driveId || !Drive.hasToken() || fv.loading) return renderFolderView();
    const id = fv.folderId;
    fv.loading = true;
    renderFolderView();
    try {
      const r = await Drive.listFiles(folder.driveId, more ? fv.next : null);
      if (fv.folderId !== id) return;
      fv.files = more ? fv.files.concat(r.files || []) : (r.files || []);
      fv.next = r.nextPageToken || null;
      fv.error = null;
    } catch (e) {
      if (fv.folderId !== id) return;
      fv.error = e instanceof Drive.AuthError ? 'auth' : '드라이브에서 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.';
    } finally {
      if (fv.folderId === id) { fv.loading = false; renderFolderView(); }
    }
  }

  function dayLabel(ts) {
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return '오늘';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return '어제';
    return (d.getFullYear() !== now.getFullYear() ? d.getFullYear() + '년 ' : '') + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }

  // 이 휴대폰의 기록과 드라이브 목록을 합친다 (같은 파일은 휴대폰 미리보기를 쓴다)
  function folderItems() {
    const local = photos.filter((p) => p.folderId === fv.folderId);
    const known = new Set(local.map((p) => p.driveFileId).filter(Boolean));
    const remote = fv.files.filter((f) => !known.has(f.id)).map((f) => ({
      remote: true,
      id: f.id,
      driveFileId: f.id,
      kind: /^video\//.test(f.mimeType) ? 'video' : 'photo',
      name: f.name,
      webViewLink: f.webViewLink,
      thumbLink: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, '=s400') : '',
      duration: f.videoMediaMetadata && f.videoMediaMetadata.durationMillis ? Math.round(f.videoMediaMetadata.durationMillis / 1000) : null,
      createdAt: Date.parse(f.createdTime) || 0,
      status: 'done'
    }));
    return local.concat(remote).sort((a, b) => b.createdAt - a.createdAt);
  }

  const PH_SVG = '<span class="ph"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg></span>';

  function tileHtml(p) {
    let inner;
    if (!p.remote) {
      inner = thumbInner(p);
    } else {
      const cached = fvThumbs.get(p.id);
      const src = cached || p.thumbLink;
      inner = PH_SVG + (src ? `<img src="${esc(src)}" alt="" referrerpolicy="no-referrer" data-remote="${esc(p.id)}" data-kind="${p.kind}"${cached ? ' data-cached="1"' : ''}>` : '');
      if (p.kind === 'video') inner += `<span class="vid"><svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="#fff"/></svg>${p.duration ? fmtTime(p.duration) : ''}</span>`;
      if (!src && p.kind === 'photo') fvQueue.push(p.id);
    }
    let state = '';
    if (p.status === 'uploading') state = `<span class="state"><span class="up">${Math.round((Uploader.progressOf(p.id) || 0) * 100)}%</span></span>`;
    else if (p.status === 'waiting') state = '<span class="state"><span>대기</span></span>';
    else if (p.status === 'failed') state = '<span class="state"><span class="fail">실패</span></span>';
    return `<button class="thumb" type="button" data-fv-item="${esc(p.id)}" data-fv-remote="${p.remote ? 1 : 0}" aria-label="${esc(p.name)} 보기">${inner}${state}</button>`;
  }

  function renderFolderView() {
    if (!fv.folderId) return;
    const folder = folders().find((f) => f.id === fv.folderId);
    if (!folder) return closeFolderView();
    const root = Store.getRoot();
    const cur = currentFolder();
    const items = folderItems();
    $('#fv-title').textContent = folder.name;
    $('#fv-path').textContent = `내 드라이브 › ${root ? root.name : Drive.rootName()} › ${folder.name}${items.length ? ` · ${items.length}${fv.next ? '+' : ''}개` : ''}`;
    $('#fv-drive').hidden = !folder.driveId;
    if (folder.driveId) $('#fv-drive').href = `https://drive.google.com/drive/folders/${folder.driveId}`;
    const isCurrent = !!cur && cur.id === folder.id;
    $('#fv-set').hidden = isCurrent;
    $('#fv-current').hidden = !isCurrent;

    let notice = '';
    if (fv.error === 'auth' || (folder.driveId && !Drive.hasToken())) notice = '드라이브 연결이 만료돼 이 휴대폰에서 찍은 것만 보여요. 위의 ‘다시 연결’을 누르면 전체가 보여요.';
    else if (fv.error) notice = fv.error;
    $('#fv-notice').hidden = !notice;
    $('#fv-notice').textContent = notice;

    // 날짜별로 묶어서 보여 준다
    fvQueue = [];
    const groups = [];
    items.forEach((p) => {
      const label = dayLabel(p.createdAt);
      let g = groups[groups.length - 1];
      if (!g || g.label !== label) { g = { label, items: [] }; groups.push(g); }
      g.items.push(p);
    });
    $('#fv-groups').innerHTML = groups.map((g) => `
      <section class="fv-group">
        <h2>${esc(g.label)} · ${g.items.length}개</h2>
        <div class="fv-grid">${g.items.map(tileHtml).join('')}</div>
      </section>`).join('');
    $('#fv-empty').hidden = items.length > 0 || fv.loading;
    $('#fv-loading').hidden = !fv.loading;
    $('#fv-more').hidden = !fv.next || fv.loading;

    // 드라이브 미리보기 주소가 열리지 않으면 원본을 받아 작은 미리보기를 만든다
    $$('#fv-groups img[data-remote]:not([data-cached])').forEach((img) => {
      img.addEventListener('error', () => {
        img.remove();
        if (img.dataset.kind === 'photo') { fvQueue.push(img.dataset.remote); pumpThumbs(); }
      }, { once: true });
    });
    pumpThumbs();
  }

  async function makeThumbFromBlob(blob) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(() => createImageBitmap(blob));
    const scale = 400 / Math.max(bmp.width, bmp.height);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * Math.min(1, scale));
    c.height = Math.round(bmp.height * Math.min(1, scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    if (bmp.close) bmp.close();
    return c.toDataURL('image/jpeg', 0.75);
  }

  function pumpThumbs() {
    while (fvWorking < 2 && fvQueue.length && Drive.hasToken()) {
      const id = fvQueue.shift();
      if (fvThumbs.has(id)) continue;
      fvWorking++;
      fvThumbs.set(id, '');
      Drive.download(id).then(makeThumbFromBlob).then((url) => {
        fvThumbs.set(id, url);
        const btn = document.querySelector(`[data-fv-item="${id}"]`);
        if (btn && !btn.querySelector('img')) btn.insertAdjacentHTML('beforeend', `<img src="${url}" alt="">`);
      }).catch(() => { fvThumbs.delete(id); }).finally(() => { fvWorking--; pumpThumbs(); });
    }
  }

  function openFolderItem(id, remote) {
    if (!remote) return openViewer(id);
    const p = folderItems().find((x) => x.id === id);
    if (p) openViewer(null, Object.assign({ folderName: folders().find((f) => f.id === fv.folderId).name, thumb: fvThumbs.get(id) || p.thumbLink }, p));
  }

  // ---------- 그리기 ----------
  function render() {
    renderHome();
    renderFolderList();
    renderUploads();
    renderSettings();
    renderChips();
    renderFolderView();
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

  // 동영상 썸네일에는 재생 표시와 길이를 붙인다
  function thumbInner(p) {
    const img = p.thumb ? `<img src="${p.thumb}" alt="">` : '';
    if (p.kind !== 'video') return img;
    const len = p.duration ? fmtTime(p.duration) : '';
    return img + `<span class="vid"><svg width="8" height="8" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 1l7 4-7 4z" fill="#fff"/></svg>${len}</span>`;
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
      ? recent.map((p) => `<button class="thumb" type="button" data-photo="${esc(p.id)}" aria-label="${esc(p.name)} 보기">${thumbInner(p)}</button>`).join('')
      : '<p class="recent-empty">찍은 사진이 여기에 보여요</p>';

    // 현재 저장 위치를 맨 앞에, 나머지는 최근에 쓴 순서로 3개까지
    const others = folders().filter((f) => !cur || f.id !== cur.id).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    const list = (cur ? [cur] : []).concat(others).slice(0, 3);
    $('#home-folders').innerHTML = list.map((f) => `
      <button class="folder-card" type="button" data-open-folder="${esc(f.id)}" aria-pressed="${cur && cur.id === f.id}">
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
        <button class="thumb" type="button" data-photo="${esc(p.id)}" aria-label="${esc(p.name)} 보기">${thumbInner(p)}</button>
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
  const MAX_RECORD = 600; // 동영상 최대 10분
  let camMode = 'photo';
  let recTimer = null;
  let wakeLock = null;

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
    if (location.hash !== '#camera') history.pushState({ camera: true }, '', '#camera');
    await startCameraStream();
  }

  async function startCameraStream() {
    $('#cam-error').hidden = true;
    renderModeSwitch();
    try {
      await Camera.open($('#video'), camMode);
      afterCameraOpen();
    } catch (e) {
      $('#cam-error-text').textContent = e.message;
      $('#cam-error').hidden = false;
      $('#zoom-bar').hidden = true;
    }
  }

  function afterCameraOpen() {
    const torch = Camera.hasTorch();
    $('#btn-torch').hidden = !torch;
    $('#torch-spacer').hidden = torch;
    $('#btn-torch').setAttribute('aria-pressed', 'false');
    renderZoomBar();
    if (camMode === 'video' && !Camera.canRecord()) {
      $('#cam-error-text').textContent = '이 브라우저는 앱 안 동영상 녹화를 지원하지 않아요.';
      $('#cam-error').hidden = false;
    }
  }

  async function closeCamera(fromPopState) {
    const wasRecording = Camera.isRecording();
    if (wasRecording) Camera.stopRecording(); // 녹화 중이면 저장하고 닫는다 (새 버전 적용은 저장 뒤에)
    Camera.stop();
    $('#camera').hidden = true;
    if (!fromPopState && location.hash === '#camera') history.back();
    if (reloadPending && !wasRecording) setTimeout(() => location.reload(), 300);
  }

  function renderModeSwitch() {
    $$('.mode-btn').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === camMode)));
    const shutter = $('#btn-shutter');
    shutter.classList.toggle('video', camMode === 'video');
    shutter.setAttribute('aria-label', camMode === 'video' ? '녹화 시작' : '촬영');
    $('[data-action="native-camera"]').textContent = camMode === 'video' ? '휴대폰 카메라 앱으로 녹화하기' : '휴대폰 카메라 앱으로 찍기';
  }

  async function setMode(next) {
    if (next === camMode || Camera.isRecording()) return;
    camMode = next;
    await startCameraStream();
  }

  // 줌: 배율 버튼 + 두 손가락 벌리기
  function zoomPresets(range) {
    const list = [1, 2, 3, 5, 10].filter((z) => z >= range.min && z <= range.max + 0.01);
    if (range.max > 1 && list[list.length - 1] < range.max - 0.5 && list.length < 4) list.push(Math.floor(range.max * 10) / 10);
    return list;
  }

  function fmtZoom(z) {
    return (Math.round(z * 10) / 10).toFixed(z < 10 ? 1 : 0).replace(/\.0$/, '') + 'x';
  }

  function renderZoomBar() {
    const range = Camera.zoomRange();
    const bar = $('#zoom-bar');
    bar.hidden = range.max <= 1;
    if (bar.hidden) return;
    const cur = Camera.getZoom();
    const presets = zoomPresets(range);
    // 지금 배율에 가장 가까운 버튼을 선택 표시하고, 버튼에 없는 배율이면 그 버튼에 현재 값을 보여 준다
    let nearest = presets[0];
    presets.forEach((z) => { if (z <= cur + 0.05) nearest = z; });
    bar.innerHTML = presets.map((z) => {
      const on = z === nearest;
      const label = on && Math.abs(cur - z) > 0.05 ? fmtZoom(cur) : fmtZoom(z);
      return `<button class="zoom-btn" type="button" data-zoom="${z}" aria-pressed="${on}" aria-label="${fmtZoom(z)} 줌">${label}</button>`;
    }).join('');
  }

  let zoomLabelTimer = null;
  function showZoomLabel(z) {
    const el = $('#zoom-label');
    el.textContent = fmtZoom(z);
    el.hidden = false;
    clearTimeout(zoomLabelTimer);
    zoomLabelTimer = setTimeout(() => { el.hidden = true; }, 700);
  }

  async function zoomTo(z) {
    const now = await Camera.setZoom(z);
    renderZoomBar();
    return now;
  }

  function bindPinchZoom() {
    const vf = $('.viewfinder');
    const pts = new Map();
    let start = null;
    let pending = null;
    vf.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        start = { d: Math.hypot(a.x - b.x, a.y - b.y), z: Camera.getZoom() };
      }
    });
    vf.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size !== 2 || !start || Camera.zoomRange().max <= 1) return;
      const [a, b] = [...pts.values()];
      const target = start.z * (Math.hypot(a.x - b.x, a.y - b.y) / start.d);
      if (pending) { pending.z = target; return; }
      pending = { z: target };
      requestAnimationFrame(async () => {
        const z = await zoomTo(pending.z);
        pending = null;
        showZoomLabel(z);
      });
    });
    const end = (e) => { pts.delete(e.pointerId); if (pts.size < 2) start = null; };
    vf.addEventListener('pointerup', end);
    vf.addEventListener('pointercancel', end);
    vf.addEventListener('pointerleave', end);
  }

  function camToast(folderName, isVideo) {
    const el = $('#cam-toast');
    el.innerHTML = `<span class="ok-dot"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#1E7B4A" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10"/></svg></span><span>${isVideo ? '동영상이 ' : ''}<strong>${esc(folderName)}</strong> 폴더에 저장됨 · ${Uploader.hold() ? '연결되면 업로드' : '업로드 중'}</span>`;
    el.hidden = false;
    clearTimeout(camToastTimer);
    camToastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  async function savePhoto(blob, opts) {
    const folder = currentFolder();
    if (!blob || !folder) return;
    await Uploader.add(blob, folder, opts);
    shotsThisSession++;
    await refresh();
    camToast(folder.name, /^video\//.test(blob.type));
  }

  // 휴대폰 카메라 앱으로 찍은 동영상의 미리보기와 길이를 만든다
  function videoInfo(blob) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const url = URL.createObjectURL(blob);
      let done = false;
      const finish = (thumb) => {
        if (done) return;
        done = true;
        const duration = isFinite(v.duration) ? Math.round(v.duration) : null;
        URL.revokeObjectURL(url);
        resolve({ thumb: thumb || '', duration });
      };
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      v.onloadeddata = () => { try { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); } catch (e) { finish(''); } };
      v.onseeked = () => {
        const scale = 320 / Math.max(v.videoWidth || 1, v.videoHeight || 1);
        const c = document.createElement('canvas');
        c.width = Math.round(v.videoWidth * scale) || 320;
        c.height = Math.round(v.videoHeight * scale) || 180;
        try { c.getContext('2d').drawImage(v, 0, 0, c.width, c.height); finish(c.toDataURL('image/jpeg', 0.75)); } catch (e) { finish(''); }
      };
      v.onerror = () => finish('');
      setTimeout(() => finish(''), 5000);
      v.src = url;
    });
  }

  function fmtTime(sec) {
    const m = Math.floor(sec / 60), s = sec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  function setRecordingUi(on) {
    $('#btn-shutter').classList.toggle('recording', on);
    $('#btn-shutter').setAttribute('aria-label', on ? '녹화 멈춤' : '녹화 시작');
    $('.mode-switch').classList.toggle('locked', on);
    $('#btn-flip').disabled = on;
    $('#rec-badge').hidden = !on;
    $('#rec-badge').classList.remove('near-end');
    $('#rec-time').textContent = '00:00';
  }

  async function toggleRecording() {
    if (Camera.isRecording()) {
      Camera.stopRecording();
      return;
    }
    let result;
    const done = Camera.startRecording();
    setRecordingUi(true);
    if (navigator.vibrate) navigator.vibrate(30);
    try { if (navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* 화면 꺼짐 방지 미지원 */ }
    recTimer = setInterval(() => {
      const sec = Camera.elapsed();
      $('#rec-time').textContent = fmtTime(sec);
      $('#rec-badge').classList.toggle('near-end', sec >= MAX_RECORD - 30);
      if (sec >= MAX_RECORD) { Camera.stopRecording(); toast('최대 10분이 되어 녹화를 마쳤어요'); }
    }, 500);
    try {
      result = await done;
    } catch (e) {
      toast(e.message || '녹화하지 못했어요');
    } finally {
      clearInterval(recTimer);
      setRecordingUi(false);
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
    if (result) await savePhoto(result.blob, { thumb: result.thumb, duration: result.duration, startedAt: result.startedAt });
    if (reloadPending && $('#camera').hidden) location.reload();
  }

  async function shoot() {
    if (camMode === 'video') return toggleRecording();
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

  // ---------- 크게 보기 (두 손가락 확대, 두 번 눌러 확대, 끌어서 이동) ----------
  const view = { s: 1, x: 0, y: 0 };
  let viewerUrl = null;
  let viewerToken = 0;

  function applyView() {
    $('#viewer-img').style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
  }

  function resetView() {
    view.s = 1; view.x = 0; view.y = 0;
    applyView();
  }

  // 확대한 사진이 화면 밖으로 너무 벗어나지 않게 붙잡는다
  function clampView() {
    const r = $('#viewer-stage').getBoundingClientRect();
    if (view.s <= 1) { view.s = 1; view.x = 0; view.y = 0; return; }
    // 화면에 맞춰 줄어든 실제 사진 영역(위아래나 양옆의 검은 여백 제외)을 기준으로 한다
    const img = $('#viewer-img');
    const ratio = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : r.width / r.height;
    const cw = Math.min(r.width, r.height * ratio), ch = cw / ratio;
    const ox = (r.width - cw) / 2, oy = (r.height - ch) / 2;
    const fit = (pos, stage, size, off) => {
      if (size * view.s <= stage) return (stage - size * view.s) / 2 - off * view.s;
      return Math.min(-off * view.s, Math.max(stage - (off + size) * view.s, pos));
    };
    view.x = fit(view.x, r.width, cw, ox);
    view.y = fit(view.y, r.height, ch, oy);
  }

  function zoomAt(px, py, nextScale) {
    const s = Math.min(5, Math.max(1, nextScale));
    view.x = px - (px - view.x) * (s / view.s);
    view.y = py - (py - view.y) * (s / view.s);
    view.s = s;
    clampView();
    applyView();
  }

  function bindViewerGestures() {
    const stage = $('#viewer-stage');
    const pts = new Map();
    let pinch = null;
    let pan = null;
    let lastTap = 0;
    const local = (e) => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

    stage.addEventListener('pointerdown', (e) => {
      if ($('#viewer-img').hidden) return;
      stage.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, local(e));
      $('#viewer-hint').classList.add('gone');
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, x: view.x, y: view.y };
        pan = null;
      } else if (pts.size === 1) {
        const p = local(e);
        pan = { px: p.x, py: p.y, x: view.x, y: view.y };
        const now = Date.now();
        if (now - lastTap < 300) {
          zoomAt(p.x, p.y, view.s > 1 ? 1 : 2.5);
          lastTap = 0;
          pan = null;
        } else {
          lastTap = now;
        }
      }
    });
    stage.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, local(e));
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const s = Math.min(5, Math.max(1, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        view.x = mx - (pinch.mx - pinch.x) * (s / pinch.s);
        view.y = my - (pinch.my - pinch.y) * (s / pinch.s);
        view.s = s;
        clampView();
        applyView();
      } else if (pan && view.s > 1) {
        const p = local(e);
        view.x = pan.x + (p.x - pan.px);
        view.y = pan.y + (p.y - pan.py);
        clampView();
        applyView();
      }
    });
    const end = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 1) {
        const p = [...pts.values()][0];
        pan = { px: p.x, py: p.y, x: view.x, y: view.y };
      }
      if (!pts.size) pan = null;
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    // 컴퓨터에서는 마우스 휠로 확대
    stage.addEventListener('wheel', (e) => {
      if ($('#viewer-img').hidden) return;
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, view.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2));
    }, { passive: false });
  }

  function driveLink(p) {
    return p.webViewLink || (p.driveFileId ? `https://drive.google.com/file/d/${p.driveFileId}/view` : '');
  }

  function clearViewerMedia() {
    if (viewerUrl) URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
    const vid = $('#viewer-video');
    vid.pause();
    vid.removeAttribute('src');
    vid.load();
  }

  // id: 이 휴대폰의 기록 id, record: 드라이브에만 있는 파일을 볼 때 직접 넘기는 정보
  async function openViewer(id, record) {
    const p = record || await Store.photos.get(id);
    if (!p) return;
    const token = ++viewerToken;
    clearViewerMedia();
    resetView();
    const img = $('#viewer-img');
    const vid = $('#viewer-video');
    const isVideo = p.kind === 'video';
    const link = driveLink(p);
    $('#viewer-loading').hidden = true;
    $('#viewer-drive').hidden = !link;
    if (link) $('#viewer-drive').href = link;

    if (isVideo && p.blob) {
      // 아직 휴대폰에 있는 동영상은 바로 재생
      viewerUrl = URL.createObjectURL(p.blob);
      vid.src = viewerUrl;
      vid.hidden = false;
      img.hidden = true;
      $('#viewer-hint').hidden = true;
    } else {
      // 사진, 또는 이미 올라가 휴대폰에서 지운 동영상(미리보기 + 드라이브 링크)
      vid.hidden = true;
      img.hidden = false;
      img.alt = p.name;
      $('#viewer-hint').hidden = isVideo;
      $('#viewer-hint').classList.remove('gone');
      setTimeout(() => $('#viewer-hint').classList.add('gone'), 2500);
      if (p.blob) {
        viewerUrl = URL.createObjectURL(p.blob);
        img.src = viewerUrl;
      } else {
        img.src = p.thumb;
        // 올라간 사진은 휴대폰에 작은 미리보기만 있으니, 연결돼 있으면 드라이브에서 원본을 받아와 선명하게 보여 준다
        if (!isVideo && p.driveFileId && Drive.hasToken()) {
          $('#viewer-loading').hidden = false;
          Drive.download(p.driveFileId).then((blob) => {
            if (token !== viewerToken) return;
            viewerUrl = URL.createObjectURL(blob);
            img.src = viewerUrl;
          }).catch(() => {}).finally(() => {
            if (token === viewerToken) $('#viewer-loading').hidden = true;
          });
        }
      }
    }
    const where = p.status === 'done' ? '드라이브에 올라감' : p.status === 'failed' ? '업로드 실패' : '업로드 대기';
    const len = isVideo && p.duration ? ` · ${fmtTime(p.duration)}` : '';
    $('#viewer-meta').textContent = `${p.folderName} · ${p.name}${len} · ${where}`;
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
      if (t.dataset.openFolder) return openFolderView(t.dataset.openFolder);
      if (t.dataset.fvItem) return openFolderItem(t.dataset.fvItem, t.dataset.fvRemote === '1');
      if (t.dataset.chip) { Store.setCurrent(t.dataset.chip); render(); return; }
      if (t.dataset.retry) return Uploader.retry(t.dataset.retry);
      if (t.dataset.photo) return openViewer(t.dataset.photo);
      if (t.dataset.goClose) { closeCamera(); setTab(t.dataset.goClose); return; }
      if (t.dataset.mode) return setMode(t.dataset.mode);
      if (t.dataset.zoom) return zoomTo(Number(t.dataset.zoom)).then(showZoomLabel);
      switch (t.dataset.action) {
        case 'open-camera': return openCamera();
        case 'close-camera': return closeCamera();
        case 'new-folder': return openFolderDialog();
        case 'close-dialog': return t.closest('dialog').close();
        case 'close-viewer': return $('#dlg-photo').close();
        case 'close-folder': return closeFolderView();
        case 'fv-more': return loadFolderFiles(true);
        case 'fv-set-target':
          Store.setCurrent(fv.folderId);
          render();
          return toast('저장 위치로 지정했어요');
        case 'fv-shoot':
          Store.setCurrent(fv.folderId);
          render();
          return openCamera();
        case 'native-camera': return $(camMode === 'video' ? '#native-video' : '#native-input').click();
      }
    });

    $('#btn-connect').addEventListener('click', (e) => connect(e.currentTarget));
    $('#btn-reconnect').addEventListener('click', (e) => connect(e.currentTarget));
    $('#btn-disconnect').addEventListener('click', disconnect);
    $('#btn-retry-all').addEventListener('click', () => Uploader.retryAll());
    $('#btn-shutter').addEventListener('click', shoot);
    $('#btn-flip').addEventListener('click', async () => {
      if (Camera.isRecording()) return;
      try {
        await Camera.flip();
        afterCameraOpen();
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
    $('#native-video').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const info = await videoInfo(file);
      await savePhoto(file, { thumb: info.thumb, duration: info.duration, startedAt: file.lastModified || Date.now() });
    });
    // 녹화 중에 다른 앱으로 넘어가면 브라우저가 카메라를 끊으니, 그때까지 찍은 것을 저장한다
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && Camera.isRecording()) Camera.stopRecording();
    });

    $('#form-folder').addEventListener('submit', (e) => {
      if (e.submitter && e.submitter.value === 'ok') createFolder($('#new-folder-name').value);
    });
    $('#dlg-photo').addEventListener('close', () => {
      viewerToken++;
      clearViewerMedia();
      $('#viewer-img').removeAttribute('src');
    });
    bindViewerGestures();
    bindPinchZoom();

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
      else if (fv.folderId && location.hash !== '#folder') closeFolderView(true);
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
    registerServiceWorker();
  }

  // 새 버전을 올리면 앱을 다시 열 때 바로 바뀌도록 한다.
  // 새 버전이 준비되면 화면을 한 번 새로 고치되, 촬영 중이면 카메라를 닫은 뒤에 한다
  let reloadPending = false;
  function reloadForUpdate() {
    if (!$('#camera').hidden || Camera.isRecording()) { reloadPending = true; return; }
    location.reload();
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController) reloadForUpdate();
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
    }).catch(() => {});
  }

  boot();
})();
