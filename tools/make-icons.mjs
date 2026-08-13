#!/usr/bin/env node
// Generates the extension icons with no image dependencies: a dark rounded tile with
// a Luas-green and DART-green route crossing it. Run once; output is committed.
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../extension/public/icons'
);

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
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

function png(size, pixel) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      const off = y * (stride + 1) + 1 + x * 4;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      raw[off + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Distance from a point to a segment, in pixel units. */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Luas green and red: two visibly different lines, rather than two greens that merge
// into a single X at 16px.
const BG = [18, 48, 63];
const GREEN = [0, 169, 79];
const DART = [229, 41, 42];

function pixel(x, y, size) {
  const s = size / 128;
  const radius = 26 * s;

  // Rounded-rect mask.
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  const corner = Math.hypot(x - cx, y - cy);
  if (corner > radius) return [0, 0, 0, 0];

  const lineW = 9 * s;
  const dGreen = distToSegment(x, y, 26 * s, 100 * s, 102 * s, 30 * s);
  const dDart = distToSegment(x, y, 26 * s, 42 * s, 102 * s, 96 * s);

  if (dGreen < lineW / 2) return [...GREEN, 255];
  if (dDart < lineW / 2) return [...DART, 255];

  // Two station dots on the green line.
  for (const [sx, sy] of [
    [48 * s, 81 * s],
    [80 * s, 51 * s],
  ]) {
    if (Math.hypot(x - sx, y - sy) < 6 * s) return [255, 255, 255, 255];
  }

  const edge = Math.max(0, Math.min(1, (radius - corner) / (1.5 * s)));
  return [...BG, Math.round(255 * edge)];
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  await writeFile(path.join(outDir, `icon${size}.png`), png(size, pixel));
}
console.log(`Wrote icons to ${outDir}`);
