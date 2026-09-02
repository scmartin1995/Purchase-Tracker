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
// The one selected time range. It scopes the purchases list, the footer
// total, the hero total, the category bars and the trend chart. See RANGE
// VALUES below for the forms it takes.
let activeRange = "";

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
  "clear-range":   () => setRange(""),
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
function monthTotal(month) {
  return purchases
    .filter(p => p.date?.startsWith(month) && isValidAmount(p.amount))
    .reduce((s, p) => s + parseFloat(p.amount), 0);
}

// The month before a YYYY-MM, as YYYY-MM. Month index m - 2 is the previous
// month, and Date rolls a negative index back into the previous year.
function previousMonth(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 2, 1).toLocaleDateString("en-CA").slice(0, 7);
}

// Unfiltered, this stays exactly what it always was: this month's total
// against last month's. Once a range is picked the headline becomes that
// range's total — a big number that ignores the filter right below it is
// worse than no number.
function updateHero() {
  const labelEl  = document.getElementById("heroMonthLabel");
  const amountEl = document.getElementById("heroTotal");
  const subEl    = document.getElementById("heroSub");
  if (!labelEl || !amountEl || !subEl) return;

  // A calendar month has an obvious thing to compare against. The default
  // view is this month, and picking a month from the dropdown is the same
  // question asked about a different one, so both take this path.
  const month = activeRange
    ? (/^\d{4}-\d{2}$/.test(activeRange) ? activeRange : null)
    : todayStr().slice(0, 7);

  if (month) {
    const total = monthTotal(month);
    const prev  = monthTotal(previousMonth(month));
    labelEl.textContent  = monthTitle(month);
    amountEl.textContent = `$${total.toFixed(2)}`;

    if (prev > 0) {
      const diff = total - prev;
      const pct  = Math.abs((diff / prev) * 100).toFixed(0);
      const sign = diff >= 0 ? "+" : "−";
      subEl.textContent = `${sign}$${Math.abs(diff).toFixed(2)} (${sign}${pct}%) vs last month`;
    } else {
      subEl.textContent = "\u00a0";
    }
    return;
  }

  // A rolling window or an open-ended "since" has no natural baseline, so
  // show what makes up the number rather than invent one to compare against.
  const { total, count } = rangeTotals();
  labelEl.textContent  = rangeTitle();
  amountEl.textContent = `$${total.toFixed(2)}`;
  subEl.textContent    = count === 1 ? "1 purchase" : `${count} purchases`;
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

  // Refresh the preset options first: they can retire a month that just lost
  // its last purchase, and everything below should draw against the
  // corrected range rather than a stale one.
  buildRangeOptions();

  list.innerHTML = "";
  let total = 0;
  let shown = 0;

  purchases.forEach(p => {
    if (!isValidAmount(p.amount) || !inSelectedRange(p)) return;
    const amount = parseFloat(p.amount);
    total += amount;
    shown++;

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

  // Name the period that came up empty. "No purchases yet" would be a lie
  // when there are plenty, just none since the chosen date.
  if (!shown) {
    list.innerHTML = purchases.length
      ? `<p class="subtle">No purchases in ${esc(rangeLabel())}.</p>`
      : `<p class="subtle">No purchases yet.</p>`;
  }

  // The card heading and the footer both name the range they're showing, so
  // neither can be misread as the all-time figure while a filter is on.
  const label = document.getElementById("purchaseListLabel");
  if (label) label.textContent = activeRange ? `Purchases — ${rangeTitle()}` : "All purchases";

  totalDisplay.textContent = activeRange
    ? `Total (${rangeTitle()}): $${total.toFixed(2)}`
    : `Total: $${total.toFixed(2)}`;
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
// RANGE VALUES — activeRange is exactly one of:
//   ""                 all time (the default)
//   "7d" / "14d"       a rolling window ending today
//   "YYYY-MM"          one calendar month
//   "from:YYYY-MM-DD"  everything on or after that day, with no end
// They stay distinct strings rather than collapsing into a start/end pair
// because each buckets its chart differently and each labels itself
// differently.
const ROLLING_RANGES = [
  { value: "7d",  label: "Last 7 days",  days: 7  },
  { value: "14d", label: "Last 14 days", days: 14 },
];

const FROM_PREFIX = "from:";

function rollingDays(value) {
  return ROLLING_RANGES.find(r => r.value === value)?.days || null;
}

// The start date of a "from:" range, or null when the range isn't one.
function rangeFromDate(value = activeRange) {
  return value.startsWith(FROM_PREFIX) ? value.slice(FROM_PREFIX.length) : null;
}

// ===== Date formatting =====
// All of these build a Date from the parts rather than parsing the string.
// `new Date("2026-01-15")` is read as UTC and lands on the 14th in any
// timezone behind it, which is every US one.

// YYYY-MM-DD → "Jan 15, 2026"
function formatDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d)
    .toLocaleString("default", { month: "short", day: "numeric", year: "numeric" });
}

// YYYY-MM → "January 2026"
function monthTitle(ym) {
  const [y, m] = ym.split("-").map(Number);
  return new Date(y, m - 1).toLocaleString("default", { month: "long", year: "numeric" });
}

// Chart axis ticks, which need to be short.
function dayTick(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleString("default", { month: "short", day: "numeric" });
}

function monthTick(ym) {
  const [y, m] = ym.split("-");
  return new Date(y, m - 1).toLocaleString("default", { month: "short" }) + " " + y.slice(2);
}

// ===== Date spans =====
// Every calendar day from start to end inclusive, YYYY-MM-DD, oldest first.
// Steps a local Date set to midday so a DST shift can't drop or repeat a day.
// The cap is a backstop only — spans longer than a month get bucketed by
// month, so nothing legitimate comes near it.
function datesFrom(startIso, endIso) {
  const out = [];
  const [y, m, d] = startIso.split("-").map(Number);
  const cur = new Date(y, m - 1, d, 12);
  while (out.length < 400) {
    const iso = cur.toLocaleDateString("en-CA");
    if (iso > endIso) break;
    out.push(iso);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Every month from start to end inclusive, YYYY-MM, oldest first.
function monthsFrom(startYm, endYm) {
  const out = [];
  let [y, m] = startYm.split("-").map(Number);
  while (out.length < 240) {
    const key = `${y}-${String(m).padStart(2, "0")}`;
    if (key > endYm) break;
    out.push(key);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// The last n dates, oldest first, ending today.
function lastNDates(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);            // midday: immune to DST shifts
  d.setDate(d.getDate() - (n - 1));
  return datesFrom(d.toLocaleDateString("en-CA"), todayStr());
}

// One definition of "is this purchase in the selected range", shared by the
// list, the totals, the chart and the category bars so they can't disagree.
function inSelectedRange(p) {
  if (!p.date) return false;
  const from = rangeFromDate();
  if (from) return p.date >= from;    // "since" is open-ended on purpose
  const days = rollingDays(activeRange);
  if (days) return p.date >= lastNDates(days)[0] && p.date <= todayStr();
  if (activeRange) return p.date.startsWith(activeRange);
  return true;
}

// The range as a heading: "All time", "Last 7 days", "January 2026",
// "Since Jan 15, 2026".
function rangeTitle() {
  const from = rangeFromDate();
  if (from) return `Since ${formatDay(from)}`;
  const days = rollingDays(activeRange);
  if (days) return `Last ${days} days`;
  if (activeRange) return monthTitle(activeRange);
  return "All time";
}

// The same range phrased to sit inside a sentence: "No purchases in ___."
function rangeLabel() {
  const from = rangeFromDate();
  if (from) return `the period since ${formatDay(from)}`;
  const days = rollingDays(activeRange);
  if (days) return `the last ${days} days`;
  if (activeRange) return monthTitle(activeRange);
  return "any period";
}

// Total and entry count for the selected range. The hero reads from here
// rather than summing the list its own way.
function rangeTotals() {
  let total = 0;
  let count = 0;
  purchases.forEach(p => {
    if (!isValidAmount(p.amount) || !inSelectedRange(p)) return;
    total += parseFloat(p.amount);
    count++;
  });
  return { total, count };
}

// Buckets by day for a rolling range, a single month, or a short "since"
// span; by month for a long "since" span or for all time.
function trendBuckets() {
  const valid = purchases.filter(p => p.date && isValidAmount(p.amount));

  // "Since a date" — one open-ended span, so the bucket size comes from how
  // long it turned out to be. Up to about a month reads well day by day;
  // past that the bars get too thin to compare and months are the honest unit.
  const from = rangeFromDate();
  if (from) {
    const today   = todayStr();
    const start   = from > today ? today : from;   // a future start would give an empty span
    const inRange = valid.filter(p => p.date >= start);
    // A purchase can be dated ahead of today and inSelectedRange counts it,
    // so run the axis out to the latest entry instead of stopping at today
    // and quietly leaving it out of a chart whose total includes it.
    const end   = inRange.reduce((mx, p) => (p.date > mx ? p.date : mx), today);
    const dates = datesFrom(start, end);

    if (dates.length <= 31) {
      const totals  = dates.map(d =>
        inRange.filter(p => p.date === d)
               .reduce((s, p) => s + parseFloat(p.amount), 0));
      const current = dates.indexOf(today);
      return {
        labels:  dates.map(dayTick),
        values:  totals,
        current,
        heading: `Daily spending — since ${formatDay(from)}`,
        note:    current >= 0 ? "Today is still in progress." : "",
        unit:    "date",
      };
    }

    const allMonths = monthsFrom(start.slice(0, 7), end.slice(0, 7));
    const months    = allMonths.slice(-24);        // keep the axis readable
    const byMonth   = {};
    inRange.forEach(p => {
      const k = p.date.slice(0, 7);
      byMonth[k] = (byMonth[k] || 0) + parseFloat(p.amount);
    });
    const current = months.indexOf(today.slice(0, 7));
    // If the axis was trimmed, say so — the chart would otherwise show less
    // than the total above it without admitting to it.
    const trimmed = allMonths.length - months.length;
    return {
      labels:  months.map(monthTick),
      values:  months.map(k => byMonth[k] || 0),
      current,
      heading: `Monthly spending — since ${formatDay(from)}`,
      note:    [
        trimmed ? `Showing the last ${months.length} of ${allMonths.length} months.` : "",
        current >= 0 ? "This month is still in progress." : "",
      ].filter(Boolean).join(" "),
      unit:    "month",
    };
  }

  // Rolling "last N days", ending today.
  const days = rollingDays(activeRange);
  if (days) {
    const dates  = lastNDates(days);
    const totals = dates.map(d =>
      valid.filter(p => p.date === d)
           .reduce((s, p) => s + parseFloat(p.amount), 0));
    return {
      labels:  dates.map(dayTick),
      values:  totals,
      current: dates.length - 1,          // today is always the last bucket
      heading: `Daily spending — last ${days} days`,
      note:    "Today is still in progress.",
      unit:    "date",
    };
  }

  if (activeRange) {
    const [y, m] = activeRange.split("-").map(Number);
    const inMonth = new Date(y, m, 0).getDate();
    const totals = new Array(inMonth).fill(0);
    valid
      .filter(p => p.date.startsWith(activeRange))
      .forEach(p => {
        const d = parseInt(p.date.slice(8, 10), 10);
        if (d >= 1 && d <= inMonth) totals[d - 1] += parseFloat(p.amount);
      });

    const today   = new Date();
    const isNow   = activeRange === today.toLocaleDateString("en-CA").slice(0, 7);
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
    labels:  months.map(monthTick),
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

// ===== Filter controls =====
// The same filter row is mounted on Home and on Purchases. One range drives
// both, so whichever copy you touch, the other follows.
function mountFilterRows() {
  const tpl = document.getElementById("filterRowTpl");
  if (!tpl) return;
  document.querySelectorAll(".filter-mount").forEach(mount => {
    if (!mount.firstElementChild) mount.appendChild(tpl.content.cloneNode(true));
  });
}

// Push activeRange back out to every copy of the controls.
function syncRangeControls() {
  const from = rangeFromDate() || "";
  // A "from" date is a range in its own right, so the preset dropdown reads
  // as unset while one is active — one time filter at a time, never two.
  document.querySelectorAll(".range-select").forEach(s => { s.value = from ? "" : activeRange; });
  document.querySelectorAll(".range-from").forEach(i => { i.value = from; });
  document.querySelectorAll(".range-clear").forEach(b => { b.hidden = !from; });
}

// Setting either control clears the other. Two overlapping time filters
// would need an intersection rule nobody could predict by looking at them.
function setRange(value) {
  activeRange = value;
  syncRangeControls();
  renderPurchases();   // redraws the list, footer, hero, bars and chart
}

document.addEventListener("change", e => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.matches(".range-select")) setRange(t.value);
  if (t.matches(".range-from"))   setRange(t.value ? FROM_PREFIX + t.value : "");
});

let renderedMonths = null;

// Rebuild the preset options only when the available months actually change.
// This runs on every render, and it used to tear down and rebuild the whole
// <select> each time — with `innerHTML +=` in a loop, so the accumulated
// string was reparsed once per option.
function buildRangeOptions() {
  const selects = document.querySelectorAll(".range-select");
  if (!selects.length) return;

  const sorted = monthsWithData();
  // The mount count is part of the key so a row added later still gets filled.
  const key    = sorted.join(",") + "|" + selects.length;
  if (key !== renderedMonths) {
    renderedMonths = key;

    // Rolling windows are always offered, even with no data in them — an
    // empty "last 7 days" is a real answer, not a missing option.
    const rolling = ROLLING_RANGES
      .map(r => `<option value="${r.value}">${r.label}</option>`)
      .join("");
    const months = sorted
      .map(m => `<option value="${m}">${monthTitle(m)}</option>`)
      .join("");

    const html = `<option value="">All time</option>` + rolling + months;
    selects.forEach(s => { s.innerHTML = html; });
  }

  // Drop a month that no longer has anything behind it. Deleting the last
  // purchase in it would otherwise leave the app filtered to nothing, with a
  // dropdown offering a month that isn't there any more.
  if (activeRange && !rangeFromDate() && !rollingDays(activeRange) && !sorted.includes(activeRange)) {
    activeRange = "";
  }
  syncRangeControls();
}

function updateCategoryBars() {
  const container = document.getElementById("categoryBars");
  if (!container) return;

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
      // Keep the entry. Without a row it's already in exactly the state
      // pushUnsyncedPurchases() looks for, so it goes up on the next sync
      // like anything entered while signed out. Throwing away what someone
      // just typed because the network blipped is the worse failure, and if
      // the append did land before erroring, reconcile matches it by id
      // rather than duplicating it.
      console.warn("Sync failed; keeping the entry to upload later", e);
      setSyncStatus("Saved locally — sheet sync failed, will retry ✗", "err");
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
      // Two failure modes with different remedies, so they get their own
      // handlers. No sheet means the Create Sheet button is the fix; a
      // failed upload means try again later, and offering to create a
      // second sheet would be actively wrong.
      try {
        await ensureSheetInitialized();
        await reconcileLocalWithSheet();
      } catch (e) {
        console.warn("Post sign-in setup failed", e);
        setSyncStatus("Could not set up Google Sheet", "err");
        showSheetHelper(true);
        return;
      }

      try {
        const uploaded = await pushUnsyncedPurchases();
        setSyncStatus(uploaded
          ? `Signed in & synced ✓ — ${uploaded} uploaded`
          : "Signed in & synced ✓", "ok");
      } catch (e) {
        // Nothing is lost: the entries still have no row, so the next sync
        // picks them up exactly as it would any pending entry.
        console.warn("Upload of pending purchases failed", e);
        setSyncStatus("Signed in — couldn't upload pending purchases, will retry ✗", "err");
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

// ===== Uploading what the sheet doesn't have =====
// reconcileLocalWithSheet() matches local purchases to rows that already
// exist. Whatever it can't match is genuinely absent from the sheet, so it
// goes up here. This is what gets an entry made while signed out into the
// sheet on the next sign-in — before this, nothing ever uploaded it, because
// appendRowToSheet() was only ever reached from addPurchase() while signed
// in.
//
// Duplicates are prevented by the id, not by a timestamp: every append
// writes the purchase's id into column E and reconcile matches on it first,
// so a purchase already in the sheet keeps its row and never reaches this
// function. That holds even when a previous append wrote the row but died
// before reporting back.
//
// Returns how many rows went up, so the caller can say so honestly.
async function pushUnsyncedPurchases() {
  const pending = purchases.filter(p => !p.row && isValidAmount(p.amount));
  if (!pending.length) return 0;

  await ensureSheetInitialized();
  setSyncStatus(`Uploading ${pending.length} purchase${pending.length === 1 ? "" : "s"}…`);

  // One append for the lot. The per-row alternative is n round trips and a
  // half-uploaded state whenever one of them fails.
  const resp = await gapi.client.sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    resource: {
      values: pending.map(p => [p.date, p.name, p.amount, p.category || "", p.id || ""]),
    },
  });

  // Sheets reports the block it wrote as e.g. "Sheet1!A12:E14", and the rows
  // land in the order they were sent, so the nth pending purchase is at
  // firstRow + n. If that range can't be read the rows are still in the
  // sheet — leaving them without a row number is the safe failure, because
  // the next reconcile matches them by id instead of uploading them twice.
  const m = resp.result?.updates?.updatedRange?.match(/!A(\d+):/i);
  if (m) {
    const firstRow = parseInt(m[1], 10);
    pending.forEach((p, i) => { p.row = firstRow + i; });
    saveLocal();
  }
  return pending.length;
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

  // Put a filter row on every page that declares a mount point. Must happen
  // before the first render, which fills in their options.
  mountFilterRows();

  // Restore whichever page the URL names, and seed a history entry for it so
  // the first back press has somewhere to go.
  const startPage = location.hash.slice(1) || "home";
  history.replaceState({ page: PAGES.includes(startPage) ? startPage : "home" }, "");
  goPage(startPage, { push: false });

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
      const uploaded = await pushUnsyncedPurchases();
      setSyncStatus(uploaded ? `Synced ✓ — ${uploaded} uploaded` : "Synced ✓", "ok");
    } catch (e) {
      console.warn("Auto-sync failed", e);
      setSyncStatus("Session restored — sync later", "");
    }
  } else {
    updateSignInButton();
  }

  renderPurchases();
});
