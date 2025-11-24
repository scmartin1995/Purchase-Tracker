// ===== Per-user Sheet: auto-create on first sign-in (with drive.file scope & fallback button) =====
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com"; // <-- your client ID

const SCOPES = "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

const SHEET_TITLE = "Sheet1";
const SHEET_RANGE = `${SHEET_TITLE}!A:D`; // Date, Name, Amount, Category

const LS_KEY_SHEET_ID = "userSheetId";
const LS_KEY_SHEET_GID = "userSheetGid";
const LS_KEY_AUTH_SESSION = "authSessionExpiresAt";
const AUTH_SESSION_DAYS = 14;
const AUTH_SESSION_MS = AUTH_SESSION_DAYS * 24 * 60 * 60 * 1000;

let purchases = JSON.parse(localStorage.getItem("purchases")) || [];
let burnupChart;
let tokenClient;
let gapiReady = false;
let isExplicitLogin = false;

let SPREADSHEET_ID = localStorage.getItem(LS_KEY_SHEET_ID) || null;
let SHEET_GID = localStorage.getItem(LS_KEY_SHEET_GID) || null;

const statusEl = () => document.getElementById("syncStatus");
function setSyncStatus(msg, cls = "") {
  const el = statusEl();
  if (!el) return;
  el.className = "status " + cls;
  el.textContent = msg;
}
function showSheetHelper(show) {
  const el = document.getElementById("sheetHelper");
  if (el) el.style.display = show ? "block" : "none";
}
function saveLocal() {
  localStorage.setItem("purchases", JSON.stringify(purchases));
}
function isAuthSessionValid() {
  const raw = localStorage.getItem(LS_KEY_AUTH_SESSION);
  if (!raw) return false;
  const expiresAt = Number(raw);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}
function startAuthSessionWindow() {
  const expiresAt = Date.now() + AUTH_SESSION_MS;
  localStorage.setItem(LS_KEY_AUTH_SESSION, String(expiresAt));
}
function toggleMenu(){
  const m = document.getElementById('sideMenu');
  const open = m.classList.toggle('open');
  m.setAttribute('aria-hidden', open ? 'false' : 'true');
}
function goPage(name){
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const target = document.getElementById(`page-${name}`);
  if (target) target.classList.add('active');
  if (name === "categories") {
    renderCategorySummary();
  }
}

function renderPurchases() {
  const list = document.getElementById("purchaseList");
  const totalDisplay = document.getElementById("totalSpent");
  if (!list || !totalDisplay) return;

  list.innerHTML = "";
  let total = 0;

  purchases.forEach((p, i) => {
    const amount = parseFloat(p.amount || 0);
    if (!Number.isFinite(amount)) return;
    total += amount;
    const row = document.createElement("div");
    row.className = "purchase-item";
    const categoryLabel = p.category ? ` (${p.category})` : "";
    row.innerHTML = `
      <div class="purchase-name">${p.date} - ${p.name}${categoryLabel}</div>
      <div class="purchase-amount">$${amount.toFixed(2)}</div>
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
  const canvas = document.getElementById("burnupChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const sorted = [...purchases].sort((a, b) => new Date(a.date) - new Date(b.date));
  let labels = [], data = [], sum = 0;
  sorted.forEach((p) => {
    sum += parseFloat(p.amount || 0);
    labels.push(p.date);
    data.push(+sum.toFixed(2));
  });
  if (burnupChart) burnupChart.destroy();
  burnupChart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets: [{ label: "Cumulative Spending", data, fill: false }] },
    options: { responsive: true },
  });
}

function computeCategoryTotals() {
  const totals = {};
  let grandTotal = 0;
  purchases.forEach((p) => {
    const amount = parseFloat(p.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const cat = p.category || "Uncategorized";
    totals[cat] = (totals[cat] || 0) + amount;
    grandTotal += amount;
  });
  return { totals, grandTotal };
}

function renderCategorySummary() {
  const table = document.getElementById("categoryTable");
  if (!table) return;
  const tbody = table.querySelector("tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  const { totals, grandTotal } = computeCategoryTotals();
  const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  entries.forEach(([category, total]) => {
    const tr = document.createElement("tr");
    const pct = grandTotal ? (total / grandTotal) * 100 : 0;
    tr.innerHTML = `
      <td>${category}</td>
      <td>$${total.toFixed(2)}</td>
      <td>${pct.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

async function addPurchase() {
  const nameInput = document.getElementById("itemName");
  const amountInput = document.getElementById("itemAmount");
  const dateInput = document.getElementById("itemDate");
  const categorySelect = document.getElementById("itemCategory");

  const name = nameInput.value.trim();
  const amountStr = amountInput.value;
  const date = dateInput.value;
  const category = (categorySelect && categorySelect.value) || "Uncategorized";

  if (!name || !amountStr || !date) {
    alert("Please fill out all fields");
    return;
  }

  const amount = parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    alert("Please enter a valid amount");
    return;
  }

  const purchase = { name, amount, date, category };

  nameInput.value = "";
  amountInput.value = "";
  dateInput.value = "";
  if (categorySelect) categorySelect.value = "";

  purchases.push(purchase);
  renderPurchases();

  try {
    const rowNum = await appendRowToSheet(purchase);
    purchase.row = rowNum;
    saveLocal();
    setSyncStatus("Synced ✓", "ok");
  } catch (e) {
    console.warn("Sync failed", e);
    setSyncStatus("Sync failed ✗", "err");
  }
}

async function deletePurchase(index) {
  const purchase = purchases[index];
  purchases.splice(index, 1);
  renderPurchases();

  try {
    await ensureSheetInitialized();
    if (!purchase.row) {
      await reconcileLocalWithSheet();
    }
    if (purchase.row) {
      await deleteRowOnSheet(purchase.row);
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

function clearPurchases() {
  if (!confirm("Clear all purchases on this device?\n\nThis will NOT delete anything from your Google Sheet.")) return;
  purchases = [];
  localStorage.removeItem("purchases");
  renderPurchases();
  setSyncStatus("Cleared local data only", "ok");
}

function initGapi() {
  return new Promise((resolve, reject) => {
    if (!window.gapi) return reject(new Error("gapi not loaded"));
    gapi.load("client", async () => {
      try {
        await gapi.client.init({ discoveryDocs: [DISCOVERY_DOC] });
        gapiReady = true;
        resolve();
      } catch (e) { reject(e); }
    });
  });
}

function initGIS() {
  if (!window.google || !google.accounts?.oauth2) {
    console.warn("GIS not loaded yet; will try again on first sign-in click.");
    return;
  }

  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: "",
    callback: async (resp) => {
      if (resp.error) {
        console.warn("GIS token error", resp.error);
        isExplicitLogin = false;
        return;
      }
      gapi.client.setToken({ access_token: resp.access_token });
      if (isExplicitLogin) {
        startAuthSessionWindow();
        isExplicitLogin = false;
      }
      const btn = document.getElementById("googleSignInBtn");
      if (btn && isAuthSessionValid()) btn.style.display = "none";
      try {
        await ensureSheetInitialized();
      } catch (e) {
        console.warn("ensureSheetInitialized failed", e);
        setSyncStatus("Could not set up your Google Sheet", "err");
        showSheetHelper(true);
      }
    },
  });
}

async function googleSignIn() {
  if (!gapiReady) {
    alert("Still loading Google services. Try again in a second.");
    return;
  }

  if (!tokenClient) {
    initGIS();
  }

  if (!tokenClient) {
    alert("Google sign-in is still starting up. Try again in a second.");
    return;
  }

  isExplicitLogin = true;
  tokenClient.requestAccessToken({ prompt: "consent" });
}

async function ensureSignedIn() {
  if (!isAuthSessionValid()) return;
  const token = gapi.client.getToken();
  if (token?.access_token) return;

  if (!tokenClient) {
    initGIS();
  }
  if (!tokenClient) return;

  tokenClient.requestAccessToken({ prompt: "" });
  await new Promise((r) => setTimeout(r, 700));
}

async function manualCreateSheet(){
  try{
    await ensureSignedIn();
    await ensureSheetInitialized(true);
    showSheetHelper(false);
    setSyncStatus("Sheet ready ✓", "ok");
  }catch(e){
    console.warn("Manual sheet creation failed", e);
    setSyncStatus("Still couldn’t create your Sheet. Check Google permissions.", "err");
  }
}

async function ensureSheetInitialized(forceCreate=false){
  await ensureSignedIn();
  if (SPREADSHEET_ID && !forceCreate) {
    if (!SHEET_GID) {
      SHEET_GID = await fetchSheetGid();
      localStorage.setItem(LS_KEY_SHEET_GID, SHEET_GID);
    }
    return SPREADSHEET_ID;
  }
  setSyncStatus("Creating your Google Sheet…");
  const { id, gid } = await createSpreadsheet();
  SPREADSHEET_ID = id;
  SHEET_GID = gid;
  localStorage.setItem(LS_KEY_SHEET_ID, SPREADSHEET_ID);
  localStorage.setItem(LS_KEY_SHEET_GID, SHEET_GID);
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TITLE}!A1:D1`,
    valueInputOption: "RAW",
    resource: { values: [["Date","Name","Amount","Category"]] }
  });
  setSyncStatus("Sheet created ✓", "ok");
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

async function appendRowToSheet(p) {
  await ensureSheetInitialized();
  setSyncStatus("Syncing to Google Sheets…");
  const resp = await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [[p.date, p.name, p.amount, p.category || ""]] },
  });
  const upd = resp.result && resp.result.updates;
  let rowNum = null;
  if (upd && upd.updatedRange) {
    const m = upd.updatedRange.match(/!A(\d+):/i);
    if (m) rowNum = parseInt(m[1], 10);
  }
  return rowNum;
}

async function deleteRowOnSheet(rowNumber1Based) {
  await ensureSheetInitialized();
  const sheetId = SHEET_GID || await fetchSheetGid();
  const req = {
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: Number(sheetId),
            dimension: "ROWS",
            startIndex: rowNumber1Based - 1,
            endIndex: rowNumber1Based,
          },
        },
      }],
    },
  };
  await gapi.client.sheets.spreadsheets.batchUpdate(req);
}

async function reconcileLocalWithSheet() {
  await ensureSheetInitialized();
  const resp = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A2:D",
  });
  const values = resp.result.values || [];
  const sheetRows = values.map((r, idx) => {
    const [date = "", name = "", amount = ""] = r;
    return {
      date: (date || "").trim(),
      name: (name || "").trim(),
      amount: normalizeAmount(amount),
      rowNumber: idx + 2,
      matched: false,
    };
  });
  purchases.forEach((p) => {
    if (p.row) return;
    const t = {
      date: (p.date || "").trim(),
      name: (p.name || "").trim(),
      amount: normalizeAmount(p.amount),
    };
    const found = sheetRows.find(
      (s) => !s.matched && s.date === t.date && s.name === t.name && s.amount === t.amount
    );
    if (found) {
      p.row = found.rowNumber;
      found.matched = true;
    }
  });
  saveLocal();
}

function normalizeAmount(a){
  const n = typeof a === "string" ? a.replace(/[^0-9.\-]/g, "") : a;
  const num = Number(n || 0);
  return Number.isFinite(num) ? num.toFixed(2) : "0.00";
}

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
  localStorage.removeItem(LS_KEY_AUTH_SESSION);
  purchases = [];
  SPREADSHEET_ID = null;
  SHEET_GID = null;
  renderPurchases();
  const btn = document.getElementById("googleSignInBtn");
  if (btn) btn.style.display = "";
  setSyncStatus("Signed out & cleared this device", "ok");
}

window.addEventListener("load", async () => {
  try {
    await initGapi();
    initGIS();
    if (isAuthSessionValid()) {
      try {
        await ensureSignedIn();
        const btn = document.getElementById("googleSignInBtn");
        if (btn) btn.style.display = "none";
        await ensureSheetInitialized();
        await reconcileLocalWithSheet();
      } catch (_) {}
    } else {
      const btn = document.getElementById("googleSignInBtn");
      if (btn) btn.style.display = "";
    }
  } catch (e) {
    console.error("Init error", e);
    setSyncStatus("Init failed", "err");
  }
  renderPurchases();
});

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (!isAuthSessionValid()) return;
  try {
    await ensureSignedIn();
    const btn = document.getElementById("googleSignInBtn");
    if (btn) btn.style.display = "none";
  } catch (_) {}
});

window.addEventListener("focus", async () => {
  if (!isAuthSessionValid()) return;
  try {
    await ensureSignedIn();
    const btn = document.getElementById("googleSignInBtn");
    if (btn) btn.style.display = "none";
  } catch (_) {}
});
