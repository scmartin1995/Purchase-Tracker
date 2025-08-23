// ======= CONFIG (Client ID only; API key not required) =======
const CLIENT_ID = "YOUR_OAUTH_CLIENT_ID.apps.googleusercontent.com"; // <-- put yours
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";
const SHEET_TITLE = "Sheet1";
const SHEET_RANGE = `${SHEET_TITLE}!A:C`; // Date, Name, Amount
const LS_KEY_SHEET_ID = "userSheetId";
const LS_KEY_SHEET_GID = "userSheetGid";
// =============================================================

let purchases = JSON.parse(localStorage.getItem('purchases')) || []; // {name, amount, date, row?}
let burnupChart;
let tokenClient;
let gapiReady = false, gisReady = false;
let SPREADSHEET_ID = localStorage.getItem(LS_KEY_SHEET_ID) || null;
let SHEET_GID = localStorage.getItem(LS_KEY_SHEET_GID) || null; // numeric sheetId

/* ---------------- UI + Navigation ---------------- */
function toggleMenu(){
  const m = document.getElementById('sideMenu');
  const open = m.classList.toggle('open');
  m.setAttribute('aria-hidden', open ? 'false' : 'true');
}
function goPage(where){
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.getElementById(`page-${where}`).classList.add('active');
}

/* ---------------- Helpers ---------------- */
function setSyncStatus(msg, cls=""){ const el=document.getElementById('syncStatus'); if(!el) return; el.className='sync-status '+cls; el.textContent=msg; }
function hideSignInButton(){ const b=document.getElementById('googleSignInBtn'); if(b) b.style.display='none'; }
function showSignInButton(){ const b=document.getElementById('googleSignInBtn'); if(b) b.style.display=''; }

/* ---------------- Render ---------------- */
function renderPurchases(){
  const list = document.getElementById('purchaseList');
  const totalDisplay = document.getElementById('totalSpent');
  list.innerHTML = '';
  let total = 0;

  purchases.forEach((p, i) => {
    total += parseFloat(p.amount || 0);
    const row = document.createElement('div');
    row.className = 'purchase-item';
    row.innerHTML = `
      <div class="purchase-main">
        <div class="purchase-name">${p.date} - ${p.name}</div>
        <div class="purchase-amount">$${Number(p.amount).toFixed(2)}</div>
        <button class="delete-btn" title="Delete" onclick="deletePurchase(${i})">✖</button>
      </div>
    `;
    list.appendChild(row);
  });

  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  localStorage.setItem('purchases', JSON.stringify(purchases));
  updateBurnupChart();
}

function updateBurnupChart(){
  const ctx = document.getElementById('burnupChart').getContext('2d');
  const sorted = [...purchases].sort((a,b)=> new Date(a.date)-new Date(b.date));
  let labels=[], data=[], sum=0;
  sorted.forEach(p=>{ sum += parseFloat(p.amount||0); labels.push(p.date); data.push(+sum.toFixed(2)); });
  if (burnupChart) burnupChart.destroy();
  burnupChart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{ label:'Cumulative Spending', data, fill:false, borderColor:'#0d1b2a', backgroundColor:'#1b263b', tension:.2 }]},
    options:{ responsive:true }
  });
}

/* ---------------- CRUD ---------------- */
function addPurchase(){
  const name = document.getElementById('itemName').value.trim();
  const amount = document.getElementById('itemAmount').value;
  const date = document.getElementById('itemDate').value;
  if(!name || !amount || !date){ alert('Please fill out all fields'); return; }
  const purchase = { name, amount, date };

  // Clear inputs early for snappy feel
  document.getElementById('itemName').value = '';
  document.getElementById('itemAmount').value = '';
  document.getElementById('itemDate').value = '';

  // Add locally
  purchases.push(purchase);
  renderPurchases();

  // Append to Sheets (get its row number), then store it
  appendRowToSheet(purchase).then(rowNum => {
    purchase.row = rowNum; // store 1-based row number in Sheet
    localStorage.setItem('purchases', JSON.stringify(purchases));
    setSyncStatus('Synced ✓','ok');
  }).catch(err => {
    console.warn('Sync failed', err);
    setSyncStatus('Sync failed ✗','err');
  });
}

function deletePurchase(index){
  const purchase = purchases[index];
  // Update local UI immediately
  purchases.splice(index, 1);
  renderPurchases();

  // If this item had a sheet row, delete row in Sheets
  if (purchase && purchase.row){
    deleteRowOnSheet(purchase.row)
      .then(()=> {
        // After deleting a row in the sheet, rows after it shift up by 1
        purchases.forEach(p => { if (p.row && p.row > purchase.row) p.row -= 1; });
        localStorage.setItem('purchases', JSON.stringify(purchases));
        setSyncStatus('Deleted on sheet ✓','ok');
      })
      .catch(err => {
        console.warn('Failed to delete on sheet', err);
        setSyncStatus('Delete on sheet failed ✗','err');
      });
  }
}

function clearPurchases(){
  if(!confirm("Clear all purchases on this device?\n\nThis will NOT delete anything from your Google Sheet.")) return;
  purchases = [];
  localStorage.removeItem('purchases');
  renderPurchases();
  setSyncStatus('Cleared locally ✓','ok');
}

/* ---------------- Google init ---------------- */
function initGapi(){
  return new Promise((resolve,reject)=>{
    if(!window.gapi) return reject(new Error("gapi not loaded"));
    gapi.load('client', async ()=>{
      try {
        await gapi.client.init({ discoveryDocs:[DISCOVERY_DOC] }); // API key not required for OAuth calls
        gapiReady = true; resolve();
      } catch(e){ reject(e); }
    });
  });
}
function initGIS(){
  if(!window.google || !google.accounts?.oauth2) throw new Error("GIS not loaded");
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: '', // silent refresh if consent already given
    callback: (resp)=>{
      if(resp.error) return;
      gapi.client.setToken({ access_token: resp.access_token });
      hideSignInButton();
      ensureSheetInitialized().catch(()=>{});
    }
  });
  gisReady = true;
}

/* must be global */
async function googleSignIn(){
  if(!gapiReady || !gisReady){ alert("Still loading Google services. Try again in a second."); return; }
  tokenClient.requestAccessToken({ prompt:'consent' }); // first-time explicit consent
}
window.googleSignIn = googleSignIn;

/* ---------------- Sheet helpers ---------------- */
async function ensureSignedIn(){
  const token = gapi.client.getToken();
  if (token?.access_token) return;
  tokenClient.requestAccessToken({ prompt:'' }); // silent
  await new Promise(r=>setTimeout(r,700));
  const t = gapi.client.getToken();
  if (!t?.access_token) throw new Error("Not authorized");
}

async function createSpreadsheet(){
  const title = `Purchase Tracker (${new Date().toLocaleDateString()})`;
  const res = await gapi.client.sheets.spreadsheets.create({
    properties: { title }, sheets: [{ properties: { title: SHEET_TITLE } }]
  });
  const id = res.result.spreadsheetId;
  const gid = res.result.sheets[0].properties.sheetId;
  // header row
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: id, range: `${SHEET_TITLE}!A1:C1`, valueInputOption: "RAW",
    resource: { values: [["Date","Name","Amount"]] }
  });
  return { id, gid };
}

async function fetchSheetMeta(){
  const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheets = meta.result.sheets || [];
  const found = sheets.find(s => s.properties.title === SHEET_TITLE);
  if (!found) throw new Error("Sheet1 not found");
  return found.properties.sheetId;
}

async function ensureSheetInitialized(){
  await ensureSignedIn();
  if (!SPREADSHEET_ID){
    setSyncStatus('Creating your Google Sheet…');
    const { id, gid } = await createSpreadsheet();
    SPREADSHEET_ID = id; SHEET_GID = gid;
    localStorage.setItem(LS_KEY_SHEET_ID, id);
    localStorage.setItem(LS_KEY_SHEET_GID, gid);
    setSyncStatus('Sheet created ✓','ok');
  }
  if (!SHEET_GID){
    SHEET_GID = await fetchSheetMeta();
    localStorage.setItem(LS_KEY_SHEET_GID, SHEET_GID);
  }
  return SPREADSHEET_ID;
}

async function appendRowToSheet(p){
  await ensureSheetInitialized();
  setSyncStatus('Syncing to Google Sheets…');
  const resp = await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [[p.date, p.name, p.amount]] }
  });
  const upd = resp.result && resp.result.updates;
  let rowNum = null;
  if (upd && upd.updatedRange){
    const m = upd.updatedRange.match(/!A(\d+):/i);
    if (m) rowNum = parseInt(m[1], 10);
  }
  return rowNum; // can be null if API response changes
}

async function deleteRowOnSheet(rowNumber1Based){
  if (!SHEET_GID) SHEET_GID = await fetchSheetMeta();
  const startIdx = rowNumber1Based - 1;
  const endIdx = rowNumber1Based;
  const req = {
    spreadsheetId: SPREADSHEET_ID,
    resource: {
      requests: [{
        deleteDimension: {
          range: { sheetId: Number(SHEET_GID), dimension: "ROWS", startIndex: startIdx, endIndex: endIdx }
        }
      }]
    }
  };
  await gapi.client.sheets.spreadsheets.batchUpdate(req);
}

/* ---------------- Extra UX: silent refresh when app gains focus ---------------- */
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    try { await ensureSignedIn(); hideSignInButton(); } catch (_) {}
  }
});
window.addEventListener('focus', async () => {
  try { await ensureSignedIn(); hideSignInButton(); } catch (_) {}
});

/* ---------------- New Sheet confirmation modal ---------------- */
function openNewSheetConfirm(){ document.getElementById('modalOverlay').hidden = false; }
function closeNewSheetConfirm(){ document.getElementById('modalOverlay').hidden = true; }
async function confirmNewSheet(){
  closeNewSheetConfirm();
  localStorage.removeItem(LS_KEY_SHEET_ID);
  localStorage.removeItem(LS_KEY_SHEET_GID);
  SPREADSHEET_ID = null; SHEET_GID = null;
  await ensureSheetInitialized();
  setSyncStatus('New sheet linked ✓','ok');
}

/* ---------------- Sign out & clear ---------------- */
async function signOutAndClear(){
  try {
    const token = gapi.client.getToken();
    if (token?.access_token && google?.accounts?.oauth2?.revoke) {
      await new Promise(res => google.accounts.oauth2.revoke(token.access_token, res));
    }
  } catch {}
  gapi.client.setToken(null);
  localStorage.removeItem('purchases');
  localStorage.removeItem(LS_KEY_SHEET_ID);
  localStorage.removeItem(LS_KEY_SHEET_GID);
  purchases = [];
  SPREADSHEET_ID = null; SHEET_GID = null;
  renderPurchases();
  showSignInButton();
  setSyncStatus('Signed out & cleared this device','ok');
}

/* ---------------- Boot ---------------- */
window.addEventListener('load', async ()=>{
  try {
    await initGapi();
    initGIS();
    try { await ensureSignedIn(); hideSignInButton(); await ensureSheetInitialized(); }
    catch(_) { showSignInButton(); }
  } catch(e) {
    console.error("Init error", e);
    setSyncStatus('Init failed','err');
  }
  renderPurchases();
});
