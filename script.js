// ===== Hardcoded Google Sheet with row-synced deletes =====
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com"; // paste yours
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

// HARDCODE YOUR SHEET ID (between /d/ and /edit in the URL)
const SPREADSHEET_ID = "173gOcUfK1Ff5JEPurWfGdSbZ8TF57laoczzwc_QumQQ";
const SHEET_RANGE = "Sheet1!A:C"; // Date, Name, Amount

// Allow a per-device override via localStorage (set by "Use a new Google Sheet")
const LS_KEY_SHEET_OVERRIDE = "sheetOverride";
let SPREADSHEET_ID = localStorage.getItem(LS_KEY_SHEET_OVERRIDE) || DEFAULT_SPREADSHEET_ID;

// Local model: { name, amount, date, row? }
let purchases = JSON.parse(localStorage.getItem("purchases")) || [];
let burnupChart;
let tokenClient;
let gapiReady = false;
let gisReady = false;

/* ---------- Menu + pages ---------- */
function toggleMenu(){
  const m = document.getElementById('sideMenu');
  const open = m.classList.toggle('open');
  m.setAttribute('aria-hidden', open ? 'false' : 'true');
}
function goPage(name){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(`page-${name}`).classList.add('active');
}

/* ---------- Modal (new sheet) ---------- */
function openNewSheetModal(){
  document.getElementById('sheetIdInput').value = SPREADSHEET_ID || '';
  document.getElementById('modalOverlay').hidden = false;
}
function closeNewSheetModal(){
  document.getElementById('modalOverlay').hidden = true;
}
function confirmNewSheet(){
  const val = (document.getElementById('sheetIdInput').value || '').trim();
  if(!val){ alert("Please paste a Spreadsheet ID."); return; }
  if(!confirm("Switch to this Google Sheet for this device? Your local data stays the same.")) return;
  localStorage.setItem(LS_KEY_SHEET_OVERRIDE, val);
  SPREADSHEET_ID = val;
  closeNewSheetModal();
  setSyncStatus(`Now using sheet: ${val.slice(0,8)}…`, "ok");
}

/* ---------- UI helpers ---------- */
function setSyncStatus(msg, cls = "") {
  const el = document.getElementById("syncStatus");
  if (!el) return;
  el.className = "status " + cls;
  el.textContent = msg;
}
function saveLocal() {
  localStorage.setItem("purchases", JSON.stringify(purchases));
}

/* ---------- Render ---------- */
function renderPurchases() {
  const list = document.getElementById("purchaseList");
  const totalDisplay = document.getElementById("totalSpent");
  list.innerHTML = "";
  let total = 0;

  purchases.forEach((p, i) => {
    total += parseFloat(p.amount || 0);
    const row = document.createElement("div");
    row.className = "purchase-item";
    row.innerHTML = `
      <div class="purchase-name">${p.date} - ${p.name}</div>
      <div class="purchase-amount">$${Number(p.amount).toFixed(2)}</div>
      <button class="delete-btn" title="Delete" onclick="deletePurchase(${i})">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;
    list.appendChild(row);
  });

  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  saveLocal();
  updateBurnupChart();
}

function updateBurnupChart() {
  const ctx = document.getElementById("burnupChart").getContext("2d");
  const sorted = [...purchases].sort((a, b) => new Date(a.date) - new Date(b.date));
  let labels = [], data = [], sum = 0;
  sorted.forEach((p) => { sum += parseFloat(p.amount || 0); labels.push(p.date); data.push(+sum.toFixed(2)); });
  if (burnupChart) burnupChart.destroy();
  burnupChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: "Cumulative Spending", data, fill: false }] },
    options: { responsive: true },
  });
}

/* ---------- Add / Delete / Clear ---------- */
async function addPurchase() {
  const name = document.getElementById("itemName").value.trim();
  const amount = document.getElementById("itemAmount").value;
  const date = document.getElementById("itemDate").value;
  if (!name || !amount || !date) { alert("Please fill out all fields"); return; }

  const purchase = { name, amount, date };

  // Clear inputs early for snappy feel
  document.getElementById("itemName").value = "";
  document.getElementById("itemAmount").value = "";
  document.getElementById("itemDate").value = "";

  purchases.push(purchase);
  renderPurchases();

  try {
    const rowNum = await appendRowToSheet(purchase);
    purchase.row = rowNum; // save 1-based row
    saveLocal();
    setSyncStatus("Synced ✓", "ok");
  } catch (e) {
    console.warn("Sync failed", e);
    setSyncStatus("Sync failed ✗", "err");
  }
}

async function deletePurchase(index) {
  const purchase = purchases[index];

  // Optimistic UI
  purchases.splice(index, 1);
  renderPurchases();

  try {
    await ensureSignedIn();

    // If we don't know the row yet, try to reconcile
    if (!purchase.row) {
      await reconcileLocalWithSheet();
    }

    if (purchase.row) {
      await deleteRowOnSheet(purchase.row);

      // Adjust remaining row numbers (rows below shift up by 1)
      purchases.forEach((p) => { if (p.row && p.row > purchase.row) p.row -= 1; });
      saveLocal();
      setSyncStatus("Deleted on sheet ✓", "ok");
    } else {
      setSyncStatus("Deleted locally (no matching sheet row found)", "ok");
    }
  } catch (e) {
    console.warn("Delete on sheet failed", e);
    setSyncStatus("Delete on sheet failed ✗", "err");
  }
}

/** Clear All: local only — DOES NOT touch Google Sheets. */
function clearPurchases() {
  if (!confirm("Clear all purchases on this device?\n\nThis will NOT delete anything from your Google Sheet.")) return;
  purchases = [];
  localStorage.removeItem("purchases");
  renderPurchases();
  setSyncStatus("Cleared locally ✓", "ok");
}

/* ---------- Google init / auth ---------- */
function initGapi() {
  return new Promise((resolve, reject) => {
    if (!window.gapi) return reject(new Error("gapi not loaded"));
    gapi.load("client", async () => {
      try {
        await gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] }); // no API key needed
        gapiReady = true;
        resolve();
      } catch (e) { reject(e); }
    });
  });
}
function initGIS() {
  if (!window.google || !google.accounts?.oauth2) throw new Error("GIS not loaded");
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: "",
    callback: (resp) => {
      if (resp.error) return;
      gapi.client.setToken({ access_token: resp.access_token });
      const btn = document.getElementById("googleSignInBtn");
      if (btn) btn.style.display = "none";
    },
  });
  gisReady = true;
}

async function googleSignIn() {
  if (!gapiReady || !gisReady) { alert("Still loading Google services. Try again in a second."); return; }
  tokenClient.requestAccessToken({ prompt: "consent" });
}

async function ensureSignedIn() {
  const token = gapi.client.getToken();
  if (token?.access_token) return;
  tokenClient.requestAccessToken({ prompt: "" });
  await new Promise((r) => setTimeout(r, 700));
}

/* ---------- Sheets helpers ---------- */
async function appendRowToSheet(p) {
  await ensureSignedIn();
  setSyncStatus("Syncing to Google Sheets…");
  const resp = await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [[p.date, p.name, p.amount]] },
  });
  const upd = resp.result && resp.result.updates;
  let rowNum = null;
  if (upd && upd.updatedRange) {
    const m = upd.updatedRange.match(/!A(\d+):/i); // e.g., "Sheet1!A2:C2"
    if (m) rowNum = parseInt(m[1], 10);
  }
  return rowNum;
}

async function deleteRowOnSheet(rowNumber1Based) {
  // Need the numeric sheetId for "Sheet1"
  const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (meta.result.sheets || []).find(s => s.properties?.title === "Sheet1");
  if (!sheet) throw new Error("Sheet1 not found");
  const sheetId = sheet.properties.sheetId;

  const req = {
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId, dimension: "ROWS", startIndex: rowNumber1Based - 1, endIndex: rowNumber1Based }
        }
      }]
    }
  };
  await gapi.client.sheets.spreadsheets.batchUpdate(req);
}

/** Reconcile local items (without `row`) to sheet rows (by date+name+amount). */
async function reconcileLocalWithSheet() {
  await ensureSignedIn();
  const resp = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A2:C",
  });
  const values = resp.result.values || [];
  const sheetRows = values.map((r, idx) => {
    const [date = "", name = "", amount = ""] = r;
    return { date: (date || "").trim(), name: (name || "").trim(), amount: normalizeAmount(amount), rowNumber: idx + 2, matched:false };
  });
  purchases.forEach(p => {
    if (p.row) return;
    const t = { date:(p.date||"").trim(), name:(p.name||"").trim(), amount:normalizeAmount(p.amount) };
    const found = sheetRows.find(s => !s.matched && s.date===t.date && s.name===t.name && s.amount===t.amount);
    if (found){ p.row = found.rowNumber; found.matched = true; }
  });
  saveLocal();
}

/* ---------- Utils ---------- */
function normalizeAmount(a){ const n = typeof a==="string" ? a.replace(/[, ]/g,"") : a; const num = Number(n || 0); return num.toFixed(2); }

/* ---------- Sign out & clear ---------- */
async function signOutAndClear(){
  try {
    const token = gapi.client.getToken();
    if (token?.access_token && google?.accounts?.oauth2?.revoke) {
      await new Promise(res => google.accounts.oauth2.revoke(token.access_token, res));
    }
  } catch {}
  gapi.client.setToken(null);
  localStorage.removeItem("purchases");
  localStorage.removeItem(LS_KEY_SHEET_OVERRIDE);
  purchases = [];
  SPREADSHEET_ID = DEFAULT_SPREADSHEET_ID;
  renderPurchases();
  const btn = document.getElementById("googleSignInBtn");
  if (btn) btn.style.display = "";
  setSyncStatus("Signed out & cleared this device", "ok");
}

/* ---------- Boot + token refresh ---------- */
window.addEventListener("load", async () => {
  try {
    await initGapi();
    initGIS();
    try {
      await ensureSignedIn();
      const btn = document.getElementById("googleSignInBtn");
      if (btn) btn.style.display = "none";
      await reconcileLocalWithSheet(); // attach rows to older local items
    } catch (_) { /* not signed in yet */ }
  } catch (e) {
    console.error("Init error", e);
    setSyncStatus("Init failed", "err");
  }
  renderPurchases();
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible") {
    try {
      await ensureSignedIn();
      const btn = document.getElementById("googleSignInBtn");
      if (btn) btn.style.display = "none";
    } catch (_) {}
  }
});
window.addEventListener("focus", async () => {
  try {
    await ensureSignedIn();
    const btn = document.getElementById("googleSignInBtn");
    if (btn) btn.style.display = "none";
  } catch (_) {}
});
