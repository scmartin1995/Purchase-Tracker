#!/usr/bin/env node
//
// Contrast and colour-separation checker for the app's palette.
//
// Why this exists: style.css told future readers to run
// `scripts/validate_palette.js`, which was never committed — the tool that
// produced the 2026-08-30 numbers lives outside this repo. When the app moved
// to a dark surface those numbers stopped applying, because both the WCAG
// ratios and the perceived gaps between hues depend on what they sit on.
//
// This is NOT that tool and does not reproduce its exact figures. It checks
// two things, both from published formulae, so the claims in style.css can be
// re-derived here instead of taken on trust:
//
//   1. WCAG 2.1 relative-contrast ratios (text on its background, and each
//      accent against the surface it is drawn on).
//   2. CIE76 ΔE between adjacent accents, for normal vision and simulated
//      protanopia / deuteranopia / tritanopia (Viénot-Brettel-Mollon 1999).
//
// CIE76 is the simplest of the ΔE formulae and reads slightly differently
// from ΔE2000; treat the thresholds below as this script's own, not as the
// ones the original audit used.
//
// Usage:
//   node scripts/check_contrast.js          # check the committed palette
//   node scripts/check_contrast.js --json   # machine-readable

// Thresholds. WCAG 1.4.3 wants 4.5:1 for body text and 3:1 for large text;
// 1.4.11 wants 3:1 for graphical objects such as chart bars.
const TEXT_MIN = 4.5;
const UI_MIN   = 3.0;
// Separation floors, chosen to match the intent recorded in style.css: keep a
// usable gap under colour-vision deficiency, and a comfortable one without.
const DE_CVD_MIN    = 8;
const DE_NORMAL_MIN = 15;

// ── colour maths ──────────────────────────────────────────────────────────
const hex2rgb = h => {
  const s = h.replace('#', '');
  const n = parseInt(s.length === 3 ? s.split('').map(c => c + c).join('') : s, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

const srgb2lin = c => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

const luminance = hex => {
  const [r, g, b] = hex2rgb(hex).map(srgb2lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// sRGB -> CIE Lab (D65)
function lab(hex) {
  let [r, g, b] = hex2rgb(hex).map(srgb2lin);
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.00000;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

const deltaE76 = (a, b) => {
  const [l1, a1, b1] = lab(a), [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
};

// Viénot, Brettel & Mollon (1999) dichromat simulation, applied in linear RGB.
const CVD = {
  protanopia:   [[0.1121, 0.8853, -0.0005], [0.1127, 0.8897, -0.0001], [0.0045, 0.0000, 1.0019]],
  deuteranopia: [[0.2920, 0.7054, -0.0003], [0.2934, 0.7089, 0.0000], [-0.0209, 0.0270, 0.9942]],
  tritanopia:   [[1.0000, 0.1284, -0.1284], [0.0000, 0.8750, 0.1250], [0.0000, 0.3831, 0.6169]],
};

function simulate(hex, kind) {
  const m = CVD[kind];
  const lin = hex2rgb(hex).map(srgb2lin);
  const out = m.map(row => row.reduce((s, k, i) => s + k * lin[i], 0));
  const lin2srgb = v => {
    v = Math.min(1, Math.max(0, v));
    const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    return Math.round(c * 255);
  };
  return '#' + out.map(lin2srgb).map(v => v.toString(16).padStart(2, '0')).join('');
}

// ── the palette under test ────────────────────────────────────────────────
// Kept in CATEGORIES order, because adjacency is what the separation check
// looks at and that order is what the app actually renders.
const SURFACE = '#151720';   // --surface, the card the pills and bars sit on
const PAGE    = '#0a0b10';   // --bg

const CHROME = [
  ['--ink on --bg',        '#f7f8fa', PAGE,    TEXT_MIN],
  ['--ink on --surface',   '#f7f8fa', SURFACE, TEXT_MIN],
  ['--ink-2 on --surface', '#a9adbd', SURFACE, TEXT_MIN],
  ['--ink-3 on --surface', '#7f8496', SURFACE, UI_MIN],
  ['--ink-3 on --bg',      '#7f8496', PAGE,    UI_MIN],
  // Text sitting on the gradient hero, at both ends of each gradient.
  ['hero ink on teal',     '#0a0b10', '#3fbfa8', TEXT_MIN],
  ['hero ink on mid-green','#0a0b10', '#4aa87e', TEXT_MIN],
  ['hero ink on olive',    '#0a0b10', '#6f9e4a', TEXT_MIN],
  ['hero ink on peach',    '#0a0b10', '#ffc07a', TEXT_MIN],
  ['hero ink on pink',     '#0a0b10', '#ff6fa3', TEXT_MIN],
  // Delta chips.
  ['ok chip',              '#c8f560', '#23300f', TEXT_MIN],
  ['err chip',             '#ff8f8a', '#3a1a1e', TEXT_MIN],
];

const PILLS = [
  ['Groceries',      '#5ce5ab', '#163b2c'],
  ['Dining Out',     '#ffa87f', '#3d2117'],
  ['Housing',        '#eceae5', '#34332f'],
  ['Utilities',      '#8ec2ff', '#172b40'],
  ['Transportation', '#6bd96b', '#16341a'],
  ['Entertainment',  '#fbaacd', '#3a1d2b'],
  ['Health',         '#bcb1f9', '#262240'],
  ['Debt',           '#ff9d97', '#3d1c1c'],
  ['Other',          '#c6c4bc', '#2e2e2b'],
  ['Uncategorized',  '#b0aea7', '#282826'],
];

const BARS = [
  ['Groceries',      '#22d69a'],
  ['Dining Out',     '#ff7f4d'],
  ['Housing',        '#dedcd6'],
  ['Utilities',      '#5aa2ff'],
  ['Transportation', '#3fc23f'],
  ['Entertainment',  '#f38cb8'],
  ['Health',         '#9385fb'],
  ['Debt',           '#ff6663'],
  ['Other',          '#aeaba3'],
  ['Uncategorized',  '#6e6c66'],
];

// ── run ───────────────────────────────────────────────────────────────────
const fails = [];
const rows  = [];
const r2 = n => Math.round(n * 100) / 100;

for (const [label, fg, bg, min] of CHROME) {
  const c = contrast(fg, bg);
  const ok = c >= min;
  if (!ok) fails.push(`${label}: ${r2(c)}:1, needs ${min}:1`);
  rows.push({ group: 'chrome', label, value: r2(c), min, ok });
}

for (const [name, fg, bg] of PILLS) {
  const text = contrast(fg, bg);
  const vs   = contrast(bg, SURFACE);
  if (text < TEXT_MIN) fails.push(`pill ${name} text: ${r2(text)}:1, needs ${TEXT_MIN}:1`);
  // The pill's own background only has to be visible as a shape, not read.
  if (vs < 1.12) fails.push(`pill ${name} bg is invisible against the card: ${r2(vs)}:1`);
  rows.push({ group: 'pill', label: name, value: r2(text), min: TEXT_MIN, ok: text >= TEXT_MIN, bgVsSurface: r2(vs) });
}

for (const [name, hex] of BARS) {
  const c = contrast(hex, SURFACE);
  const ok = c >= UI_MIN;
  if (!ok) fails.push(`bar ${name}: ${r2(c)}:1 against the card, needs ${UI_MIN}:1`);
  rows.push({ group: 'bar', label: name, value: r2(c), min: UI_MIN, ok });
}

// Adjacent separation, which is where the original light palette was weakest.
const seps = [];
for (let i = 0; i < BARS.length - 1; i++) {
  const [n1, c1] = BARS[i], [n2, c2] = BARS[i + 1];
  const normal = deltaE76(c1, c2);
  const cvd = Object.keys(CVD).map(k => deltaE76(simulate(c1, k), simulate(c2, k)));
  const worstCvd = Math.min(...cvd);
  if (normal < DE_NORMAL_MIN) fails.push(`${n1}/${n2}: normal-vision ΔE ${r2(normal)}, floor ${DE_NORMAL_MIN}`);
  if (worstCvd < DE_CVD_MIN)  fails.push(`${n1}/${n2}: worst CVD ΔE ${r2(worstCvd)}, floor ${DE_CVD_MIN}`);
  seps.push({ pair: `${n1} / ${n2}`, normal: r2(normal), worstCvd: r2(worstCvd) });
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, seps, fails }, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\nSurface under test: ${SURFACE} (cards) on ${PAGE} (page)\n`);
  for (const g of ['chrome', 'pill', 'bar']) {
    console.log(`— ${g} —`);
    rows.filter(r => r.group === g).forEach(r => {
      console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${pad(r.label, 18)} ${pad(r.value + ':1', 9)} min ${r.min}:1` +
                  (r.bgVsSurface ? `   pill bg vs card ${r.bgVsSurface}:1` : ''));
    });
    console.log('');
  }
  console.log('— adjacent bar separation —');
  seps.forEach(s => console.log(`  ${pad(s.pair, 32)} normal ΔE ${pad(s.normal, 7)} worst CVD ΔE ${s.worstCvd}`));
  console.log('');
  console.log(fails.length ? `${fails.length} FAILURE(S):\n  ` + fails.join('\n  ') : 'All checks pass.');
}

process.exit(fails.length ? 1 : 0);
