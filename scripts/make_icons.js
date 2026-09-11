#!/usr/bin/env node
//
// Renders the app icon to PNG at any size, with no dependencies.
//
// The icon is a receipt on the app's teal-to-green gradient — the same ramp the
// weekly-goal hero uses, so the icon and the app agree. The receipt body is
// a lifted dark surface rather than a hole punched through to the background:
// cut-outs were tried first and collapsed into a dark blob below ~56px, because
// the cut lines were the same gradient as the surround and merged with it.
// Lines are grey rather than green so they read as content on the receipt, not
// as a second green element competing with the ground.
//
// Everything is authored at 512 and scaled, and drawn with 3x3 supersampling
// for antialiasing. Output is RGB (no alpha) since the art is full-bleed and
// opaque — which is also what makes it safe as a maskable icon.
//
// Usage:
//   node scripts/make_icons.js                 # writes the sizes in SIZES
//   node scripts/make_icons.js 1024            # one arbitrary size

const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const SIZES = [192, 512];
const OUT = (size) => path.join(__dirname, "..", `icon-receipt-${size}.png`);

// ── palette ───────────────────────────────────────────────────────────────
// Deliberately deeper than a lime ramp. The first pass was bright lime, which
// read as an energy drink rather than a finance app once it was sitting on a
// home screen at 34px. Must stay in step with --hero-good in style.css.
const GRADIENT = [
  [0.00, [0x3f, 0xbf, 0xa8]],
  [0.48, [0x4a, 0xa8, 0x7e]],
  [1.00, [0x6f, 0x9e, 0x4a]],
];
const BODY = [0x17, 0x1a, 0x24];   // receipt surface, --surface nudged
const LINE = [0x9a, 0xa0, 0xae];   // mid grey

// ── geometry, authored at 512 ─────────────────────────────────────────────
const A = 512;
const W = 200, H = 252;
const L = (A - W) / 2, T = (A - H) / 2 - 6;
const R = L + W;
const RAD = 26;                     // top corners only
const TEETH = 6, TOOTH_H = 26;
const B = T + H - TOOTH_H;          // where the body stops and the teeth start
const TW = W / TEETH;
const PAD = 30, LW = 26;            // line inset and stroke width
const LINES = [
  [T + 72,  1.00],
  [T + 128, 1.00],
  [T + 184, 0.55],
];

// ── hit tests, all in 512-space ───────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;

function gradientAt(x, y) {
  // Matches CSS linear-gradient(125deg, ...) closely enough: project onto the
  // vector the canvas version used, (0,0) -> (0.9*A, A).
  const vx = 0.9 * A, vy = A;
  const t = Math.min(1, Math.max(0, (x * vx + y * vy) / (vx * vx + vy * vy)));
  for (let i = 1; i < GRADIENT.length; i++) {
    const [t0, c0] = GRADIENT[i - 1], [t1, c1] = GRADIENT[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
    }
  }
  return GRADIENT[GRADIENT.length - 1][1];
}

function inBody(x, y) {
  if (x < L || x > R || y < T || y > B) return false;
  // Round the top two corners only; the bottom edge meets the teeth.
  if (y < T + RAD) {
    if (x < L + RAD) return (x - (L + RAD)) ** 2 + (y - (T + RAD)) ** 2 <= RAD * RAD;
    if (x > R - RAD) return (x - (R - RAD)) ** 2 + (y - (T + RAD)) ** 2 <= RAD * RAD;
  }
  return true;
}

function inTeeth(x, y) {
  if (y < B || y > B + TOOTH_H || x < L || x > R) return false;
  const i = Math.floor((x - L) / TW);
  const localX = (x - L) - i * TW;          // 0..TW across this tooth
  const half = TW / 2;
  // A downward triangle: width shrinks linearly to a point at the bottom.
  const depth = (y - B) / TOOTH_H;          // 0 at the base, 1 at the tip
  const halfWidthHere = half * (1 - depth);
  return Math.abs(localX - half) <= halfWidthHere;
}

function onLine(x, y) {
  const r = LW / 2;
  for (const [ly, frac] of LINES) {
    const x1 = L + PAD, x2 = x1 + (W - PAD * 2) * frac;
    const cx = Math.min(x2, Math.max(x1, x));   // nearest point on the segment
    if ((x - cx) ** 2 + (y - ly) ** 2 <= r * r) return true;
  }
  return false;
}

function colorAt(x, y) {
  if (onLine(x, y)) return LINE;
  if (inBody(x, y) || inTeeth(x, y)) return BODY;
  return gradientAt(x, y);
}

// ── raster ────────────────────────────────────────────────────────────────
function render(size) {
  const SS = 3;                               // 3x3 supersampling
  const scale = A / size;
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let p = 0;
  for (let py = 0; py < size; py++) {
    raw[p++] = 0;                             // PNG filter byte: none
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = colorAt((px + (sx + 0.5) / SS) * scale, (py + (sy + 0.5) / SS) * scale);
          r += c[0]; g += c[1]; b += c[2];
        }
      }
      const n = SS * SS;
      raw[p++] = Math.round(r / n);
      raw[p++] = Math.round(g / n);
      raw[p++] = Math.round(b / n);
    }
  }
  return raw;
}

// ── minimal PNG writer ────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;      // bit depth
  ihdr[9] = 2;      // colour type 2 = truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sizes = process.argv[2] ? [parseInt(process.argv[2], 10)] : SIZES;
for (const size of sizes) {
  const file = OUT(size);
  fs.writeFileSync(file, png(size, render(size)));
  console.log(`${path.basename(file)}  ${size}x${size}  ${Math.round(fs.statSync(file).size / 1024)}KB`);
}
