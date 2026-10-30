// icons/icon.svg와 같은 모양의 PNG 아이콘(192, 512)을 만든다. 실행: node tools/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const INK = [0x16, 0x18, 0x1b];
const WHITE = [255, 255, 255];
const BLUE = [0x24, 0x53, 0xd6];

// 카메라 몸통 외곽선 (512 좌표계)을 선분 목록으로
function bodyPath() {
  const pts = [];
  const arc = (cx, cy, r, a0, a1) => {
    for (let i = 0; i <= 12; i++) {
      const a = a0 + ((a1 - a0) * i) / 12;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  };
  const P = Math.PI;
  pts.push([164, 168], [200, 168], [222, 138], [290, 138], [312, 168], [348, 168]);
  arc(348, 196, 28, -P / 2, 0);
  pts.push([376, 336]);
  arc(348, 336, 28, 0, P / 2);
  pts.push([164, 364]);
  arc(164, 336, 28, P / 2, P);
  pts.push([136, 196]);
  arc(164, 196, 28, P, 1.5 * P);
  const segs = [];
  for (let i = 0; i < pts.length - 1; i++) segs.push([pts[i], pts[i + 1]]);
  return segs;
}

function segDist(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax, dy = by - ay;
  const len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len));
  const x = ax + t * dx - px, y = ay + t * dy - py;
  return Math.sqrt(x * x + y * y);
}

function minDist(px, py, segs) {
  let d = Infinity;
  for (const s of segs) d = Math.min(d, segDist(px, py, s));
  return d;
}

const BODY = bodyPath();
const ARROW = [[[356, 380], [356, 334]], [[336, 352], [356, 332]], [[356, 332], [376, 352]]];

function insideRoundRect(x, y, w, h, r) {
  const qx = Math.max(Math.abs(x - w / 2) - (w / 2 - r), 0);
  const qy = Math.max(Math.abs(y - h / 2) - (h / 2 - r), 0);
  return qx * qx + qy * qy <= r * r;
}

// 한 점의 색 (투명이면 null)
function sample(x, y) {
  if (!insideRoundRect(x, y, 512, 512, 112)) return null;
  const bd = Math.hypot(x - 356, y - 356);
  if (bd <= 56) return minDist(x, y, ARROW) <= 7 ? WHITE : BLUE;
  if (Math.abs(Math.hypot(x - 256, y - 264) - 52) <= 13) return WHITE;
  if (x > 115 && x < 397 && y > 117 && y < 385 && minDist(x, y, BODY) <= 13) return WHITE;
  return INK;
}

function render(size) {
  const S = 3; // 3x3 샘플로 가장자리를 부드럽게
  const scale = 512 / size;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const c = sample((px + (sx + 0.5) / S) * scale, (py + (sy + 0.5) / S) * scale);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a++; }
        }
      }
      const o = py * (size * 4 + 1) + 1 + px * 4;
      raw[o] = a ? Math.round(r / a) : 0;
      raw[o + 1] = a ? Math.round(g / a) : 0;
      raw[o + 2] = a ? Math.round(b / a) : 0;
      raw[o + 3] = Math.round((a / (S * S)) * 255);
    }
  }
  return png(size, raw);
}

const CRC = (() => {
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
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const out = path.join(__dirname, '..', 'icons');
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), render(size));
  console.log(`icons/icon-${size}.png`);
}
