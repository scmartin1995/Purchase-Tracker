/* /purchase-tracker/firebase-messaging-sw.js */
/* Firebase Cloud Messaging service worker (background notifications) */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ⬇️ Paste your Firebase web app config
firebase.initializeApp({
apiKey: "AIzaSyBVPS_83-sIyIOl9hDijMv6PrEk5ZEg6UU",
  authDomain: "purchase-tracker-870e3.firebaseapp.com",
  projectId: "purchase-tracker-870e3",
  storageBucket: "purchase-tracker-870e3.firebasestorage.app",
  messagingSenderId: "405147850307",
  appId: "1:405147850307:web:be83d37450cb8274f7e6f6"
};


const messaging = firebase.messaging();

// Show a system notification when a message arrives in the background
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || 'New message';
  const options = {
    body: payload.notification?.body || '',
    icon: '/purchase-tracker/icons/icon-192.png', // adjust if your icon lives elsewhere
    data: payload.data || {},
  };
  self.registration.showNotification(title, options);
});

// (Optional) Click to open your app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || '/purchase-tracker/';
  event.waitUntil(clients.openWindow(url));
});
