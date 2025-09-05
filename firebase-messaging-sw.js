/* firebase-messaging-sw.js */
/* Firebase Cloud Messaging background handler */

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// IMPORTANT: plain straight quotes, no trailing commas
firebase.initializeApp({
  apiKey: "AIzaSyBVPS_83-sIyIOl9hDijMv6PrEk5ZEg6UU",
  authDomain: "purchase-tracker-870e3.firebaseapp.com",
  projectId: "purchase-tracker-870e3",
  // Storage bucket isn't used for push; this is the common value format:
  storageBucket: "purchase-tracker-870e3.appspot.com",
  messagingSenderId: "405147850307",
  appId: "1:405147850307:web:be83d37450cb8274f7e6f6"
});

const messaging = firebase.messaging();

// Background messages (tab not focused or closed)
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "Purchase Tracker";
  const options = {
    body: payload.notification?.body || "",
    // Use your app’s actual path and icon file name/casing
    icon: "/Purchase-Tracker/icon-192.png",
    data: payload.data || {}
  };
  self.registration.showNotification(title, options);
});

// Click to open your app
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification?.data?.url || "/Purchase-Tracker/";
  event.waitUntil(clients.openWindow(url));
});
