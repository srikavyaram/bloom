// Generates Bloom's PNG app icons using only Node built-ins (zlib + fs).
//
// Design: a warm "sunrise" gradient (pink -> coral -> gold) with a white
// five-petal flower whose golden centre carries a white check mark.
// Shapes are described with signed distance functions in a normalised
// coordinate space ([-1, 1] across the icon) and rasterised with 4x4
// supersampling for smooth anti-aliased edges.
//
// Usage: node scripts/gen-icons.mjs   (or: npm run icons)

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'icons');

// ---------------------------------------------------------------- PNG encoder

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode RGBA8 pixels (Uint8Array, length w*h*4) as a PNG buffer. */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------------ helpers

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// Sunrise palette (keep in sync with icons/icon.svg and manifest colours).
const STOPS = [
  [0.0, hex('#FF6F91')], // rosy pink (top)
  [0.5, hex('#FF9671')], // coral
  [1.0, hex('#FFC75F')], // golden (bottom)
];
const CENTER = hex('#FFB547');
const CENTER_EDGE = hex('#FF9A3C');
const WHITE = [255, 255, 255];

function gradient(t) {
  t = clamp01(t);
  for (let i = 1; i < STOPS.length; i++) {
    const [p1, c1] = STOPS[i];
    const [p0, c0] = STOPS[i - 1];
    if (t <= p1) {
      const k = (t - p0) / (p1 - p0);
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// Signed distance functions (negative = inside).
const sdCircle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const sdRoundRect = (x, y, half, rad) => {
  const qx = Math.abs(x) - half + rad, qy = Math.abs(y) - half + rad;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad;
};
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}
// Approximate ellipse SDF (good enough for fills and soft shadows).
function sdEllipse(x, y, cx, cy, a, b, angle) {
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = x - cx, dy = y - cy;
  const u = dx * c + dy * s, v = -dx * s + dy * c;
  return (Math.hypot(u / a, v / b) - 1) * Math.min(a, b);
}

// ------------------------------------------------------------------- design

const PETALS = 5;
const PETAL_DIST = 0.33;
const PETAL_A = 0.25; // radial semi-axis
const PETAL_B = 0.19; // tangential semi-axis
const CENTER_R = 0.235;
const CHECK = [[-0.105, 0.005], [-0.03, 0.08], [0.115, -0.075]];
const CHECK_W = 0.055;

/** Distance to the flower's petal silhouette (in content space). */
function sdPetals(x, y) {
  let d = Infinity;
  for (let i = 0; i < PETALS; i++) {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / PETALS;
    const cx = Math.cos(ang) * PETAL_DIST, cy = Math.sin(ang) * PETAL_DIST;
    d = Math.min(d, sdEllipse(x, y, cx, cy, PETAL_A, PETAL_B, ang));
  }
  return d;
}

const sdCheck = (x, y) =>
  Math.min(sdSegment(x, y, ...CHECK[0], ...CHECK[1]), sdSegment(x, y, ...CHECK[1], ...CHECK[2])) - CHECK_W / 2;

/**
 * Colour a single sample.
 * @param {number} x,y  icon space in [-1, 1]
 * @param {object} o    { shape: 'circle'|'square'|'rounded', scale, mono }
 * @returns {[r,g,b,a]} straight (non-premultiplied) colour, a in [0,1]
 */
function sample(x, y, o) {
  // Background silhouette.
  let inBg;
  if (o.shape === 'circle') inBg = sdCircle(x, y, 0, 0, 0.98) <= 0;
  else if (o.shape === 'rounded') inBg = sdRoundRect(x, y, 0.98, 0.42) <= 0;
  else inBg = true;

  // Content space (flower centred, slightly raised, scaled for safe zones).
  const cx = x / o.scale, cy = (y + 0.0) / o.scale;

  if (o.mono) {
    // Monochrome notification badge: white flower with the check cut out.
    const flower = Math.min(sdPetals(cx, cy), sdCircle(cx, cy, 0, 0, CENTER_R));
    const inside = flower <= 0 && sdCheck(cx, cy) > 0 &&
      !(sdCircle(cx, cy, 0, 0, CENTER_R + 0.03) > 0 && sdCircle(cx, cy, 0, 0, CENTER_R + 0.0) <= 0);
    return inside ? [255, 255, 255, 1] : [0, 0, 0, 0];
  }

  if (!inBg) return [0, 0, 0, 0];

  // Diagonal sunrise gradient + a soft glow in the upper-left.
  let col = gradient((y * 0.85 + x * 0.35 + 1) / 2);
  const glow = (1 - smoothstep(0, 1.1, Math.hypot(x + 0.45, y + 0.55))) * 0.22;
  col = col.map((c) => lerp(c, 255, glow));

  // Soft drop shadow under the flower.
  const sh = Math.min(sdPetals(cx, cy - 0.05), sdCircle(cx, cy - 0.05, 0, 0, CENTER_R));
  const shadowA = (1 - smoothstep(-0.02, 0.09, sh)) * 0.2;
  col = col.map((c, i) => lerp(c, [170, 60, 40][i], shadowA));

  // Petals.
  if (sdPetals(cx, cy) <= 0) {
    // Subtle inner shading towards the centre so petals read as petals.
    const r = Math.hypot(cx, cy);
    const tint = 1 - smoothstep(CENTER_R, 0.55, r);
    col = WHITE.map((c, i) => lerp(c, [255, 232, 222][i], tint * 0.6));
  }

  // Golden centre with radial shading.
  const dc = sdCircle(cx, cy, 0, 0, CENTER_R);
  if (dc <= 0) {
    const t = clamp01(Math.hypot(cx + 0.06, cy + 0.07) / (CENTER_R * 1.4));
    col = CENTER.map((c, i) => lerp(c, CENTER_EDGE[i], t));
    if (sdCheck(cx, cy) <= 0) col = WHITE;
  }
  return [col[0], col[1], col[2], 1];
}

/** Rasterise one icon with SS x SS supersampling. */
function render(size, opts, ss = 4) {
  const px = new Uint8Array(size * size * 4);
  const n = ss * ss;
  for (let py = 0; py < size; py++) {
    for (let pxl = 0; pxl < size; pxl++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const x = ((pxl + (sx + 0.5) / ss) / size) * 2 - 1;
          const y = ((py + (sy + 0.5) / ss) / size) * 2 - 1;
          const [cr, cg, cb, ca] = sample(x, y, opts);
          r += cr * ca; g += cg * ca; b += cb * ca; a += ca; // premultiplied accumulate
        }
      }
      const i = (py * size + pxl) * 4;
      if (a > 0) {
        px[i] = Math.round(r / a);
        px[i + 1] = Math.round(g / a);
        px[i + 2] = Math.round(b / a);
      }
      px[i + 3] = Math.round((a / n) * 255);
    }
  }
  return encodePNG(size, size, px);
}

// ------------------------------------------------------------------ outputs

const ICONS = [
  // "any" purpose icons: a round gradient badge on transparency.
  { file: 'icon-192.png', size: 192, opts: { shape: 'circle', scale: 1 } },
  { file: 'icon-512.png', size: 512, opts: { shape: 'circle', scale: 1 } },
  // Maskable: full-bleed background, artwork kept inside the 80% safe zone.
  { file: 'maskable-512.png', size: 512, opts: { shape: 'square', scale: 0.95 } },
  // iOS ignores transparency (renders black), so fill the square; iOS rounds corners itself.
  { file: 'apple-touch-icon.png', size: 180, opts: { shape: 'square', scale: 1.05 } },
  { file: 'favicon-32.png', size: 32, opts: { shape: 'circle', scale: 1.08 } },
  // Android status-bar badge: white silhouette, alpha only.
  { file: 'badge-96.png', size: 96, opts: { mono: true, scale: 1.45 } },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, opts } of ICONS) {
  const buf = render(size, opts);
  writeFileSync(join(OUT, file), buf);
  console.log(`icons/${file}  ${size}x${size}  ${(buf.length / 1024).toFixed(1)} KB`);
}
