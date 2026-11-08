// Rasterize the supplied geometric SVG at 1024px for Tauri, without dependencies.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const svg = fs.readFileSync(path.join(root, 'public/shellpilot.svg'), 'utf8');
const W = 1024, H = 1024, SAMPLES = 2;
const px = Buffer.alloc(W * H * 4, 0);

function inRoundRect(x, y, x0, y0, w, h, r) {
  if (x < x0 || x >= x0 + w || y < y0 || y >= y0 + h) return false;
  const rx = Math.min(Math.max(x, x0 + r), x0 + w - r);
  const ry = Math.min(Math.max(y, y0 + r), y0 + h - r);
  const dx = x - rx, dy = y - ry;
  return dx * dx + dy * dy <= r * r;
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const attr = (element, name, fallback) => element.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1] ?? fallback;
const rectangles = [...svg.matchAll(/<rect\b[^>]+/g)].map(([element]) => ({
  x: +attr(element, 'x', 0), y: +attr(element, 'y', 0), w: +attr(element, 'width'),
  h: +attr(element, 'height'), r: +attr(element, 'rx', 0), color: rgb(attr(element, 'fill'))
}));
const dark = rgb(svg.match(/<g[^>]*stroke="(#[0-9A-Fa-f]{6})"/)[1]);
const paths = [...svg.matchAll(/<path\b[^>]+/g)].map(([element]) => ({
  points: [...attr(element, 'd').matchAll(/-?\d+(?:\.\d+)?/g)].map(([n]) => +n),
  radius: +attr(element, 'stroke-width') / 2
}));
const segments=paths.flatMap((line)=>{
  const segments=[];
  for(let i=0;i+3<line.points.length;i+=2)segments.push({ax:line.points[i],ay:line.points[i+1],bx:line.points[i+2],by:line.points[i+3],radius:line.radius**2});
  return segments;
});
function distanceSquared(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2;
}
function colorAt(x, y) {
  const background = rectangles[0];
  if (!inRoundRect(x, y, background.x, background.y, background.w, background.h, background.r)) return null;
  for(const segment of segments)if(distanceSquared(x,y,segment.ax,segment.ay,segment.bx,segment.by)<=segment.radius)return dark;
  for (const rectangle of rectangles.slice(1)) {
    if (inRoundRect(x, y, rectangle.x, rectangle.y, rectangle.w, rectangle.h, rectangle.r)) return rectangle.color;
  }
  return background.color;
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    let colors = [0, 0, 0], count = 0;
    for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) {
      const c = colorAt((x + (sx + 0.5) / SAMPLES) * 120 / W, (y + (sy + 0.5) / SAMPLES) * 120 / H);
      if (c) { for (let k = 0; k < 3; k++) colors[k] += c[k]; count++; }
    }
    if (count) {
      const i = (y * W + x) * 4;
      for (let k = 0; k < 3; k++) px[i + k] = Math.round(colors[k] / count);
      px[i + 3] = Math.round(255 * count / (SAMPLES ** 2));
    }
  }
}

// --- 最小 PNG 编码器 ---
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
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
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
function pngEncode(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), pngEncode(px, W, H));
console.log('图标已生成: build/icon.png (1024x1024), source: public/shellpilot.svg');
