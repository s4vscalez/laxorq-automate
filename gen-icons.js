// Generates the PWA icon set (real PNGs, no dependencies) into public/icons/.
// Design: ink background + a rising 3-bar chart (leads & conversions going up),
// tallest bar in Laxorq green. Run once: node gen-icons.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT = path.join(__dirname, 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- minimal PNG (RGBA, no interlace) ----
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function draw(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, r, g, b, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  };
  const rect = (x0, y0, w, h, col) => {
    for (let y = Math.round(y0); y < Math.round(y0 + h); y++)
      for (let x = Math.round(x0); x < Math.round(x0 + w); x++) set(x, y, col[0], col[1], col[2]);
  };
  // background: ink
  rect(0, 0, size, size, [13, 13, 13]);

  const silver = [194, 194, 194];
  const green = [76, 175, 110];
  const baseY = size * 0.74;
  const barW = size * 0.14;
  const gap = size * 0.08;
  const totalW = barW * 3 + gap * 2;
  const startX = (size - totalW) / 2;
  const heights = [0.20, 0.32, 0.46];
  heights.forEach((h, i) => {
    const bh = size * h;
    const x = startX + i * (barW + gap);
    rect(x, baseY - bh, barW, bh, i === 2 ? green : silver);
  });
  return encodePNG(size, size, buf);
}

for (const size of [32, 180, 192, 512]) {
  fs.writeFileSync(path.join(OUT, `icon-${size}.png`), draw(size));
  console.log(`wrote icon-${size}.png`);
}
console.log('Done.');
