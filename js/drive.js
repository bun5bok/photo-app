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

  function upload(blob, name, parentId, onProgress) {
    if (!hasToken()) return Promise.reject(new AuthError('token'));
    const boundary = 'foldercam' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [parentId] });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
      `--${boundary}\r\nContent-Type: ${blob.type || 'image/jpeg'}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`
    ]);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', UPLOAD + '?uploadType=multipart&fields=id,name,webViewLink');
      xhr.setRequestHeader('Authorization', 'Bearer ' + token.value);
      xhr.setRequestHeader('Content-Type', 'multipart/related; boundary=' + boundary);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        if (xhr.status === 401) { clearToken(); return reject(new AuthError('token')); }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(JSON.parse(xhr.responseText));
        let msg = String(xhr.status);
        try { msg = JSON.parse(xhr.responseText).error.message; } catch (e) { /* 무시 */ }
        const err = new Error('드라이브 오류: ' + msg);
        err.status = xhr.status;
        reject(err);
      };
      xhr.onerror = () => { const err = new Error('네트워크 오류'); err.network = true; reject(err); };
      xhr.send(body);
    });
  }

  window.Drive = {
    AuthError, isConfigured, rootName, allowedDomain, isAllowedAccount, hasToken, connect, disconnect,
    userInfo, ensureRoot, ensureFolder, listFolders, upload, forgetVerified
  };
})();
