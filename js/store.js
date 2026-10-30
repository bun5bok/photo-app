// 로컬 저장소: 사진 대기열(IndexedDB) + 설정·폴더 목록(localStorage)
(function () {
  const DB_NAME = 'foldercam';
  const STORE = 'photos';
  let dbPromise = null;

  // 아이폰 사파리는 앱이 얼었다 풀리면 보관함(IndexedDB) 연결이 끊겨, 그 뒤 요청이 영원히 응답하지 않을 때가 있다.
  // 그래서 연결이 끊기거나 시간 안에 끝나지 않으면 연결을 버리고 새로 연다
  function resetDb() {
    const old = dbPromise;
    dbPromise = null;
    if (old) old.then((db) => { try { db.close(); } catch (e) { /* 무시 */ } }).catch(() => {});
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    const p = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onclose = () => { if (dbPromise === p) dbPromise = null; };
        db.onversionchange = () => { db.close(); if (dbPromise === p) dbPromise = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('보관함이 잠겨 있어요'));
    });
    dbPromise = p;
    p.catch(() => { if (dbPromise === p) dbPromise = null; });
    return p;
  }

  // body(os, out): 요청을 만들고 결과는 out.value에 넣는다. 트랜잭션이 끝나면 out.value를 돌려준다
  function runOnce(mode, body, ms) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(STORE, mode);
      } catch (e) {
        return reject(e); // 연결이 이미 닫힘 (InvalidStateError)
      }
      const out = { value: undefined };
      const timer = setTimeout(() => {
        try { t.abort(); } catch (e) { /* 무시 */ }
        const err = new Error('보관함 응답 없음');
        err.dbTimeout = true;
        reject(err);
      }, ms);
      t.oncomplete = () => { clearTimeout(timer); resolve(out.value); };
      t.onerror = () => { clearTimeout(timer); reject(t.error); };
      t.onabort = () => { clearTimeout(timer); reject(t.error || new Error('abort')); };
      body(t.objectStore(STORE), out);
    }));
  }

  async function run(mode, body) {
    const ms = mode === 'readwrite' ? 30000 : 10000; // 큰 동영상 저장은 시간이 걸린다
    try {
      return await runOnce(mode, body, ms);
    } catch (e) {
      // 한 번은 연결을 새로 열고 다시 시도한다
      resetDb();
      return runOnce(mode, body, ms);
    }
  }

  const photos = {
    put: (photo) => run('readwrite', (os) => { os.put(photo); }),
    get: (id) => run('readonly', (os, out) => { const r = os.get(id); r.onsuccess = () => { out.value = r.result; }; }),
    remove: (id) => run('readwrite', (os) => { os.delete(id); }),
    async all() {
      const list = await run('readonly', (os, out) => { const r = os.getAll(); r.onsuccess = () => { out.value = r.result || []; }; });
      return (list || []).sort((a, b) => b.createdAt - a.createdAt);
    },
    update: (id, patch) => run('readwrite', (os, out) => {
      out.value = null;
      const g = os.get(id);
      g.onsuccess = () => {
        if (!g.result) return;
        out.value = Object.assign({}, g.result, patch);
        os.put(out.value);
      };
    }),
    reset: resetDb
  };

  function readJson(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 저장 공간 없음 */ }
  }

  const DEFAULT_SETTINGS = { useData: false, original: true, notify: true, keepAwake: true };

  window.Store = {
    photos,
    getSettings: () => Object.assign({}, DEFAULT_SETTINGS, readJson('fc.settings', {})),
    setSettings: (s) => writeJson('fc.settings', s),
    getFolders: () => readJson('fc.folders', []),
    setFolders: (f) => writeJson('fc.folders', f),
    getCurrent: () => readJson('fc.current', null),
    setCurrent: (id) => writeJson('fc.current', id),
    getAccount: () => readJson('fc.account', null),
    setAccount: (a) => (a ? writeJson('fc.account', a) : localStorage.removeItem('fc.account')),
    getRoot: () => readJson('fc.root', null),
    setRoot: (r) => (r ? writeJson('fc.root', r) : localStorage.removeItem('fc.root')),
    uid: () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2))
  };
})();
