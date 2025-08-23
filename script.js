// ===== Per-user Sheet: auto-create on first sign-in =====
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com"; // <-- put yours
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

const SHEET_TITLE = "Sheet1";
const SHEET_RANGE = `${SHEET_TITLE}!A:C`; // Date, Name, Amount

// Local storage keys for the user's personal sheet
const LS_KEY_SHEET_ID = "userSheetId";
const LS_KEY_SHEET_GID = "userSheetGid";

// Local model: { name, amount, date, row? }
let purchases = JSON.parse(localStorage.getItem("purchases")) || [];
let burnupChart;
let tokenClient;
let gapiReady = false;
let gisReady = false;

let SPREADSHEET_ID = localStorage.getItem(LS_KEY_SHEET_ID) || null;
let SHEET_GID = localStorage.getItem(LS_KEY_SHEET_GID) || null; // numeric sheetId (gid)

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
    await ensureSheetInitialized(); // make sure we have IDs
    // If we don't know the row yet (older local entries), try to reconcile
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
      // after token, ensure sheet exists for this user/device
      ensureSheetInitialized().catch(()=>{});
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

/* ---------- Per-user Sheet helpers ---------- */
async function ensureSheetInitialized(){
  await ensureSignedIn();
  if (!SPREADSHEET_ID) {
    setSyncStatus("Creating your Google Sheet…");
    const { id, gid } = await createSpreadsheet();
    SPREADSHEET_ID = id;
    SHEET_GID = gid;
    localStorage.setItem(LS_KEY_SHEET_ID, id);
    localStorage.setItem(LS_KEY_SHEET_GID, gid);
    // Write header row
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TITLE}!A1:C1`,
      valueInputOption: "RAW",
      resource: { values: [["Date","Name","Amount"]] }
    });
    setSyncStatus("Sheet created ✓", "ok");
  }
  if (!SHEET_GID) {
    SHEET_GID = await fetchSheetGid();
    localStorage.setItem(LS_KEY_SHEET_GID, SHEET_GID);
  }
  return SPREADSHEET_ID;
}

async function createSpreadsheet(){
  const title = `Purchase Tracker (${new Date().toLocaleDateString()})`;
  const res = await gapi.client.sheets.spreadsheets.create({
    properties: { title },
    sheets: [{ properties: { title: SHEET_TITLE } }]
  });
  const id = res.result.spreadsheetId;
  const gid = res.result.sheets[0].properties.sheetId;
  return { id, gid };
}

async function fetchSheetGid(){
  const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const found = (meta.result.sheets || []).find(s => s.properties?.title === SHEET_TITLE);
  if (!found) throw new Error("Sheet1 not found");
  return found.properties.sheetId;
}

/* Append a row and return its 1-based row number if available */
async function appendRowToSheet(p) {
  await ensureSheetInitialized();
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

/* Delete a specific row */
async function deleteRowOnSheet(rowNumber1Based) {
  await ensureSheetInitialized();
  const sheetId = SHEET_GID || await fetchSheetGid();
  const req = {
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId: Number(sheetId), dimension: "ROWS", startIndex: rowNumber1Based - 1, endIndex: rowNumber1Based }
        }
      }]
    }
  };
  await gapi.client.sheets.spreadsheets.batchUpdate(req);
}

/* Match old local entries (without row) to sheet rows by (date,name,amount) */
async function reconcileLocalWithSheet() {
  await ensureSheetInitialized();
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
  localStorage.removeItem(LS_KEY_SHEET_ID);
  localStorage.removeItem(LS_KEY_SHEET_GID);
  purchases = [];
  SPREADSHEET_ID = null;
  SHEET_GID = null;
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
      await ensureSheetInitialized();
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
    try { await ensureSignedIn(); const btn = document.getElementById("googleSignInBtn"); if (btn) btn.style.display = "none"; } catch (_) {}
  }
});
window.addEventListener("focus", async () => {
  try { await ensureSignedIn(); const btn = document.getElementById("googleSignInBtn"); if (btn) btn.style.display = "none"; } catch (_) {}
});
