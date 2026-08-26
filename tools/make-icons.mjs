/* Generate the app icons. Run: node tools/make-icons.mjs
   Writes public/icons/*.png and public/favicon.ico.

   Hand-rolled PNG encoding because there is no image library here and adding one
   for a handful of flat shapes is a poor trade. A PNG is a signature, an IHDR, a
   zlib-compressed IDAT of filtered scanlines, and an IEND — zlib is in Node. The
   .ico is a 6-byte header, one 16-byte directory entry, and a whole PNG, which
   Windows has accepted since Vista.

   The mark: the rail's brand pulse. A brass ring on the ink ground with a filled
   centre, which reads at 16px in a taskbar where a letterform would not. */

import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INK   = [0x0E, 0x11, 0x20];   // --ink
const BRASS = [0x7C, 0x6C, 0xFF];   // --brass
const JADE  = [0x35, 0xD0, 0xA5];   // --jade

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
function draw(size, { pad = 0, square = true } = {}){
  const rgba = Buffer.alloc(size * size * 4);
  const c = size / 2;
  const inset = size * pad;
  const boxR = size * 0.22;                     // corner radius of the tile
  const ringOuter = (size / 2 - inset) * 0.62;
  const ringInner = ringOuter * 0.70;
  const dot = ringOuter * 0.34;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let px = [0, 0, 0], alpha = 0;

      /* ground */
      const bg = square
        ? roundedSquareCoverage(x, y, size, boxR)
        : discCoverage(x, y, c, c, size / 2 - 0.5);
      if (bg > 0) { px = INK; alpha = bg; }

      /* brass ring: inside the outer disc, outside the inner one */
      const ring = Math.max(0, discCoverage(x, y, c, c, ringOuter) - discCoverage(x, y, c, c, ringInner));
      if (ring > 0) { px = mix(px, BRASS, ring); alpha = Math.max(alpha, ring); }

      /* live dot, jade — the same "it is running" green as the rail */
      const centre = discCoverage(x, y, c, c, dot);
      if (centre > 0) { px = mix(px, JADE, centre); alpha = Math.max(alpha, centre); }

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
