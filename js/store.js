// 로컬 저장소: 사진 대기열(IndexedDB) + 설정·폴더 목록(localStorage)
(function () {
  const DB_NAME = 'foldercam';
  const STORE = 'photos';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('createdAt', 'createdAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const os = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(os)).then((r) => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const photos = {
    put: (photo) => tx('readwrite', (os) => { os.put(photo); }),
    get: (id) => tx('readonly', (os) => reqToPromise(os.get(id))),
    remove: (id) => tx('readwrite', (os) => { os.delete(id); }),
    async all() {
      const list = await tx('readonly', (os) => reqToPromise(os.getAll()));
      return list.sort((a, b) => b.createdAt - a.createdAt);
    },
    async update(id, patch) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, 'readwrite');
        const os = t.objectStore(STORE);
        const g = os.get(id);
        let next = null;
        g.onsuccess = () => {
          if (!g.result) return;
          next = Object.assign({}, g.result, patch);
          os.put(next);
        };
        t.oncomplete = () => resolve(next);
        t.onerror = () => reject(t.error);
      });
    }
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

  const DEFAULT_SETTINGS = { useData: false, original: true, notify: true };

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
