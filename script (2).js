// ===== Google / Sheets configuration =====
// NOTE: Move CLIENT_ID to a build-time env var if this repo is ever public.
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com";
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

const SHEET_TITLE = "Sheet1";
const SHEET_RANGE = `${SHEET_TITLE}!A:E`; // Date, Name, Amount, Category, UUID

const LS_KEY_SHEET_ID  = "userSheetId";
const LS_KEY_SHEET_GID = "userSheetGid";
const LS_KEY_TOKEN     = "gAccessToken";
const LS_KEY_TOKEN_EXP = "gAccessTokenExp";

let purchases   = JSON.parse(localStorage.getItem("purchases")) || [];
let tokenClient = null;
let gapiReady   = false;
let chartMonth  = "";

let SPREADSHEET_ID = localStorage.getItem(LS_KEY_SHEET_ID)  || null;
let SHEET_GID      = localStorage.getItem(LS_KEY_SHEET_GID) || null;

// ===== Helpers =====
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function esc(str) {
  const d = document.createElement("div");
  d.textContent = str ?? "";
  return d.innerHTML;
}

function todayStr() {
  return new Date().toLocaleDateString("en-CA");
}

function saveLocal() {
  localStorage.setItem("purchases", JSON.stringify(purchases));
}

// ===== UI helpers =====
const statusEl = () => document.getElementById("syncStatus");

function setSyncStatus(msg, cls = "") {
  const el = statusEl();
  if (!el) return;
  el.className = "status-pill " + cls;
  el.textContent = msg;
}

function showSheetHelper(show) {
  const el = document.getElementById("sheetHelper");
  if (el) el.style.display = show ? "block" : "none";
}

function toggleMenu() {
  const m    = document.getElementById("sideMenu");
  const open = m.classList.toggle("open");
  m.setAttribute("aria-hidden", open ? "false" : "true");
}

function goPage(name) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const target = document.getElementById(`page-${name}`);
  if (target) target.classList.add("active");
  if (name === "categories") renderCategorySummary();
}

// ===== Category pill class =====
function pillClass(category) {
  const map = {
    "Housing":       "pill-housing",
    "Utilities":     "pill-utilities",
    "Groceries":     "pill-groceries",
    "Dining Out":    "pill-dining",
    "Transportation":"pill-transportation",
    "Entertainment": "pill-entertainment",
    "Health":        "pill-health",
    "Debt":          "pill-debt",
    "Savings":       "pill-savings",
    "Other":         "pill-other",
  };
  return map[category] || "pill-uncategorized";
}

function barColor(category) {
  const map = {
    "Housing":       "var(--bar-housing)",
    "Utilities":     "var(--bar-utilities)",
    "Groceries":     "var(--bar-groceries)",
    "Dining Out":    "var(--bar-dining)",
    "Transportation":"var(--bar-transport)",
    "Entertainment": "var(--bar-entertainment)",
    "Health":        "var(--bar-health)",
    "Debt":          "var(--bar-debt)",
    "Savings":       "var(--bar-savings)",
    "Other":         "var(--bar-other)",
  };
  return map[category] || "var(--bar-other)";
}

// ===== Token persistence =====
function saveToken(tokenResp) {
  const expiry = Date.now() + (tokenResp.expires_in - 60) * 1000;
  localStorage.setItem(LS_KEY_TOKEN,     tokenResp.access_token);
  localStorage.setItem(LS_KEY_TOKEN_EXP, expiry.toString());
  gapi.client.setToken({ access_token: tokenResp.access_token });
}

function loadSavedToken() {
  const token  = localStorage.getItem(LS_KEY_TOKEN);
  const expiry = parseInt(localStorage.getItem(LS_KEY_TOKEN_EXP) || "0", 10);
  if (token && Date.now() < expiry) {
    gapi.client.setToken({ access_token: token });
    return true;
  }
  return false;
}

function clearToken() {
  localStorage.removeItem(LS_KEY_TOKEN);
  localStorage.removeItem(LS_KEY_TOKEN_EXP);
}

function isSignedIn() {
  const expiry = parseInt(localStorage.getItem(LS_KEY_TOKEN_EXP) || "0", 10);
  return !!localStorage.getItem(LS_KEY_TOKEN) && Date.now() < expiry;
}

function updateSignInButton() {
  const btn = document.getElementById("googleSignInBtn");
  if (!btn) return;
  btn.style.display = isSignedIn() ? "none" : "";
}

// ===== Hero block =====
function updateHero() {
  const labelEl  = document.getElementById("heroMonthLabel");
  const amountEl = document.getElementById("heroTotal");
  const subEl    = document.getElementById("heroSub");
  if (!labelEl || !amountEl) return;

  const now   = new Date();
  const thisM = now.toLocaleDateString("en-CA").slice(0, 7); // YYYY-MM
  const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toLocaleDateString("en-CA").slice(0, 7);

  const thisTotal = purchases
    .filter(p => p.date && p.date.startsWith(thisM))
    .reduce((s, p) => s + parseFloat(p.amount || 0), 0);

  const lastTotal = purchases
    .filter(p => p.date && p.date.startsWith(lastM))
    .reduce((s, p) => s + parseFloat(p.amount || 0), 0);

  const monthName = now.toLocaleString("default", { month: "long", year: "numeric" });
  labelEl.textContent  = monthName;
  amountEl.textContent = `$${thisTotal.toFixed(2)}`;

  if (lastTotal > 0) {
    const diff = thisTotal - lastTotal;
    const pct  = Math.abs((diff / lastTotal) * 100).toFixed(0);
    const sign = diff >= 0 ? "+" : "−";
    subEl.textContent = `${sign}$${Math.abs(diff).toFixed(2)} (${sign}${pct}%) vs last month`;
  } else {
    subEl.textContent = "\u00a0";
  }
}

// ===== Rendering =====
function renderPurchases() {
  const list         = document.getElementById("purchaseList");
  const totalDisplay = document.getElementById("totalSpent");
  if (!list || !totalDisplay) return;

  list.innerHTML = "";
  let total = 0;

  purchases.forEach((p, i) => {
    const amount = parseFloat(p.amount || 0);
    if (!Number.isFinite(amount)) return;
    total += amount;

    const row      = document.createElement("div");
    row.className  = "purchase-item";

    const catPill  = p.category
      ? `<span class="cat-pill ${pillClass(p.category)}">${esc(p.category)}</span>`
      : "";

    row.innerHTML = `
      <div class="p-left">
        <div class="p-name">${esc(p.name)}</div>
        <div class="p-meta">
          <span class="p-date">${esc(p.date)}</span>
          ${catPill}
        </div>
      </div>
      <div class="p-amount">$${amount.toFixed(2)}</div>
      <button class="act-btn" title="Edit" data-i="${i}">
        <span class="material-symbols-outlined">edit</span>
      </button>
      <button class="act-btn del" title="Delete" data-i="${i}">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;

    row.querySelector(".act-btn:not(.del)").addEventListener("click", () => openEditModal(i));
    row.querySelector(".act-btn.del").addEventListener("click", () => deletePurchase(i));

    list.appendChild(row);
  });

  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  saveLocal();
  updateHero();
  updateCategoryBars();
}

// ===== Category bar chart (replaces burn-up on home) =====
function buildMonthOptions() {
  const select = document.getElementById("chartMonthFilter");
  if (!select) return;
  const months  = new Set();
  purchases.forEach(p => { if (p.date?.length >= 7) months.add(p.date.slice(0, 7)); });
  const sorted  = [...months].sort().reverse();
  const current = select.value;
  select.innerHTML = `<option value="">All time</option>`;
  sorted.forEach(m => {
    const [y, mo] = m.split("-");
    const label   = new Date(y, parseInt(mo) - 1).toLocaleString("default", { month: "long", year: "numeric" });
    select.innerHTML += `<option value="${m}">${label}</option>`;
  });
  if (sorted.includes(current)) select.value = current;
  chartMonth = select.value;
}

function updateCategoryBars() {
  const container = document.getElementById("categoryBars");
  if (!container) return;

  buildMonthOptions();

  let filtered = [...purchases];
  if (chartMonth) filtered = filtered.filter(p => p.date?.startsWith(chartMonth));

  const totals = {};
  let grandTotal = 0;
  filtered.forEach(p => {
    const amt = parseFloat(p.amount || 0);
    if (!Number.isFinite(amt) || amt <= 0) return;
    const cat = p.category || "Other";
    totals[cat] = (totals[cat] || 0) + amt;
    grandTotal += amt;
  });

  container.innerHTML = "";
  if (grandTotal === 0) {
    container.innerHTML = `<p class="subtle">No purchases yet.</p>`;
    return;
  }

  Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .forEach(([cat, total]) => {
      const pct = (total / grandTotal) * 100;
      const row = document.createElement("div");
      row.className = "cat-bar-row";
      row.innerHTML = `
        <div class="cat-bar-name">${esc(cat)}</div>
        <div class="cat-bar-track">
          <div class="cat-bar-fill" style="width:${pct.toFixed(1)}%;background:${barColor(cat)};"></div>
        </div>
        <div class="cat-bar-val">$${total.toFixed(0)}</div>
      `;
      container.appendChild(row);
    });
}

// ===== Category summary page =====
function computeCategoryTotals() {
  const totals = {};
  let grandTotal = 0;
  purchases.forEach(p => {
    const amount = parseFloat(p.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) return;
    const cat    = p.category || "Uncategorized";
    totals[cat]  = (totals[cat] || 0) + amount;
    grandTotal  += amount;
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
  Object.entries(totals).sort((a, b) => b[1] - a[1]).forEach(([cat, total]) => {
    const tr  = document.createElement("tr");
    const pct = grandTotal ? (total / grandTotal) * 100 : 0;
    tr.innerHTML = `
      <td><span class="cat-pill ${pillClass(cat)}">${esc(cat)}</span></td>
      <td>$${total.toFixed(2)}</td>
      <td>${pct.toFixed(1)}%</td>
    `;
    tbody.appendChild(tr);
  });
}

// ===== Category guesser =====
function suggestCategory(name) {
  const n     = (name || "").toLowerCase();
  const rules = [
    { cat: "Groceries",      keywords: ["grocery","market","walmart","costco","smiths","kroger","aldi","whole foods","trader joe","safeway","albertsons"] },
    { cat: "Dining Out",     keywords: ["restaurant","grill","cafe","bar","mcdonald","taco","pizza","chipotle","sushi","diner","burrito","burger","kitchen"] },
    { cat: "Housing",        keywords: ["rent","mortgage","landlord","hoa","lease"] },
    { cat: "Utilities",      keywords: ["power","electric","gas bill","water bill","internet","comcast","xfinity","utility","spectrum","cox"] },
    { cat: "Transportation", keywords: ["uber","lyft","gas","fuel","diesel","bus","train","parking","toll","transit","shell","chevron","texaco"] },
    { cat: "Entertainment",  keywords: ["movie","cinema","netflix","hulu","spotify","concert","game","disney+","ticket","amazon prime","youtube"] },
    { cat: "Health",         keywords: ["pharmacy","walgreens","cvs","doctor","clinic","copay","gym","dental","vision","hospital","rx"] },
    { cat: "Debt",           keywords: ["loan","credit card","payment","collections","interest"] },
    { cat: "Savings",        keywords: ["savings","investment","brokerage","roth","401k","vanguard","fidelity","schwab"] },
  ];
  for (const rule of rules) {
    if (rule.keywords.some(k => n.includes(k))) return rule.cat;
  }
  return "Other";
}

// ===== Add purchase =====
async function addPurchase() {
  const nameInput      = document.getElementById("itemName");
  const amountInput    = document.getElementById("itemAmount");
  const dateInput      = document.getElementById("itemDate");
  const categorySelect = document.getElementById("itemCategory");

  const name      = nameInput.value.trim();
  const amountStr = amountInput.value;
  const date      = dateInput.value;
  let category    = (categorySelect?.value) || "";

  if (!name || !amountStr || !date) { alert("Please fill out all fields."); return; }

  const amount = parseFloat(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) { alert("Please enter a valid amount."); return; }

  const wasAuto = !category;
  if (!category) category = suggestCategory(name);

  const purchase = { id: genId(), name, amount, date, category };

  nameInput.value   = "";
  amountInput.value = "";
  dateInput.value   = todayStr();
  if (categorySelect) categorySelect.value = "";

  purchases.push(purchase);
  renderPurchases();

  if (wasAuto) setSyncStatus(`Auto-categorized as "${category}"`, "ok");

  if (isSignedIn()) {
    try {
      const rowNum  = await appendRowToSheet(purchase);
      purchase.row  = rowNum;
      saveLocal();
      setSyncStatus(`Saved & synced ✓${wasAuto ? ` — ${category}` : ""}`, "ok");
    } catch (e) {
      console.warn("Sync failed", e);
      purchases = purchases.filter(p => p.id !== purchase.id);
      renderPurchases();
      setSyncStatus("Sync failed — entry not saved ✗", "err");
    }
  } else {
    setSyncStatus(`Saved locally${wasAuto ? ` — auto: ${category}` : ""}`, "ok");
  }
}

// ===== Edit modal =====
function openEditModal(index) {
  const p = purchases[index];
  if (!p) return;
  document.getElementById("editModal")?.remove();

  const overlay   = document.createElement("div");
  overlay.id      = "editModal";
  overlay.className = "modal-bg";

  const cats = ["Housing","Utilities","Groceries","Dining Out","Transportation","Entertainment","Health","Debt","Savings","Other"];
  const options = cats.map(c => `<option value="${c}"${c === p.category ? " selected" : ""}>${c}</option>`).join("");

  overlay.innerHTML = `
    <div class="modal-box">
      <div class="card-label">Edit entry</div>
      <div class="input-grid" style="margin-bottom:8px;">
        <input id="e-name"   type="text"   value="${esc(p.name)}"          placeholder="Item name" />
        <input id="e-amount" type="number" value="${esc(String(p.amount))}" step="0.01" placeholder="$0.00" class="mono" />
        <input id="e-date"   type="date"   value="${esc(p.date)}"           class="mono" />
      </div>
      <div class="cat-row">
        <select id="e-cat">${options}</select>
      </div>
      <div class="btn-row" style="margin-top:14px;">
        <button class="btn-primary" id="e-save">Save</button>
        <button class="btn-ghost"   id="e-cancel">Cancel</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  overlay.querySelector("#e-cancel").addEventListener("click", () => overlay.remove());
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.remove(); });

  overlay.querySelector("#e-save").addEventListener("click", async () => {
    const newName   = overlay.querySelector("#e-name").value.trim();
    const newAmt    = parseFloat(overlay.querySelector("#e-amount").value);
    const newDate   = overlay.querySelector("#e-date").value;
    const newCat    = overlay.querySelector("#e-cat").value;

    if (!newName || !newDate) { alert("Please fill out all fields."); return; }
    if (!Number.isFinite(newAmt) || newAmt <= 0) { alert("Please enter a valid amount."); return; }

    const oldRow = p.row;
    p.name     = newName;
    p.amount   = newAmt;
    p.date     = newDate;
    p.category = newCat || suggestCategory(newName);
    renderPurchases();
    saveLocal();
    overlay.remove();

    if (isSignedIn() && oldRow) {
      try {
        await updateRowOnSheet(oldRow, p);
        setSyncStatus("Edit synced ✓", "ok");
      } catch (e) {
        console.warn("Edit sync failed", e);
        setSyncStatus("Edit saved locally — sheet sync failed ✗", "err");
      }
    } else {
      setSyncStatus("Edit saved locally", "ok");
    }
  });
}

// ===== Delete =====
async function deletePurchase(index) {
  const purchase = purchases[index];
  purchases.splice(index, 1);
  renderPurchases();

  if (!isSignedIn()) { setSyncStatus("Deleted locally", "ok"); return; }

  try {
    await ensureSheetInitialized();
    if (!purchase.row) await reconcileLocalWithSheet();
    if (purchase.row) {
      await deleteRowOnSheet(purchase.row);
      purchases.forEach(p => { if (p.row && p.row > purchase.row) p.row -= 1; });
      saveLocal();
      setSyncStatus("Deleted from sheet ✓", "ok");
    } else {
      setSyncStatus("Deleted locally — no sheet row found", "ok");
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

// ===== Google API init =====
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
  if (!window.google || !google.accounts?.oauth2) return;
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: "",
    callback: async (resp) => {
      if (resp.error) { console.warn("GIS token error", resp.error); setSyncStatus("Sign-in failed", "err"); return; }
      saveToken(resp);
      updateSignInButton();
      try {
        await ensureSheetInitialized();
        await reconcileLocalWithSheet();
        setSyncStatus("Signed in & synced ✓", "ok");
      } catch (e) {
        console.warn("Post sign-in setup failed", e);
        setSyncStatus("Could not set up Google Sheet", "err");
        showSheetHelper(true);
      }
    },
  });
}

async function googleSignIn() {
  if (!gapiReady) {
    try { await initGapi(); }
    catch (e) { alert("Google libraries failed to load. Check your network."); return; }
  }
  if (!tokenClient) initGIS();
  if (!tokenClient) { alert("Google sign-in is still starting up."); return; }
  const promptMode = SPREADSHEET_ID ? "" : "consent";
  tokenClient.requestAccessToken({ prompt: promptMode });
}

async function manualCreateSheet() {
  try {
    await ensureSheetInitialized(true);
    showSheetHelper(false);
    setSyncStatus("Sheet ready ✓", "ok");
  } catch (e) {
    setSyncStatus("Still couldn't create your Sheet. Check Google permissions.", "err");
  }
}

// ===== Sheet helpers =====
async function ensureSheetInitialized(forceCreate = false) {
  if (!SPREADSHEET_ID || forceCreate) {
    setSyncStatus("Creating your Google Sheet…");
    const { id, gid } = await createSpreadsheet();
    SPREADSHEET_ID = id;
    SHEET_GID      = gid;
    localStorage.setItem(LS_KEY_SHEET_ID,  SPREADSHEET_ID);
    localStorage.setItem(LS_KEY_SHEET_GID, SHEET_GID);
    await gapi.client.sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TITLE}!A1:E1`,
      valueInputOption: "RAW",
      resource: { values: [["Date","Name","Amount","Category","ID"]] }
    });
    setSyncStatus("Sheet created ✓", "ok");
  } else if (!SHEET_GID) {
    SHEET_GID = await fetchSheetGid();
    localStorage.setItem(LS_KEY_SHEET_GID, SHEET_GID);
  }
  return SPREADSHEET_ID;
}

async function createSpreadsheet() {
  const title = `Purchase Tracker (${new Date().toLocaleDateString()})`;
  const res   = await gapi.client.sheets.spreadsheets.create({
    properties: { title },
    sheets: [{ properties: { title: SHEET_TITLE } }]
  });
  return { id: res.result.spreadsheetId, gid: res.result.sheets[0].properties.sheetId };
}

async function fetchSheetGid() {
  const meta  = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const found = (meta.result.sheets || []).find(s => s.properties?.title === SHEET_TITLE);
  if (!found) throw new Error("Sheet1 not found");
  return found.properties.sheetId;
}

async function appendRowToSheet(p) {
  await ensureSheetInitialized();
  setSyncStatus("Syncing…");
  const resp = await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [[p.date, p.name, p.amount, p.category || "", p.id || ""]] },
  });
  const upd  = resp.result?.updates;
  let rowNum = null;
  if (upd?.updatedRange) {
    const m = upd.updatedRange.match(/!A(\d+):/i);
    if (m) rowNum = parseInt(m[1], 10);
  }
  return rowNum;
}

async function updateRowOnSheet(rowNumber, p) {
  await ensureSheetInitialized();
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TITLE}!A${rowNumber}:E${rowNumber}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [[p.date, p.name, p.amount, p.category || "", p.id || ""]] }
  });
}

async function deleteRowOnSheet(rowNumber1Based) {
  await ensureSheetInitialized();
  const sheetId = SHEET_GID || await fetchSheetGid();
  await gapi.client.sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: Number(sheetId),
            dimension: "ROWS",
            startIndex: rowNumber1Based - 1,
            endIndex: rowNumber1Based,
          }
        }
      }]
    }
  });
}

async function reconcileLocalWithSheet() {
  if (!SPREADSHEET_ID) return;
  const resp = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A2:E",
  });
  const values    = resp.result.values || [];
  const sheetRows = values.map((r, idx) => ({
    date:     (r[0] || "").trim(),
    name:     (r[1] || "").trim(),
    amount:   normalizeAmount(r[2]),
    category: (r[3] || "").trim(),
    uuid:     (r[4] || "").trim(),
    rowNumber: idx + 2,
    matched:  false,
  }));

  purchases.forEach(p => {
    if (p.row) return;
    let found = p.id ? sheetRows.find(s => !s.matched && s.uuid === p.id) : null;
    if (!found) {
      const t = { date: (p.date||"").trim(), name: (p.name||"").trim(), amount: normalizeAmount(p.amount) };
      found = sheetRows.find(s => !s.matched && s.date === t.date && s.name === t.name && s.amount === t.amount);
    }
    if (found) {
      p.row         = found.rowNumber;
      found.matched = true;
      if (!found.uuid && p.id && p.row) {
        gapi.client.sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_TITLE}!E${p.row}`,
          valueInputOption: "RAW",
          resource: { values: [[p.id]] }
        }).catch(() => {});
      }
    }
  });
  saveLocal();
}

function normalizeAmount(a) {
  const n   = typeof a === "string" ? a.replace(/[^0-9.\-]/g, "") : a;
  const num = Number(n || 0);
  return Number.isFinite(num) ? num.toFixed(2) : "0.00";
}

// ===== Sign out =====
async function signOutAndClear() {
  try {
    const token = gapi.client.getToken();
    if (token?.access_token && google?.accounts?.oauth2?.revoke) {
      await new Promise(res => google.accounts.oauth2.revoke(token.access_token, res));
    }
  } catch {}
  gapi.client.setToken(null);
  clearToken();
  localStorage.removeItem("purchases");
  localStorage.removeItem(LS_KEY_SHEET_ID);
  localStorage.removeItem(LS_KEY_SHEET_GID);
  purchases      = [];
  SPREADSHEET_ID = null;
  SHEET_GID      = null;
  renderPurchases();
  updateSignInButton();
  setSyncStatus("Signed out & cleared this device", "ok");
}

// ===== Boot =====
window.addEventListener("load", async () => {
  const dateInput = document.getElementById("itemDate");
  if (dateInput) dateInput.value = todayStr();

  const monthFilter = document.getElementById("chartMonthFilter");
  if (monthFilter) {
    monthFilter.addEventListener("change", () => {
      chartMonth = monthFilter.value;
      updateCategoryBars();
    });
  }

  try {
    try { await initGapi(); }
    catch (e) { console.warn("Initial gapi init failed; will retry on sign-in.", e); }
    initGIS();
  } catch (e) {
    console.error("Init error", e);
    setSyncStatus("Init failed", "err");
  }

  if (gapiReady && loadSavedToken()) {
    updateSignInButton();
    setSyncStatus("Restoring session…");
    try {
      await ensureSheetInitialized();
      await reconcileLocalWithSheet();
      setSyncStatus("Synced ✓", "ok");
    } catch (e) {
      console.warn("Auto-sync failed", e);
      setSyncStatus("Session restored — sync later", "");
    }
  } else {
    updateSignInButton();
  }

  renderPurchases();
});
