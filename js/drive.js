// 구글 드라이브 연결(Google Identity Services)과 Drive API v3 호출
(function () {
  const cfg = window.FOLDERCAM_CONFIG || {};
  const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email profile';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

  let tokenClient = null;
  let token = null; // { value, expiresAt }

  class AuthError extends Error {}

  function isConfigured() {
    return !!cfg.clientId && !/YOUR_CLIENT_ID/.test(cfg.clientId);
  }

  function rootName() {
    return cfg.rootFolderName || '사진촬영';
  }

  // 탭을 새로 열어도 1시간 안에는 다시 로그인하지 않도록 세션 동안만 보관
  try {
    const saved = JSON.parse(sessionStorage.getItem('fc.token') || 'null');
    if (saved && saved.expiresAt > Date.now()) token = saved;
  } catch (e) { /* 무시 */ }

  function hasToken() {
    return !!token && token.expiresAt - 60000 > Date.now();
  }

  function waitForGis() {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      (function check() {
        if (window.google && google.accounts && google.accounts.oauth2) return resolve();
        if (Date.now() - started > 15000) return reject(new Error('구글 로그인 스크립트를 불러오지 못했어요. 인터넷 연결을 확인하세요.'));
        setTimeout(check, 100);
      })();
    });
  }

  function allowedDomain() {
    return (cfg.allowedDomain || '').trim().toLowerCase();
  }

  // 구글이 확인해 준 계정 정보로 기관 계정인지 판단한다 (hd: Workspace 도메인)
  function isAllowedAccount(info) {
    const domain = allowedDomain();
    if (!domain) return true;
    const email = String(info.email || '').toLowerCase();
    return info.hd === domain || (info.email_verified !== false && email.endsWith('@' + domain));
  }

  // 반드시 버튼 클릭 같은 사용자 동작 안에서 호출해야 팝업이 막히지 않는다
  async function connect() {
    if (!isConfigured()) throw new Error('config.js에 클라이언트 ID가 없어요.');
    await waitForGis();
    const account = Store.getAccount();
    return new Promise((resolve, reject) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: SCOPE,
        login_hint: account && account.email ? account.email : undefined,
        hd: allowedDomain() || undefined,
        callback: (resp) => {
          if (resp.error) return reject(new Error(resp.error_description || resp.error));
          if (!google.accounts.oauth2.hasGrantedAllScopes(resp, 'https://www.googleapis.com/auth/drive.file')) {
            return reject(new Error('드라이브 권한을 허용해야 사진을 올릴 수 있어요.'));
          }
          token = { value: resp.access_token, expiresAt: Date.now() + Number(resp.expires_in || 3600) * 1000 };
          try { sessionStorage.setItem('fc.token', JSON.stringify(token)); } catch (e) { /* 무시 */ }
          resolve(token);
        },
        error_callback: (err) => {
          reject(new Error(err && err.type === 'popup_closed' ? '로그인 창이 닫혔어요.' : '구글 로그인을 열 수 없어요. 팝업 차단을 확인하세요.'));
        }
      });
      tokenClient.requestAccessToken({ prompt: account ? '' : 'consent' });
    });
  }

  function clearToken() {
    token = null;
    try { sessionStorage.removeItem('fc.token'); } catch (e) { /* 무시 */ }
  }

  async function disconnect() {
    if (token && window.google && google.accounts && google.accounts.oauth2) {
      await new Promise((resolve) => google.accounts.oauth2.revoke(token.value, resolve));
    }
    clearToken();
  }

  async function api(path, opts) {
    if (!hasToken()) throw new AuthError('token');
    const res = await fetch(path.startsWith('http') ? path : API + path, Object.assign({}, opts, {
      headers: Object.assign({ Authorization: 'Bearer ' + token.value }, (opts && opts.headers) || {})
    }));
    if (res.status === 401) {
      clearToken();
      throw new AuthError('token');
    }
    if (!res.ok) {
      let msg = res.status + '';
      try { msg = (await res.json()).error.message; } catch (e) { /* 무시 */ }
      throw new Error('드라이브 오류: ' + msg);
    }
    return res.status === 204 ? null : res.json();
  }

  function q(str) {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async function userInfo() {
    return api('https://www.googleapis.com/oauth2/v3/userinfo');
  }

  async function findFolder(name, parentId) {
    const query = `name='${q(name)}' and mimeType='${FOLDER_MIME}' and trashed=false and '${parentId}' in parents`;
    const r = await api('/files?fields=files(id,name)&pageSize=1&q=' + encodeURIComponent(query));
    return r.files[0] || null;
  }

  async function createFolder(name, parentId) {
    return api('/files?fields=id,name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    });
  }

  async function folderAlive(id) {
    try {
      const f = await api('/files/' + id + '?fields=id,trashed');
      return !f.trashed;
    } catch (e) {
      if (e instanceof AuthError) throw e;
      return false;
    }
  }

  // "내 드라이브 › 사진촬영" 폴더를 찾거나 만든다
  // 사진마다 폴더 존재를 다시 묻지 않도록 이번 실행에서 확인한 폴더 ID를 기억한다
  const verified = new Set();

  async function ensureRoot() {
    const saved = Store.getRoot();
    if (saved && (verified.has(saved.id) || (await folderAlive(saved.id)))) {
      verified.add(saved.id);
      return saved;
    }
    const name = rootName();
    const found = (await findFolder(name, 'root')) || (await createFolder(name, 'root'));
    const root = { id: found.id, name };
    Store.setRoot(root);
    verified.add(root.id);
    return root;
  }

  async function ensureFolder(folder) {
    const root = await ensureRoot();
    if (folder.driveId && (verified.has(folder.driveId) || (await folderAlive(folder.driveId)))) {
      verified.add(folder.driveId);
      return folder.driveId;
    }
    const found = (await findFolder(folder.name, root.id)) || (await createFolder(folder.name, root.id));
    verified.add(found.id);
    return found.id;
  }

  function forgetVerified() {
    verified.clear();
  }

  // 다른 기기에서 이 앱으로 만든 폴더도 가져온다 (drive.file 범위라 이 앱이 만든 것만 보인다)
  async function listFolders() {
    const root = await ensureRoot();
    const query = `'${root.id}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`;
    const r = await api('/files?fields=files(id,name)&pageSize=200&orderBy=name&q=' + encodeURIComponent(query));
    return r.files;
  }

  // 폴더 안의 사진·동영상을 최근 것부터 가져온다 (다른 휴대폰에서 올린 것 포함)
  async function listFiles(folderId, pageToken) {
    const query = `'${folderId}' in parents and mimeType!='${FOLDER_MIME}' and trashed=false`;
    const fields = 'nextPageToken,files(id,name,mimeType,thumbnailLink,createdTime,webViewLink,videoMediaMetadata(durationMillis))';
    let path = `/files?pageSize=60&orderBy=createdTime desc&fields=${encodeURIComponent(fields)}&q=${encodeURIComponent(query)}`;
    if (pageToken) path += '&pageToken=' + encodeURIComponent(pageToken);
    return api(path);
  }

  // ---------- 재개 가능 업로드 (동영상 같은 큰 파일도 끊긴 곳부터 이어서 올린다) ----------
  const CHUNK = 8 * 1024 * 1024; // 256KB의 배수여야 한다

  function driveError(status, text) {
    let msg = String(status);
    try { msg = JSON.parse(text).error.message; } catch (e) { /* 무시 */ }
    const err = new Error('드라이브 오류: ' + msg);
    err.status = status;
    return err;
  }

  function xhrRequest(method, url, headers, body, onProgress) {
    if (!hasToken()) return Promise.reject(new AuthError('token'));
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url);
      xhr.setRequestHeader('Authorization', 'Bearer ' + token.value);
      Object.keys(headers).forEach((k) => xhr.setRequestHeader(k, headers[k]));
      if (onProgress) xhr.upload.onprogress = (e) => onProgress(e.loaded);
      xhr.onload = () => {
        if (xhr.status === 401) { clearToken(); return reject(new AuthError('token')); }
        const override = xhr.getResponseHeader('X-HTTP-Status-Code-Override');
        resolve({ status: override ? Number(override) : xhr.status, text: xhr.responseText, xhr });
      };
      xhr.onerror = () => { const err = new Error('네트워크 오류'); err.network = true; reject(err); };
      xhr.send(body);
    });
  }

  // 308 응답의 Range 헤더("bytes=0-1234")로 서버가 받은 다음 위치를 알아낸다
  function nextOffset(res) {
    const range = res.xhr.getResponseHeader('Range');
    const m = range && range.match(/bytes=0-(\d+)/);
    return m ? Number(m[1]) + 1 : 0;
  }

  async function startSession(blob, name, parentId) {
    const res = await xhrRequest('POST', UPLOAD + '?uploadType=resumable&fields=id,name,webViewLink', {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': blob.type || 'application/octet-stream',
      'X-Upload-Content-Length': String(blob.size)
    }, JSON.stringify({ name, parents: [parentId] }));
    const location = res.xhr.getResponseHeader('Location');
    if (res.status !== 200 || !location) throw driveError(res.status, res.text);
    return location;
  }

  async function uploadedSoFar(sessionUrl, size) {
    const res = await xhrRequest('PUT', sessionUrl, { 'Content-Range': `bytes */${size}` }, null);
    if (res.status === 200 || res.status === 201) return { done: JSON.parse(res.text) };
    if (res.status === 308) return { offset: nextOffset(res) };
    if (res.status === 404 || res.status === 410) return { expired: true };
    throw driveError(res.status, res.text);
  }

  // 5MB 이하는 한 번에 올린다 (드라이브의 간단 업로드 한도)
  const SIMPLE_MAX = 5 * 1024 * 1024;

  async function uploadSimple(blob, name, parentId, onProgress) {
    const boundary = 'photoapp' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [parentId] })}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'application/octet-stream'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`
    ]);
    const res = await xhrRequest('POST', UPLOAD + '?uploadType=multipart&fields=id,name,webViewLink',
      { 'Content-Type': 'multipart/related; boundary=' + boundary }, body,
      (loaded) => onProgress && onProgress(Math.min(1, loaded / body.size)));
    if (res.status >= 200 && res.status < 300) return JSON.parse(res.text);
    throw driveError(res.status, res.text);
  }

  // 큰 파일은 8MB씩 나눠 올리고, 끊기면 서버가 받은 곳부터 이어서 올린다
  // session: 이전에 시작한 업로드 주소 (없으면 새로 시작), onSession: 새 주소를 저장할 콜백
  async function upload(blob, name, parentId, onProgress, session, onSession) {
    const size = blob.size;
    if (!session && size <= SIMPLE_MAX) return uploadSimple(blob, name, parentId, onProgress);
    let url = session || null;
    let offset = 0;
    if (url) {
      const st = await uploadedSoFar(url, size);
      if (st.done) return st.done;
      if (st.expired) url = null;
      else offset = st.offset;
    }
    if (!url) {
      url = await startSession(blob, name, parentId);
      if (onSession) await onSession(url);
    }
    for (;;) {
      const end = Math.min(offset + CHUNK, size);
      const res = await xhrRequest('PUT', url, {
        'Content-Range': size ? `bytes ${offset}-${end - 1}/${size}` : 'bytes */0'

      }, blob.slice(offset, end), (loaded) => onProgress && onProgress((offset + loaded) / size));
      if (res.status === 200 || res.status === 201) {
        if (onProgress) onProgress(1);
        return JSON.parse(res.text);
      }
      if (res.status === 308) { offset = nextOffset(res); continue; }
      if (res.status === 404 || res.status === 410) {
        if (onSession) await onSession(null);
        const err = new Error('업로드가 만료돼 처음부터 다시 올려요');
        err.restart = true;
        throw err;
      }
      throw driveError(res.status, res.text);
    }
  }

  // 휴대폰에서 원본이 지워진 사진을 크게 볼 때 드라이브에서 받아온다
  async function download(fileId) {
    if (!hasToken()) throw new AuthError('token');
    const res = await fetch(API + '/files/' + fileId + '?alt=media', { headers: { Authorization: 'Bearer ' + token.value } });
    if (res.status === 401) { clearToken(); throw new AuthError('token'); }
    if (!res.ok) throw new Error('드라이브에서 불러오지 못했어요');
    return res.blob();
  }

  window.Drive = {
    AuthError, isConfigured, rootName, allowedDomain, isAllowedAccount, hasToken, connect, disconnect,
    userInfo, ensureRoot, ensureFolder, listFolders, listFiles, upload, download, forgetVerified
  };
})();
