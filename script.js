// ===== Hardcoded Google Sheet with row-synced deletes =====
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com"; // paste yours
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

// HARDCODE YOUR SHEET ID (between /d/ and /edit in the URL)
const SPREADSHEET_ID = "173gOcUfK1Ff5JEPurWfGdSbZ8TF57laoczzwc_QumQQ";
const SHEET_RANGE = "Sheet1!A:C"; // Date, Name, Amount

// Local model: { name, amount, date, row? }
let purchases = JSON.parse(localStorage.getItem("purchases")) || [];
let burnupChart;
let tokenClient;
let gapiReady = false;
let gisReady = false;

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
  let labels = [],
    data = [],
    sum = 0;
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

/* ---------- Add / Delete / Clear ---------- */
async function addPurchase() {
  const name = document.getElementById("itemName").value.trim();
  const amount = document.getElementById("itemAmount").value;
  const date = document.getElementById("itemDate").value;
  if (!name || !amount || !date) {
    alert("Please fill out all fields");
    return;
  }

  const purchase = { name, amount, date };

  // Clear inputs early for snappy feel
  document.getElementById("itemName").value = "";
  document.getElementById("itemAmount").value = "";
  document.getElementById("itemDate").value = "";

  // Add locally & render
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

/**
 * Delete a single purchase locally AND remove its exact row from Google Sheets.
 * - If we don't know its row yet (older entries), we try to reconcile first.
 * - After deleting a row in the sheet, all rows below shift up by 1, so we
 *   adjust stored row numbers accordingly.
 */
async function deletePurchase(index) {
  const purchase = purchases[index];

  // Optimistically update UI
  purchases.splice(index, 1);
  renderPurchases();

  try {
    await ensureSignedIn();

    // If this item doesn't have a row stored yet, reconcile to find it
    if (!purchase.row) {
      await reconcileLocalWithSheet();
    }

    if (purchase.row) {
      await deleteRowOnSheet(purchase.row);

      // Adjust remaining row indices (rows after the deleted one shift up by 1)
      purchases.forEach((p) => {
        if (p.row && p.row > purchase.row) p.row -= 1;
      });
      saveLocal();
      setSyncStatus("Deleted on sheet ✓", "ok");
    } else {
      // Couldn't determine original row; sheet might not contain it (or duplicate ambiguity)
      setSyncStatus("Deleted locally (no matching row found)", "ok");
    }
  } catch (e) {
    console.warn("Failed to delete on sheet", e);
    setSyncStatus("Delete on sheet failed ✗", "err");
  }
}

/**
 * Clear All: local only — DOES NOT touch Google Sheets.
 * Handy for a new pay period while preserving historical sheet data.
 */
function clearPurchases() {
  if (
    !confirm(
      "Clear all purchases on this device?\n\nThis will NOT delete anything from your Google Sheet."
    )
  )
    return;
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
      } catch (e) {
        reject(e);
      }
    });
  });
}
function initGIS() {
  if (!window.google || !google.accounts?.oauth2) throw new Error("GIS not loaded");
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: "", // silent after first consent
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
  if (!gapiReady || !gisReady) {
    alert("Still loading Google services. Try again in a second.");
    return;
  }
  tokenClient.requestAccessToken({ prompt: "consent" });
}

async function ensureSignedIn() {
  const token = gapi.client.getToken();
  if (token?.access_token) return;
  tokenClient.requestAccessToken({ prompt: "" });
  await new Promise((r) => setTimeout(r, 700));
}

/* ---------- Sheets helpers ---------- */

/**
 * Append a row to the sheet and return its 1-based row number.
 */
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
    // e.g., "Sheet1!A2:C2" -> pick "2"
    const m = upd.updatedRange.match(/!A(\d+):/i);
    if (m) rowNum = parseInt(m[1], 10);
  }
  return rowNum;
}

/**
 * Delete a specific 1-based row from the sheet using batchUpdate.
 */
async function deleteRowOnSheet(rowNumber1Based) {
  // We need the numeric sheetId; get metadata for Sheet1
  const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheet = (meta.result.sheets || []).find(
    (s) => s.properties && s.properties.title === "Sheet1"
  );
  if (!sheet) throw new Error("Sheet1 not found");
  const sheetId = sheet.properties.sheetId;

  const req = {
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex: rowNumber1Based - 1, // zero-based inclusive
              endIndex: rowNumber1Based, // zero-based exclusive
            },
          },
        },
      ],
    },
  };
  await gapi.client.sheets.spreadsheets.batchUpdate(req);
}

/**
 * Reconcile local purchases without `row` against the current sheet rows,
 * matching on (Date, Name, Amount). Handles duplicates by assigning the
 * first unmatched matching row. Best-effort.
 */
async function reconcileLocalWithSheet() {
  await ensureSignedIn();
  // Read all rows (skip header): A2:C
  const resp = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: "Sheet1!A2:C",
  });
  const values = resp.result.values || [];

  // Build an index of rows -> { date, name, amount, rowNumber }
  const sheetRows = values.map((r, idx) => {
    const [date = "", name = "", amount = ""] = r;
    return {
      date: (date || "").trim(),
      name: (name || "").trim(),
      amount: normalizeAmount(amount),
      rowNumber: idx + 2, // A2 is row 2
      matched: false,
    };
  });

  // For each local item missing row, try to find the first unmatched identical triple
  purchases.forEach((p) => {
    if (p.row) return;
    const target = {
      date: (p.date || "").trim(),
      name: (p.name || "").trim(),
      amount: normalizeAmount(p.amount),
    };
    const found = sheetRows.find(
      (s) =>
        !s.matched &&
        s.date === target.date &&
        s.name === target.name &&
        s.amount === target.amount
    );
    if (found) {
      p.row = found.rowNumber;
      found.matched = true;
    }
  });

  saveLocal();
}

/* ---------- Utils ---------- */
function normalizeAmount(a) {
  const n = typeof a === "string" ? a.replace(/[, ]/g, "") : a;
  const num = Number(n || 0);
  return num.toFixed(2); // compare as fixed-2 strings
}

/* ---------- Boot ---------- */
window.addEventListener("load", async () => {
  try {
    await initGapi();
    initGIS();
    try {
      await ensureSignedIn();
      const btn = document.getElementById("googleSignInBtn");
      if (btn) btn.style.display = "none";

      // Best-effort reconciliation for older local items (ensures correct row deletes)
      await reconcileLocalWithSheet();
    } catch (_) {
      // Not signed in yet; that's fine.
    }
  } catch (e) {
    console.error("Init error", e);
    setSyncStatus("Init failed", "err");
  }
  renderPurchases();
});

/* ---------- Also refresh token silently on focus (helps PWAs) ---------- */
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
