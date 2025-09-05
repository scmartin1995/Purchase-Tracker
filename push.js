/* /purchase-tracker/push.js
   Firebase Web Push (compat) — page logic
   Requires these script tags in your HTML before this file:
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
   <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js"></script>
*/

// ---- Firebase config (same as in firebase-messaging-sw.js) ----
const firebaseConfig = {
  apiKey: "AIzaSyBVPS_83-sIyIOl9hDijMv6PrEk5ZEg6UU",
  authDomain: "purchase-tracker-870e3.firebaseapp.com",
  projectId: "purchase-tracker-870e3",
  storageBucket: "purchase-tracker-870e3.firebasestorage.app",
  messagingSenderId: "405147850307",
  appId: "1:405147850307:web:be83d37450cb8274f7e6f6",
};

// Avoid double-init if script is included more than once
if (!firebase.apps?.length) {
  firebase.initializeApp(firebaseConfig);
}

const messaging = firebase.messaging();

// ---- Your PUBLIC VAPID key (Firebase Console → Cloud Messaging → Web configuration) ----
const VAPID_KEY = "BETwPkGxw_FnJF5PqJNjsLpNdMHZvOQNlekeYiTjp2Lwrx-c35doqh2-IGY9dbYholTzZZL1srUJdmfCyGk0yYQ";

// Derive the base path so this works at "/" or "/purchase-tracker/"
const basePath = location.pathname.startsWith('/purchase-tracker/') ? '/purchase-tracker/' : '/';

// Register the FCM service worker (robust: tries root, then /purchase-tracker/)
async function getSwReg() {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported in this browser.');
  }
  const candidates = [
    { script: '/firebase-messaging-sw.js', scope: '/' },
    { script: '/purchase-tracker/firebase-messaging-sw.js', scope: '/purchase-tracker/' },
  ];
  for (const c of candidates) {
    try {
      const reg = await navigator.serviceWorker.register(c.script, { scope: c.scope });
      return reg;
    } catch (_) {
      // keep trying the next candidate
    }
  }
  throw new Error('Could not find firebase-messaging-sw.js at / or /purchase-tracker/.');
}

// Ask permission + fetch/store token
async function enablePush() {
  try {
    if (!('Notification' in window)) {
      alert('Notifications are not supported in this browser.');
      return;
    }

    // Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      alert('Notifications are blocked. Please enable them in your browser settings.');
      return;
    }

    // Ensure SW is registered at the correct path/scope
    const swReg = await getSwReg();

    // Get an FCM token bound to this SW registration
    const token = await messaging.getToken({
      vapidKey: VAPID_KEY,                  // make sure VAPID_KEY is a QUOTED string above
      serviceWorkerRegistration: swReg,
    });

    if (!token) {
      alert('Failed to obtain a push token. See console for details.');
      return;
    }

    console.log('🔑 FCM token:', token);
    localStorage.setItem('fcmToken', token);
    alert('Push enabled! Token saved locally and printed in the console.');
  } catch (err) {
    console.error('enablePush error:', err);
    alert('Enable push failed — check the console for details.');
  }
}

// Handle foreground messages (when tab is focused)
messaging.onMessage((payload) => {
  console.log('📩 Foreground message:', payload);
  if (Notification.permission === 'granted') {
    try {
      const iconBase = (typeof basePath === 'string') ? basePath : '/';
      new Notification(payload.notification?.title || 'New message', {
        body: payload.notification?.body || '',
        icon: `${iconBase}icon-192.png`,
        data: payload.data || {},
      });
    } catch (_) {
      // Some browsers may restrict Notification from pages; you can show an in-app toast instead.
    }
  }
});

// OPTIONAL: helper to delete/refresh token for debugging
async function deletePushToken() {
  try {
    const currentToken = localStorage.getItem('fcmToken');
    if (currentToken) {
      await messaging.deleteToken(currentToken);
      localStorage.removeItem('fcmToken');
      console.log('🗑️ Deleted FCM token');
      alert('Push token deleted. Click "Enable Push Notifications" to get a new one.');
    }
  } catch (e) {
    console.warn('deletePushToken failed', e);
  }
}

// Expose functions to the page (for button onclick)
window.enablePush = enablePush;
window.deletePushToken = deletePushToken;
