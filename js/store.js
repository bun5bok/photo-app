// 로컬 저장소: 사진 대기열(IndexedDB) + 설정·폴더 목록(localStorage)
(function () {
  const DB_NAME = 'foldercam';
  const STORE = 'photos'; // 사진 정보 (이름, 폴더, 상태, 미리보기 …)
  const DATA = 'data';    // 사진·동영상 원본 바이트 (id 별로 따로)
  let dbPromise = null;

  // 아이폰 사파리는 보관함에 Blob(파일)을 그대로 넣으면 나중에 그 파일을 읽지 못할 때가 있다.
  // 그래서 원본은 ArrayBuffer(순수 바이트)로 바꿔 별도 저장소에 넣고, 꺼낼 때 새 Blob으로 만든다.
  // 원본을 따로 두면 목록을 읽을 때 큰 동영상까지 메모리에 올리지 않아도 된다.

  // 아이폰 사파리는 앱이 얼었다 풀리면 보관함 연결이 끊겨, 그 뒤 요청이 영원히 응답하지 않을 때가 있다.
  // 그래서 연결이 끊기거나 시간 안에 끝나지 않으면 연결을 버리고 새로 연다
  function resetDb() {
    const old = dbPromise;
    dbPromise = null;
    if (old) old.then((db) => { try { db.close(); } catch (e) { /* 무시 */ } }).catch(() => {});
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    const p = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA, { keyPath: 'id' });
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

  // body(t, out): 요청을 만들고 결과는 out.value에 넣는다. 트랜잭션이 끝나면 out.value를 돌려준다
  function runOnce(mode, stores, body, ms) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      let t;
      try {
        t = db.transaction(stores, mode);
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
      body(t, out);
    }));
  }

  async function run(mode, stores, body) {
    const ms = mode === 'readwrite' ? 60000 : 15000; // 큰 동영상 저장은 시간이 걸린다
    try {
      return await runOnce(mode, stores, body, ms);
    } catch (e) {
      // 한 번은 연결을 새로 열고 다시 시도한다
      resetDb();
      return runOnce(mode, stores, body, ms);
    }
  }

  // 사진 정보에서 원본(blob)을 떼어 낸다
  function meta(photo) {
    const m = Object.assign({}, photo);
    delete m.blob;
    return m;
  }

  const photos = {
    // 원본이 있으면 바이트로 바꿔 함께 저장한다 (변환은 트랜잭션 밖에서 미리)
    async put(photo) {
      let data = null;
      if (photo.blob) {
        const buf = await photo.blob.arrayBuffer();
        data = { id: photo.id, buf, type: photo.blob.type || '' };
      }
      const m = meta(photo);
      if (data) m.hasData = true;
      return run('readwrite', [STORE, DATA], (t) => {
        t.objectStore(STORE).put(m);
        if (data) t.objectStore(DATA).put(data);
      });
    },
    get: (id) => run('readonly', [STORE], (t, out) => { const r = t.objectStore(STORE).get(id); r.onsuccess = () => { out.value = r.result; }; }),
    remove: (id) => run('readwrite', [STORE, DATA], (t) => { t.objectStore(STORE).delete(id); t.objectStore(DATA).delete(id); }),
    async all() {
      const list = await run('readonly', [STORE], (t, out) => { const r = t.objectStore(STORE).getAll(); r.onsuccess = () => { out.value = r.result || []; }; });
      return (list || []).sort((a, b) => b.createdAt - a.createdAt);
    },
    // patch에 blob: null이 있으면 원본을 지운다 (업로드가 끝난 뒤 저장 공간 아끼기)
    update: (id, patch) => run('readwrite', [STORE, DATA], (t, out) => {
      out.value = null;
      const p = Object.assign({}, patch);
      const dropData = 'blob' in p && !p.blob;
      delete p.blob;
      if (dropData) { p.hasData = false; t.objectStore(DATA).delete(id); }
      const os = t.objectStore(STORE);
      const g = os.get(id);
      g.onsuccess = () => {
        if (!g.result) return;
        out.value = Object.assign({}, g.result, p);
        if (dropData) delete out.value.blob;
        os.put(out.value);
      };
    }),
    // 원본을 새 Blob으로 꺼낸다 (예전 방식으로 저장된 것은 그대로 돌려준다)
    getData: (id) => run('readonly', [STORE, DATA], (t, out) => {
      out.value = null;
      const d = t.objectStore(DATA).get(id);
      d.onsuccess = () => {
        if (d.result && d.result.buf) {
          out.value = new Blob([d.result.buf], { type: d.result.type });
          return;
        }
        const r = t.objectStore(STORE).get(id);
        r.onsuccess = () => { out.value = (r.result && r.result.blob) || null; };
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
