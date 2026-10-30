// 앱 화면 파일을 저장해 두어 인터넷이 없어도 앱이 열리게 한다 (사진 업로드는 앱 안 대기열이 담당)
const VERSION = 'photo-app-v8';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'manifest.webmanifest',
  'js/store.js',
  'js/drive.js',
  'js/uploader.js',
  'js/media-date.js',
  'js/camera.js',
  'js/app.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// GitHub Pages는 파일을 10분간 브라우저에 저장하라고 알려 준다.
// 그 저장본을 쓰면 수정이 늦게 보이므로, 항상 서버에 새 버전이 있는지 확인하고 받는다
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 같은 주소의 파일만: 네트워크를 먼저 쓰고, 안 되면(오프라인) 저장본을 쓴다
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});
