/* Generate the app icons. Run: node tools/make-icons.mjs
   Writes public/icons/*.png and public/favicon.ico.

   Hand-rolled PNG encoding because there is no image library here and adding one
   for a handful of flat shapes is a poor trade. A PNG is a signature, an IHDR, a
   zlib-compressed IDAT of filtered scanlines, and an IEND — zlib is in Node. The
   .ico is a 6-byte header, one 16-byte directory entry, and a whole PNG, which
   Windows has accepted since Vista.

   The mark: the rail's brand mark, flattened. Concentric brass rings on the ink
   ground, four ticks, a bright core, and one frozen frame of the sweep — which
   reads at 16px in a taskbar where a letterform would not.

   The colours below were the OLD theme's and nobody noticed, because a taskbar
   icon is the one part of a redesign you never look at while working: --brass
   was 0x7C6CFF, which is violet, so the app has been shipping a purple icon on
   a blue ground since the board went warm. */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INK   = [0x0E, 0x0D, 0x0C];   // --ink
const BRASS = [0xC9, 0xA9, 0x6B];   // --brass
const CORE  = [0xF2, 0xDC, 0xAE];   // the lit centre
const PLATE = [0x1E, 0x1B, 0x17];   // the plate, a shade off the ground

function crc32(buf){
  let c, crc = 0xFFFFFFFF;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data){
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/* rgba: a Buffer of size*size*4 */
function encodePng(rgba, size){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // 8 bits per channel
  ihdr[9] = 6;    // truecolour with alpha
  /* 10..12 stay zero: deflate, adaptive filtering, no interlace. */

  /* Filter type 0 (None) in front of every scanline. */
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/* Coverage of a pixel by a disc, sampled 3x3 so the edges are not jagged. */
function discCoverage(px, py, cx, cy, r){
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3;
      const y = py + (sy + 0.5) / 3;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) hits++;
    }
  }
  return hits / 9;
}

function roundedSquareCoverage(px, py, size, radius){
  let hits = 0;
  for (let sy = 0; sy < 3; sy++) {
    for (let sx = 0; sx < 3; sx++) {
      const x = px + (sx + 0.5) / 3;
      const y = py + (sy + 0.5) / 3;
      const dx = Math.max(radius - x, x - (size - radius), 0);
      const dy = Math.max(radius - y, y - (size - radius), 0);
      if (dx * dx + dy * dy <= radius * radius) hits++;
    }
  }
  return hits / 9;
}

const mix = (under, over, a) => under.map((c, i) => Math.round(c * (1 - a) + over[i] * a));

/* `pad` leaves room for the safe area a maskable icon needs — Android and
   Windows both crop these, and a mark that fills the square gets clipped. */
/* An annulus, as coverage. Two discs subtracted, which antialiases both edges
   for free because discCoverage already supersamples. */
const ringCoverage = (x, y, c, outer, inner) =>
  Math.max(0, discCoverage(x, y, c, c, outer) - discCoverage(x, y, c, c, inner));

/* The sweep, frozen. The animated mark brightens towards the leading edge of a
   trace; here that is one angular ramp, brightest at `head` and gone by
   `span` behind it. Nothing else in a flat icon says "this thing is working". */
function sweepCoverage(x, y, c, outer, head, span){
  const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
  if (d > outer) return 0;
  let a = Math.atan2(y + 0.5 - c, x + 0.5 - c) - head;
  while (a < 0) a += Math.PI * 2;
  while (a > Math.PI * 2) a -= Math.PI * 2;
  if (a > span) return 0;
  /* Brightest at the head, falling away behind it, and fading at the hub so
     the wedge does not become a solid pie. */
  return (1 - a / span) ** 1.7 * Math.min(1, d / (outer * 0.42));
}

function draw(size, { pad = 0, square = true } = {}){
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const inset = size * pad;
  const boxR = size * 0.22;                     // corner radius of the tile
  const half = size / 2 - inset;
  const ringOuter = half * 0.64;
  const ringMid   = half * 0.36;
  const stroke    = Math.max(1, size * 0.028);
  const dot       = half * 0.14;
  const tickIn    = half * 0.76;
  const tickOut   = half * 0.94;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let px = [0, 0, 0], alpha = 0;

      /* ground */
      const bg = square
        ? roundedSquareCoverage(x, y, size, boxR)
        : discCoverage(x, y, c, c, half);
      if (bg > 0) { px = PLATE; alpha = bg; }

      /* Inside the plate only, so nothing bleeds past the corners. */
      if (bg > 0) {
        const sweep = sweepCoverage(x, y, c, ringOuter, -Math.PI / 2, Math.PI * 0.62);
        if (sweep > 0) px = mix(px, BRASS, sweep * 0.42 * bg);

        const outer = ringCoverage(x, y, c, ringOuter, ringOuter - stroke);
        if (outer > 0) px = mix(px, BRASS, outer * bg);

        const mid = ringCoverage(x, y, c, ringMid, ringMid - stroke * 0.8);
        if (mid > 0) px = mix(px, BRASS, mid * 0.55 * bg);

        /* Four ticks at the quarters, drawn as short radial bars. */
        const dx = x + 0.5 - c, dy = y + 0.5 - c;
        const d = Math.hypot(dx, dy);
        if (d > tickIn && d < tickOut) {
          const near = Math.min(Math.abs(dx), Math.abs(dy));
          const t = Math.max(0, 1 - near / (stroke * 0.75));
          if (t > 0) px = mix(px, BRASS, t * 0.8 * bg);
        }

        const centre = discCoverage(x, y, c, c, dot);
        if (centre > 0) px = mix(px, CORE, centre * bg);
      }

      const o = (y * size + x) * 4;
      rgba[o] = px[0]; rgba[o + 1] = px[1]; rgba[o + 2] = px[2];
      rgba[o + 3] = Math.round(alpha * 255);
    }
  }
  return rgba;
}

function ico(pngBuf, size){
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type 1 = icon
  header.writeUInt16LE(1, 4);      // one image
  const entry = Buffer.alloc(16);
  entry[0] = size >= 256 ? 0 : size;   // 0 means 256
  entry[1] = size >= 256 ? 0 : size;
  entry[2] = 0;                        // palette
  entry[3] = 0;                        // reserved
  entry.writeUInt16LE(1, 4);           // colour planes
  entry.writeUInt16LE(32, 6);          // bits per pixel
  entry.writeUInt32BE(0, 8);           // placeholder, size below
  entry.writeUInt32LE(pngBuf.length, 8);
  entry.writeUInt32LE(6 + 16, 12);     // offset to the image
  return Buffer.concat([header, entry, pngBuf]);
}

/* fileURLToPath, not url.pathname — the path is percent-encoded, so a space in
   the directory name becomes %20 and mkdir fails with EPERM on a name that does
   not exist. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconDir = path.join(root, 'public', 'icons');
fs.mkdirSync(iconDir, { recursive: true });

const wrote = [];
for (const size of [64, 192, 512]) {
  const buf = encodePng(draw(size), size);
  const f = path.join(iconDir, `icon-${size}.png`);
  fs.writeFileSync(f, buf); wrote.push([path.relative(root, f), buf.length]);
}
/* Maskable: the same mark with 18% padding, so cropping to a circle or a
   squircle cannot cut into the ring. */
{
  const buf = encodePng(draw(512, { pad: 0.18 }), 512);
  const f = path.join(iconDir, 'maskable-512.png');
  fs.writeFileSync(f, buf); wrote.push([path.relative(root, f), buf.length]);
}
/* favicon.ico — also what install.ps1 puts on the Start Menu shortcut. */
{
  const png = encodePng(draw(256), 256);
  const f = path.join(root, 'public', 'favicon.ico');
  fs.writeFileSync(f, ico(png, 256)); wrote.push([path.relative(root, f), fs.statSync(f).size]);
}

for (const [f, n] of wrote) console.log('  ' + f.padEnd(30) + (n / 1024).toFixed(1) + ' KB');
