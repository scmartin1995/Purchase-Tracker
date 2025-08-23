/***** 🔧 CONFIG: fill these three from your Google project & Sheet *****/
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com";
const API_KEY = "AIzaSyCOYAn_Dq89tUBhusfo1DqhYNjABwLmWAg";
const SPREADSHEET_ID = "1GxeOVJ17au5QepGRuWU6JjORNYgN7Tk41wSsfWlKrWQ"
const SHEET_RANGE = "Sheet1!A:C"; // date, name, amount columns
/***********************************************************************/

const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

let purchases = JSON.parse(localStorage.getItem('purchases')) || [];
let burnupChart;
let tokenClient;
let gapiInited = false;
let gisInited = false;

/* ---------- UI RENDER ---------- */
function renderPurchases() {
  const list = document.getElementById('purchaseList');
  const totalDisplay = document.getElementById('totalSpent');
  list.innerHTML = '';
  let total = 0;

  purchases.forEach((p, index) => {
    total += parseFloat(p.amount);
    const div = document.createElement('div');
    div.className = 'purchase-item';
    div.innerHTML = `
      <span>${p.date} - ${p.name}</span>
      <span>$${parseFloat(p.amount).toFixed(2)}</span>
      <button onclick="deletePurchase(${index})">❌</button>
    `;
    list.appendChild(div);
  });

  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  localStorage.setItem('purchases', JSON.stringify(purchases));

  updateBurnupChart();
}

function updateBurnupChart() {
  const ctx = document.getElementById('burnupChart').getContext('2d');
  const sorted = [...purchases].sort((a, b) => new Date(a.date) - new Date(b.date));

  let labels = [];
  let cumulative = 0;
  let data = [];

  sorted.forEach(p => {
    cumulative += parseFloat(p.amount);
    labels.push(p.date);
    data.push(Number(cumulative.toFixed(2)));
  });

  if (burnupChart) burnupChart.destroy();

  burnupChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Cumulative Spending',
        data,
        fill: false,
        borderColor: '#0d1b2a',
        backgroundColor: '#1b263b',
        tension: 0.2
      }]
    },
    options: {
      responsive: true,
      plugins: { legend: { display: true } },
      scales: { x: { ticks: {} }, y: { ticks: {} } }
    }
  });
}

/* ---------- CRUD ---------- */
function addPurchase() {
  const name = document.getElementById('itemName').value.trim();
  const amount = document.getElementById('itemAmount').value;
  const date = document.getElementById('itemDate').value;
  if (!name || !amount || !date) {
    alert('Please fill out all fields');
    return;
  }
  const purchase = { name, amount, date };
  purchases.push(purchase);
  document.getElementById('itemName').value = '';
  document.getElementById('itemAmount').value = '';
  document.getElementById('itemDate').value = '';
  renderPurchases();
  // Try to sync; if not signed in yet, it will be queued by the user pressing Sign in
  appendRowToSheet(purchase).catch(err => console.warn('Sheets sync skipped:', err));
}

function deletePurchase(index) {
  purchases.splice(index, 1);
  renderPurchases();
}

function clearPurchases() {
  if (confirm("Are you sure you want to clear all purchases?")) {
    purchases = [];
    localStorage.removeItem('purchases');
    renderPurchases();
  }
}

/* ---------- GOOGLE AUTH + SHEETS ---------- */
// Load gapi client
function initializeGapiClient() {
  return new Promise((resolve, reject) => {
    gapi.load('client', async () => {
      try {
        await gapi.client.init({
          apiKey: API_KEY || undefined,
          discoveryDocs: [DISCOVERY_DOC],
        });
        gapiInited = true;
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Prepare the token client (Google Identity Services)
function initializeTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: '', // empty = silent if already consented for this origin
    callback: (resp) => {
      if (resp.error) {
        console.error('OAuth error:', resp);
        return;
      }
      // Attach the token to gapi for Sheets calls
      gapi.client.setToken({ access_token: resp.access_token });
      hideSignInButton(); // we have a token; hide the button
      console.log('Google token obtained.');
    },
  });
  gisInited = true;
}

function googleSignIn() {
  // Force prompt the first time to grant consent
  tokenClient.requestAccessToken({ prompt: 'consent' });
}

function ensureSignedIn() {
  return new Promise((resolve, reject) => {
    const token = gapi.client.getToken();
    if (token && token.access_token) {
      return resolve();
    }
    // Try silent token (no prompt) if already granted to this origin
    tokenClient.requestAccessToken({ prompt: '' });
    // Wait a tick for callback to set token
    setTimeout(() => {
      const t = gapi.client.getToken();
      t && t.access_token ? resolve() : reject(new Error('Not authorized'));
    }, 800);
  });
}

async function appendRowToSheet(purchase) {
  await ensureSignedIn(); // make sure we have a token (silent after first consent)

  const values = [[purchase.date, purchase.name, purchase.amount]];
  const request = {
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values }
  };
  return gapi.client.sheets.spreadsheets.values.append(request);
}

function hideSignInButton() {
  const btn = document.getElementById('googleSignInBtn');
  if (btn) btn.style.display = 'none';
}

/* ---------- BOOT ---------- */
window.addEventListener('load', async () => {
  try {
    await initializeGapiClient();
    initializeTokenClient();

    // If we can silently get a token (already consented once), do it and hide the button
    try {
      await ensureSignedIn();
      hideSignInButton();
    } catch (_) {
      // Not signed in yet; button stays visible until user taps it.
    }
  } catch (e) {
    console.error('Init error:', e);
  }

  renderPurchases();
});
