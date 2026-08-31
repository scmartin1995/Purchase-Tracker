// ===== Google / Sheets configuration =====
// CLIENT_ID is NOT a secret and doesn't need hiding. A browser app's OAuth
// client ID ships to every visitor no matter where the source lives — it's
// readable in devtools on the live site whether this repo is public or not.
// What actually restricts it is the Authorized JavaScript origins allowlist
// in the Google Cloud Console, which is set to the Pages origin (verified
// 2026-08-30).
const CLIENT_ID = "624129803500-p9iq7i2mbngcr5ut675cg4n23mbhsajo.apps.googleusercontent.com";

// drive.file only — access to files this app created, not to every
// spreadsheet in the account. The broader `spreadsheets` scope was dropped as
// redundant: every Sheets call here (create, get, values.get/update/append,
// batchUpdate) accepts drive.file, each confirmed against Google's reference.
// drive.file is also the scope Google labels "Recommended, Non-sensitive",
// where `spreadsheets` is "Sensitive" — so the consent screen now asks for
// noticeably less.
const SCOPES = "https://www.googleapis.com/auth/drive.file";
const DISCOVERY_DOC = "https://sheets.googleapis.com/$discovery/rest?version=v4";

const SHEET_TITLE = "Sheet1";
const SHEET_RANGE = `${SHEET_TITLE}!A:E`; // Date, Name, Amount, Category, UUID

const LS_KEY_SHEET_ID  = "userSheetId";
const LS_KEY_SHEET_GID = "userSheetGid";
const LS_KEY_TOKEN     = "gAccessToken";
const LS_KEY_TOKEN_EXP = "gAccessTokenExp";

// Label for a purchase with no category. Deliberately NOT "Other" — that's a
// category the user can pick on purpose. This one means "we don't know".
const UNCATEGORIZED = "Uncategorized";

let purchases   = loadPurchases();
let tokenClient = null;
let gapiReady   = false;
let chartRange  = "";   // "" | "7d" | "14d" | "YYYY-MM" — see ROLLING_RANGES

let SPREADSHEET_ID = localStorage.getItem(LS_KEY_SHEET_ID)  || null;
let SHEET_GID      = localStorage.getItem(LS_KEY_SHEET_GID) || null;

// ===== Helpers =====
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Single definition of "an amount we'll display". Every total, bar, and table
// runs through this so they can't disagree about which entries count.
function isValidAmount(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0;
}

// Purchases are entered by hand and always positive — no refunds, no negatives.
// Anything else in storage is legacy or corrupt, so drop it on the way in
// rather than letting each screen filter it differently.
function loadPurchases() {
  let stored;
  try {
    stored = JSON.parse(localStorage.getItem("purchases")) || [];
  } catch {
    console.warn("Stored purchases were unreadable; starting empty.");
    return [];
  }
  if (!Array.isArray(stored)) return [];

  const kept = stored.filter(p => p && isValidAmount(p.amount));
  if (kept.length !== stored.length) {
    console.warn(`Dropped ${stored.length - kept.length} purchase(s) with an invalid amount.`);
    // Persist the cleanup here. Rendering used to save as a side effect and
    // happened to do this; now that it doesn't, be explicit about it.
    localStorage.setItem("purchases", JSON.stringify(kept));
  }
  return kept;
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

const PAGES = ["home", "purchases", "categories"];

function setMenuOpen(open) {
  const m = document.getElementById("sideMenu");
  if (!m) return;
  m.classList.toggle("open", open);
  m.setAttribute("aria-hidden", open ? "false" : "true");
}

function toggleMenu() {
  const m = document.getElementById("sideMenu");
  if (m) setMenuOpen(!m.classList.contains("open"));
}

// Each page becomes a history entry, so the phone's back button goes back a
// page instead of closing the app. `push: false` is for restoring a page we're
// already navigating to — on popstate and at boot — where pushing would add a
// duplicate entry.
function goPage(name, { push = true } = {}) {
  if (!PAGES.includes(name)) name = "home";

  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.getElementById(`page-${name}`)?.classList.add("active");
  if (name === "categories") renderCategorySummary();

  const main = document.querySelector("main");
  if (main) main.scrollTop = 0;

  if (push && history.state?.page !== name) {
    history.pushState({ page: name }, "", `#${name}`);
  }
}

window.addEventListener("popstate", e => {
  setMenuOpen(false);
  goPage(e.state?.page || location.hash.slice(1) || "home", { push: false });
});

// One delegated listener for everything the markup declares via data-action.
// Keeps handlers off inline onclick, which forced every function to be global.
const ACTIONS = {
  "toggle-menu":   () => toggleMenu(),
  "go-page":       el => { goPage(el.dataset.page); setMenuOpen(false); },
  "sign-in":       () => googleSignIn(),
  "sign-out":      () => signOutAndClear(),
  "add-purchase":  () => addPurchase(),
  "clear-device":  () => clearPurchases(),
  "create-sheet":  () => manualCreateSheet(),
};

document.addEventListener("click", e => {
  const el = e.target.closest("[data-action]");
  if (el) ACTIONS[el.dataset.action]?.(el);
});

// ===== Categories =====
// The single source of truth. Pill colors, bar colors, the auto-detect
// keywords, and both dropdowns are all derived from this — so adding a
// category is one edit here, not five scattered ones.
//
// ORDER MATTERS. suggestCategory() takes the first match, and keywords
// overlap: "gas bill" hits Utilities' "gas bill" and Transportation's "gas",
// and Utilities wins only by being listed first. Same for "rent payment"
// (Housing before Debt's "payment"). Reordering this list changes what gets
// auto-detected — the dropdowns just follow whatever order is here.
const CATEGORIES = [
  { name: "Groceries",      pill: "pill-groceries",      bar: "--bar-groceries",
    keywords: ["grocery","market","walmart","costco","smiths","kroger","aldi","whole foods","trader joe","safeway","albertsons"] },
  { name: "Dining Out",     pill: "pill-dining",         bar: "--bar-dining",
    keywords: ["restaurant","grill","cafe","bar","mcdonald","taco","pizza","chipotle","sushi","diner","burrito","burger","kitchen"] },
  { name: "Housing",        pill: "pill-housing",        bar: "--bar-housing",
    keywords: ["rent","mortgage","landlord","hoa","lease"] },
  { name: "Utilities",      pill: "pill-utilities",      bar: "--bar-utilities",
    keywords: ["power","electric","gas bill","water bill","internet","comcast","xfinity","utility","spectrum","cox"] },
  { name: "Transportation", pill: "pill-transportation", bar: "--bar-transport",
    keywords: ["uber","lyft","gas","fuel","diesel","bus","train","parking","toll","transit","shell","chevron","texaco"] },
  { name: "Entertainment",  pill: "pill-entertainment",  bar: "--bar-entertainment",
    keywords: ["movie","cinema","netflix","hulu","spotify","concert","game","disney+","ticket","amazon prime","youtube"] },
  { name: "Health",         pill: "pill-health",         bar: "--bar-health",
    keywords: ["pharmacy","walgreens","cvs","doctor","clinic","copay","gym","dental","vision","hospital","rx"] },
  { name: "Debt",           pill: "pill-debt",           bar: "--bar-debt",
    keywords: ["loan","credit card","payment","collections","interest"] },
  // Deliberately last and keyword-free: what suggestCategory() falls back to,
  // and what you pick when nothing else fits.
  { name: "Other",          pill: "pill-other",          bar: "--bar-other", keywords: [] },
];

// Styling for a purchase whose category is missing entirely. Not a real
// category — never offered in a dropdown, never auto-detected.
const UNCATEGORIZED_STYLE = { pill: "pill-uncategorized", bar: "--bar-uncategorized" };

function categoryStyle(name) {
  return CATEGORIES.find(c => c.name === name) || UNCATEGORIZED_STYLE;
}

function pillClass(category) {
  return categoryStyle(category).pill;
}

function barColor(category) {
  return `var(${categoryStyle(category).bar})`;
}

// Shared by the add form and the edit dialog so they can't drift apart.
//
// A purchase may carry a category that no longer exists — "Savings" was
// removed, and older rows can come back from the Sheet with anything. Keep the
// current value as an option so opening the edit dialog doesn't silently
// re-file the purchase under whichever category happens to be first.
function categoryOptionsHtml(selected) {
  const names = CATEGORIES.map(c => c.name);
  if (selected && !names.includes(selected)) names.push(selected);
  return names
    .map(n => `<option value="${esc(n)}"${n === selected ? " selected" : ""}>${esc(n)}</option>`)
    .join("");
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
  if (!labelEl || !amountEl || !subEl) return;

  const now   = new Date();
  const thisM = now.toLocaleDateString("en-CA").slice(0, 7); // YYYY-MM
  const lastM = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    .toLocaleDateString("en-CA").slice(0, 7);

  const monthTotal = month => purchases
    .filter(p => p.date?.startsWith(month) && isValidAmount(p.amount))
    .reduce((s, p) => s + parseFloat(p.amount), 0);

  const thisTotal = monthTotal(thisM);
  const lastTotal = monthTotal(lastM);

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
// Rows are addressed by the purchase's own id, not its position in the array.
// Positions were only ever safe because every mutation re-rendered the whole
// list; an id stays correct no matter what order things are drawn in.
function purchaseById(id) {
  return purchases.find(p => p.id === id);
}

function renderPurchases() {
  const list         = document.getElementById("purchaseList");
  const totalDisplay = document.getElementById("totalSpent");
  if (!list || !totalDisplay) return;

  list.innerHTML = "";
  let total = 0;

  purchases.forEach(p => {
    if (!isValidAmount(p.amount)) return;
    const amount = parseFloat(p.amount);
    total += amount;

    const row      = document.createElement("div");
    row.className  = "purchase-item";
    row.dataset.id = p.id;

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
      <button class="act-btn"     title="Edit"   aria-label="Edit ${esc(p.name)}">
        <span class="material-symbols-outlined">edit</span>
      </button>
      <button class="act-btn del" title="Delete" aria-label="Delete ${esc(p.name)}">
        <span class="material-symbols-outlined">delete</span>
      </button>
    `;

    list.appendChild(row);
  });

  totalDisplay.textContent = `Total: $${total.toFixed(2)}`;
  updateHero();
  updateCategoryBars();
  renderTrendChart();
}

// One listener for the whole list rather than two per row, re-attached on
// every render.
document.addEventListener("click", e => {
  const btn = e.target.closest(".purchase-item .act-btn");
  if (!btn) return;
  const id = btn.closest(".purchase-item")?.dataset.id;
  if (!id) return;
  btn.classList.contains("del") ? deletePurchase(id) : openEditModal(id);
});

// Render and persist. Callers that change `purchases` want both; keeping them
// separate means drawing the list no longer quietly writes to storage.
function saveAndRender() {
  saveLocal();
  renderPurchases();
}

// ===== Spending-over-time chart =====
// One measure over time, so one color — not a hue per category. The current
// period is picked out in ink and everything else recedes to gray, because
// the period in progress is incomplete and shouldn't read as a fair
// comparison against finished ones.
let trendChart = null;

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ===== Time range =====
// The filter's value is one of:
//   ""        all time
//   "7d"/"14d" a rolling window ending today
//   "YYYY-MM"  one calendar month
// Rolling windows and months bucket differently, so they're kept distinct
// rather than collapsed into a start/end pair.
const ROLLING_RANGES = [
  { value: "7d",  label: "Last 7 days",  days: 7  },
  { value: "14d", label: "Last 14 days", days: 14 },
];

function rollingDays(value) {
  return ROLLING_RANGES.find(r => r.value === value)?.days || null;
}

// The last n dates as YYYY-MM-DD, oldest first, ending today. Built by
// stepping a local Date so it lands on real calendar days across month and
// DST boundaries rather than subtracting milliseconds.
function lastNDates(n) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);            // midday: immune to DST shifts
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    out.push(d.toLocaleDateString("en-CA"));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

// One definition of "is this purchase in the selected range", shared by the
// chart and the category bars so they can't disagree.
function inSelectedRange(p) {
  if (!p.date) return false;
  const days = rollingDays(chartRange);
  if (days) return p.date >= lastNDates(days)[0] && p.date <= todayStr();
  if (chartRange) return p.date.startsWith(chartRange);
  return true;
}

function rangeLabel() {
  const days = rollingDays(chartRange);
  if (days) return `the last ${days} days`;
  if (chartRange) {
    const [y, m] = chartRange.split("-").map(Number);
    return new Date(y, m - 1).toLocaleString("default", { month: "long", year: "numeric" });
  }
  return "any period";
}

// Buckets by day for a rolling range or a single month, by month otherwise.
function trendBuckets() {
  const valid = purchases.filter(p => p.date && isValidAmount(p.amount));

  // Rolling "last N days", ending today.
  const days = rollingDays(chartRange);
  if (days) {
    const dates  = lastNDates(days);
    const totals = dates.map(d =>
      valid.filter(p => p.date === d)
           .reduce((s, p) => s + parseFloat(p.amount), 0));
    return {
      labels:  dates.map(d => {
        const [y, m, day] = d.split("-").map(Number);
        return new Date(y, m - 1, day).toLocaleString("default", { month: "short", day: "numeric" });
      }),
      values:  totals,
      current: dates.length - 1,          // today is always the last bucket
      heading: `Daily spending — last ${days} days`,
      note:    "Today is still in progress.",
      unit:    "date",
    };
  }

  if (chartRange) {
    const [y, m] = chartRange.split("-").map(Number);
    const inMonth = new Date(y, m, 0).getDate();
    const totals = new Array(inMonth).fill(0);
    valid
      .filter(p => p.date.startsWith(chartRange))
      .forEach(p => {
        const d = parseInt(p.date.slice(8, 10), 10);
        if (d >= 1 && d <= inMonth) totals[d - 1] += parseFloat(p.amount);
      });

    const today   = new Date();
    const isNow   = chartRange === today.toLocaleDateString("en-CA").slice(0, 7);
    const heading = new Date(y, m - 1).toLocaleString("default", { month: "long", year: "numeric" });
    return {
      labels:  totals.map((_, i) => String(i + 1)),
      values:  totals,
      current: isNow ? today.getDate() - 1 : -1,
      heading: `Daily spending — ${heading}`,
      note:    isNow ? "This month is still in progress." : "",
      unit:    "day",
    };
  }

  // All time: last 12 months that have data, oldest first.
  const byMonth = {};
  valid.forEach(p => {
    const key = p.date.slice(0, 7);
    byMonth[key] = (byMonth[key] || 0) + parseFloat(p.amount);
  });
  const months  = Object.keys(byMonth).sort().slice(-12);
  const thisM   = new Date().toLocaleDateString("en-CA").slice(0, 7);
  return {
    labels:  months.map(k => {
      const [y, m] = k.split("-");
      return new Date(y, m - 1).toLocaleString("default", { month: "short" }) + " " + y.slice(2);
    }),
    values:  months.map(k => byMonth[k]),
    current: months.indexOf(thisM),
    heading: "Spending by month",
    note:    months.includes(thisM) ? "This month is still in progress." : "",
    unit:    "month",
  };
}

function renderTrendChart() {
  const card   = document.getElementById("trendCard");
  const canvas = document.getElementById("trendChart");
  if (!card || !canvas) return;

  // Chart.js comes from a CDN. On a first visit with no network it won't be
  // there — hide the card rather than break the page.
  if (typeof Chart === "undefined") { card.style.display = "none"; return; }

  const { labels, values, current, heading, note, unit } = trendBuckets();
  const hasData = values.some(v => v > 0);
  card.style.display = hasData ? "" : "none";
  if (!hasData) { trendChart?.destroy(); trendChart = null; return; }

  document.getElementById("trendLabel").textContent = heading;
  document.getElementById("trendNote").textContent  = note;

  const accent  = cssVar("--ink")   || "#1a1a18";
  const context = cssVar("--ink-3") || "#aaa89f";
  const rule    = cssVar("--rule-2") || "#f0ede8";
  const ink2    = cssVar("--ink-2") || "#6a6860";

  trendChart?.destroy();
  trendChart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: values.map((_, i) => i === current ? accent : context),
        // Rounded at the data end, square on the baseline.
        borderRadius: { topLeft: 4, topRight: 4, bottomLeft: 0, bottomRight: 0 },
        borderSkipped: false,
        maxBarThickness: 24,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: {
        legend: { display: false },   // one series — the card label names it
        tooltip: {
          backgroundColor: accent,
          padding: 10,
          displayColors: false,
          titleFont: { family: "'IBM Plex Mono', monospace", size: 11 },
          bodyFont:  { family: "'IBM Plex Mono', monospace", size: 12 },
          callbacks: {
            title: items => unit === "day" ? `Day ${items[0].label}` : items[0].label,
            label: item => `$${item.parsed.y.toFixed(2)}`,
          },
        },
      },
      scales: {
        x: {
          grid:   { display: false },
          border: { color: rule },
          ticks:  {
            color: ink2,
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            maxRotation: 0,
            autoSkipPadding: 12,
          },
        },
        y: {
          beginAtZero: true,
          grid:   { color: rule, drawTicks: false },   // hairline, solid, recessive
          border: { display: false },
          ticks:  {
            color: ink2,
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            padding: 8,
            maxTicksLimit: 5,
            callback: v => "$" + (v >= 1000 ? (v / 1000) + "k" : v),
          },
        },
      },
    },
  });
}

// ===== Category bar chart (replaces burn-up on home) =====
// The set of months that currently has data, newest first.
function monthsWithData() {
  const months = new Set();
  purchases.forEach(p => { if (p.date?.length >= 7) months.add(p.date.slice(0, 7)); });
  return [...months].sort().reverse();
}

let renderedMonths = null;

// Rebuild only when the available months actually change. This runs on every
// render, and it used to tear down and rebuild the whole <select> each time —
// with `innerHTML +=` in a loop, so the accumulated string was reparsed once
// per option.
function buildMonthOptions() {
  const select = document.getElementById("chartMonthFilter");
  if (!select) return;

  const sorted = monthsWithData();
  const key    = sorted.join(",");
  if (key === renderedMonths) return;   // nothing new to show
  renderedMonths = key;

  const current = select.value;
  const months  = sorted.map(m => {
    const [y, mo] = m.split("-");
    const label   = new Date(Number(y), Number(mo) - 1)
      .toLocaleString("default", { month: "long", year: "numeric" });
    return `<option value="${m}">${label}</option>`;
  });

  // Rolling windows are always offered, even with no data in them — an empty
  // "last 7 days" is a real answer, not a missing option.
  const rolling = ROLLING_RANGES
    .map(r => `<option value="${r.value}">${r.label}</option>`)
    .join("");

  select.innerHTML =
    `<option value="">All time</option>` +
    rolling +
    months.join("");

  // Keep the current selection if it's still offered.
  const stillValid = current === "" || rollingDays(current) || sorted.includes(current);
  select.value = stillValid ? current : "";
  chartRange   = select.value;
}

function updateCategoryBars() {
  const container = document.getElementById("categoryBars");
  if (!container) return;

  buildMonthOptions();

  const totals = {};
  let grandTotal = 0;
  purchases.forEach(p => {
    if (!isValidAmount(p.amount) || !inSelectedRange(p)) return;
    const amt = parseFloat(p.amount);
    const cat = p.category || UNCATEGORIZED;
    totals[cat] = (totals[cat] || 0) + amt;
    grandTotal += amt;
  });

  container.innerHTML = "";
  if (grandTotal === 0) {
    // Say which period is empty — "No purchases yet" is misleading when the
    // user has plenty of purchases, just none in the last 7 days.
    container.innerHTML = purchases.length
      ? `<p class="subtle">No purchases in ${esc(rangeLabel())}.</p>`
      : `<p class="subtle">No purchases yet.</p>`;
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
    if (!isValidAmount(p.amount)) return;
    const amount = parseFloat(p.amount);
    const cat    = p.category || UNCATEGORIZED;
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
// First match wins, in CATEGORIES order — see the ordering note there.
function suggestCategory(name) {
  const n = (name || "").toLowerCase();
  const hit = CATEGORIES.find(c => c.keywords.some(k => n.includes(k)));
  return hit ? hit.name : "Other";
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
  saveAndRender();

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
      saveAndRender();
      setSyncStatus("Sync failed — entry not saved ✗", "err");
    }
  } else {
    setSyncStatus(`Saved locally${wasAuto ? ` — auto: ${category}` : ""}`, "ok");
  }
}

// ===== Edit modal =====
function openEditModal(id) {
  const p = purchaseById(id);
  if (!p) return;
  document.getElementById("editModal")?.remove();

  const overlay   = document.createElement("div");
  overlay.id      = "editModal";
  overlay.className = "modal-bg";

  const options = categoryOptionsHtml(p.category);

  overlay.innerHTML = `
    <div class="modal-box">
      <div class="card-label">Edit entry</div>
      <div class="input-grid" style="margin-bottom:8px;">
        <input id="e-name"   type="text"   placeholder="Item name" />
        <input id="e-amount" type="number" step="0.01" placeholder="$0.00" class="mono" />
        <input id="e-date"   type="date"   class="mono" />
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

  // Set as properties, not as HTML attributes. esc() escapes < > &, but not
  // double quotes — a name like `55" TV` would close the attribute early.
  overlay.querySelector("#e-name").value   = p.name ?? "";
  overlay.querySelector("#e-amount").value = p.amount ?? "";
  overlay.querySelector("#e-date").value   = p.date ?? "";

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
    saveAndRender();
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
async function deletePurchase(id) {
  const index = purchases.findIndex(p => p.id === id);
  if (index === -1) return;
  const purchase = purchases[index];
  purchases.splice(index, 1);
  saveAndRender();

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
  if (!confirm(
    "Sign out and erase all purchases on this device?\n\n" +
    "Your Google Sheet keeps its data, but this app will forget which sheet " +
    "is yours — you'd have to find it in Drive yourself."
  )) return;

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

  // Fill the add form's category dropdown from CATEGORIES, keeping the
  // "auto-detect if blank" option the markup already provides.
  const catSelect = document.getElementById("itemCategory");
  if (catSelect) catSelect.insertAdjacentHTML("beforeend", categoryOptionsHtml(""));

  // Restore whichever page the URL names, and seed a history entry for it so
  // the first back press has somewhere to go.
  const startPage = location.hash.slice(1) || "home";
  history.replaceState({ page: PAGES.includes(startPage) ? startPage : "home" }, "");
  goPage(startPage, { push: false });

  const monthFilter = document.getElementById("chartMonthFilter");
  if (monthFilter) {
    monthFilter.addEventListener("change", () => {
      chartRange = monthFilter.value;
      updateCategoryBars();
      renderTrendChart();
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
