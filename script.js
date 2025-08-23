// ======= CONFIG (Client ID only; API key not required) =======
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com"; // <-- put yours
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";
const SHEET_RANGE = "Sheet1!A:C";

let purchases = JSON.parse(localStorage.getItem('purchases')) || [];
let burnupChart;
let tokenClient;
let gapiReady = false;
let gisReady = false;
let SPREADSHEET_ID = localStorage.getItem('userSheetId') || null;

function setSyncStatus(msg, cls="") {
  const el = document.getElementById('syncStatus');
  if (el) {
    el.className = 'sync-status ' + cls;
    el.textContent = msg;
  }
}

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

function deletePurchase(i){
  purchases.splice(i,1);
  renderPurchases();
}

function clearPurchases(){
  if(confirm("Clear all purchases? This won't delete data from Google Sheets.")){
    purchases = [];
    localStorage.removeItem('purchases');
    renderPurchases();
  }
}

function promptSheetId(){
  const id = prompt('Enter existing Google Sheet ID:');
  if(!id) return;
  SPREADSHEET_ID = id.trim();
  localStorage.setItem('userSheetId', SPREADSHEET_ID);
  setSyncStatus('Sheet ID saved','ok');
}
window.promptSheetId = promptSheetId;

function initGapi() {
  return new Promise((resolve,reject)=>{
    if(!window.gapi) return reject(new Error("gapi not loaded"));
    gapi.load('client', async ()=>{
      try {
        await gapi.client.init({ discoveryDocs:[DISCOVERY_DOC] });
        gapiReady = true; resolve();
      } catch(e){ reject(e); }
    });
  });
}

function initGIS() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    prompt: '',
    callback: (resp)=>{
      if(resp.error) return;
      gapi.client.setToken({ access_token: resp.access_token });
      document.getElementById('googleSignInBtn').style.display = 'none';
    }
  });
  gisReady = true;
}

async function googleSignIn() {
  if(!gapiReady || !gisReady){
    alert("Still loading Google services. Try again in a second.");
    return;
  }
  tokenClient.requestAccessToken({ prompt:'consent' });
}

async function ensureSignedIn(){
  const token = gapi.client.getToken();
  if (token?.access_token) return;
  await new Promise((resolve, reject) => {
    tokenClient.requestAccessToken({
      prompt: '',
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(resp.error ? new Error(resp.error) : new Error('No token'));
          return;
        }
        gapi.client.setToken({ access_token: resp.access_token });
        document.getElementById('googleSignInBtn').style.display = 'none';
        resolve();
      }
    });
  });
}

async function ensureSheetInitialized(){
  if (!SPREADSHEET_ID) throw new Error('No spreadsheet ID set');
  return SPREADSHEET_ID;
}

async function appendRowToSheet(p){
  await ensureSignedIn();
  await ensureSheetInitialized();
  return gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: { values: [[p.date, p.name, p.amount]] }
  });
}

window.addEventListener('load', async ()=>{
  try {
    await initGapi();
    initGIS();
    try {
      await ensureSignedIn();
      document.getElementById('googleSignInBtn').style.display='none';
      if(!SPREADSHEET_ID) setSyncStatus('No Google Sheet ID set','err');
    }
    catch(_) { document.getElementById('googleSignInBtn').style.display=''; }
  } catch(e) {
    console.error("Init error", e);
    setSyncStatus('Init failed','err');
  }
  renderPurchases();
});
