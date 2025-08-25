/* --- Firebase Messaging (Web Push) --- */
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ⬇️ Replace these with your Firebase web app config values
firebase.initializeApp({
  apiKey: "AIzaSyBVPS_83-sIyIOl9hDijMv6PrEk5ZEg6UU",
  authDomain: "purchase-tracker-870e3.firebaseapp.com",
  projectId: "purchase-tracker-870e3",
  messagingSenderId: "405147850307",
  appId: "1:405147850307:web:be83d37450cb8274f7e6f6",
});

const messaging = firebase.messaging();

// Shown when the app is in background or closed
messaging.onBackgroundMessage((payload) => {
  const title = payload?.notification?.title || 'Purchase Tracker';
  const body  = payload?.notification?.body  || 'Update';
  const data  = payload?.data || {};
  self.registration.showNotification(title, {
    body,
    icon: '/purchase-tracker/icons/icon-192.png',   // ← adjust for your repo path
    badge: '/purchase-tracker/icons/badge-72.png',  // ← adjust for your repo path
    data
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/<repo>/'; // ← adjust
  event.waitUntil(clients.openWindow(url));
});

/* --- your existing caching/offline SW code continues below --- */
*Above is the code for SMS*

const CACHE_NAME = "purchase-tracker-auto-sheet-v2"; // new cache name
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k))))
    )
  );
});

self.addEventListener("fetch", event => {
  event.respondWith(
    caches.match(event.request).then(resp => resp || fetch(event.request))
  );
});
