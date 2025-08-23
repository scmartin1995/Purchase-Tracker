/***** put your own values here *****/
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com";
const API_KEY = "AIzaSyCOYAn_Dq89tUBhusfo1DqhYNjABwLmWAg";
/***********************************/

const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";
const SHEET_RANGE = "Sheet1!A:C"; // Date, Name, Amount
const SHEET_ID_STORAGE_KEY = "userSheetId";

let purchases = JSON.parse(localStorage.getItem('purchases')) || [];
let burnupChart;
let tokenClient;
let gapiReady = false;
let gisReady = false;
let SPREADSHEET_ID = localStorage.getItem(SHEET_ID_STORAGE_KEY) || null;

/* ========== UI helpers ========== */
function setSyncStatus(msg, cls="") {
  const el = document.getElementById('syncStatus'); if (!el) return;
  el.className = 'sync-status ' + cls; el.textContent = msg;
}
function hideSignInButton(){ const b=document.getElementById('googleSignInBtn'); if(b) b.style.display='none'; }
function showSignInButton(){ const b=document.getElementById('googleSignInBtn'); if(b) b.style.display=''; }

/* ========== Render list + chart ========== */
function renderPurchases() {
  const list = document.getElementById('purchaseList');
  const totalDisplay = document.getElementById('totalSpent');
  list.innerHTML = '';
  let total = 0;
  purchases.forEach((p, i) => {
    total += parseFloat(p.amount);
    const row = document.createElement('div');
    row.className = 'purchase-item';
    row.innerHTML = `<span>${p.date} - ${p.name}</span>
                     <span>$${parseFloat(p.amount).toFixed(2)}</span>
                     <button onclick="deletePurchase(${i})">❌</button>`;
    list.appendChild(row);
  });
  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  localStorage.setItem('purchases', JSON.stringify(purchases));
  updateBurnupChart();
}
function updateBurnupChart() {
  const ctx = document.getElementById('burnupChart').getContext('2d');
  const sorted = [...purchases].sort((a,b)=> new Date(a.date)-new Date(b.date));
  let labels=[], data=[], sum=0;
  sorted.forEach(p=>{ sum+=parseFloat(p.amount); labels.push(p.date); data.push(+sum.toFixed(2)); });
  if (burnupChart) burnupChart.destroy();
  burnupChart = new Chart(ctx, {
    type:'line',
    data:{ labels, datasets:[{ label:'Cumulative Spending', data, fill:false, borderColor:'#0d1b2a', backgroundColor:'#1b263b', tension:.2 }]},
    options:{ responsive:true }
  });
}

/* ========== Buttons ========== */
function addPurchase() {
  const name = document.getElementById('itemName').value.trim();
  const amount = document.getElementById('itemAmount').value;
  const date = document.getElementById('itemDate').value;
  if (!name || !amount || !date) { alert('Please fill out all fields'); return; }
  const purchase = { name, amount, date };
  purchases.push(purchase);
  document.getElementById('itemName').value = '';
  document.getElementById('itemAmount').value = '';
  document.getElementById('itemDate').value = '';
  renderPurchases();
  appendRowToSheet(purchase)
    .then(()=> setSyncStatus('Synced ✓','ok'))
    .catch(()=> setSyncStatus('Sync failed ✗','err'));
}
function deletePurchase(i){ purchases.splice(i,1); renderPurchases(); }
function clearPurchases(){ if(confirm("Clear all purchases?")){ purchases=[]; localStorage.removeItem('purchases'); renderPurchases(); } }
async function resetSheet(){ localStorage.removeItem(SHEET_ID_STORAGE_KEY); SPREADSHEET_ID=null; await ensureSignedIn(); await ensureSheetInitialized(); setSyncStatus('New sheet linked ✓','ok'); }

/* ========== Google init ========== */
function initGapi() {
  return new Promise((resolve,reject)=>{
    if(!window.gapi) return reject(new Error("gapi not loaded"));
    gapi.load('client', async ()=>{
      try {
        await gapi.client.init({ apiKey: API_KEY || undefined, discoveryDocs:[DISCOVERY_DOC] });
        gapiReady = true; resolve();
      } catch(e){ reject(e); }
    });
  });
}
function initGIS() {
  if(!window.google || !google.accounts?.oauth2) throw new Error("GIS not loaded");
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: '',
    callback: (resp)=>{
      if(resp.error) return;
      gapi.client.setToken({ access_token: resp.access_token });
      hideSignInButton();
      ensureSheetInitialized().catch(()=>{});
    }
  });
  gisReady = true;
}

/* must be global so the button can call it */
async function googleSignIn() {
  if(!gapiReady || !gisReady){ alert("Still loading Google services. Try again in a second."); return; }
  // show Google consent once
  tokenClient.requestAccessToken({ prompt:'consent' });
}
window.googleSignIn = googleSignIn;

/* ========== Create + use personal sheet ========== */
async function createSpreadsheet() {
  const title = `Purchase Tracker (${new Date().toLocaleDateString()})`;
  // create a new spreadsheet in the user’s Drive
  const res = await gapi.client.sheets.spreadsheets.create({
    properties: { title }, sheets: [{ properties: { title: "Sheet1" } }]
  });
  const id = res.result.spreadsheetId;
  // add header row
  await gapi.client.sheets.spreadsheets.values.update({
    spreadsheetId: id,
    range: "Sheet1!A1:C1",
    valueInputOption: "RAW",
    resource: { values: [["Date","Name","Amount"]] }
  });
  return id;
}
async function ensureSheetInitialized(){
  if (SPREADSHEET_ID) return SPREADSHEET_ID;
  await ensureSignedIn();
  setSyncStatus('Creating your Google Sheet…');
  const id = await createSpreadsheet();
  SPREADSHEET_ID = id;
  localStorage.setItem(SHEET_ID_STORAGE_KEY, id);
  setSyncStatus('Sheet created ✓','ok');
  return id;
}
async function ensureSignedIn(){
  const token = gapi.client.getToken();
  if (token?.access_token) return;
  tokenClient.requestAccessToken({ prompt:'' }); // silent if you already granted once
  await new Promise(r=>setTimeout(r,700));
  const t = gapi.client.getToken();
  if (!t?.access_token) throw new Error("Not authorized");
}
async function appendRowToSheet(p){
  setSyncStatus('Syncing to Google Sheets…');
  await ensureSignedIn();
  await ensureSheetInitialized();
  const req = {
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [[p.date, p.name, p.amount]] }
  };
  return gapi.client.sheets.spreadsheets.values.append(req);
}

/* ========== start app ========== */
window.addEventListener('load', async ()=>{
  try {
    await initGapi(); initGIS();
    // try silent sign-in; if already granted, auto-prepare the sheet
    try { await ensureSignedIn(); hideSignInButton(); await ensureSheetInitialized(); }
    catch(_) { showSignInButton(); }
  } catch(e) { setSyncStatus('Init failed','err'); }
  renderPurchases();
});
