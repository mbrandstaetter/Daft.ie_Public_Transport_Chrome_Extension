#!/usr/bin/env node
/**
 * Zips dist/ into the upload artefact for the Chrome Web Store.
 *
 * Writes a plain (stored, uncompressed-optional) ZIP with node:zlib rather than pulling in
 * a dependency - same reasoning as the GTFS unzipper in build-transport-data.mjs.
 *
 *   npm run package   ->  release/dublin-commute-overlay-<version>.zip
 */
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'release');

// Never ship the development harness to the Store.
const EXCLUDE = new Set(['preview.html', 'preview-inline.html']);

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (EXCLUDE.has(rel)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push({ rel, full });
  }
  return out;
}

/** DOS date/time, fixed so repeated builds of identical input produce identical zips. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function localHeader(name, crc, comp, raw) {
  const n = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(30);
  h.writeUInt32LE(0x04034b50, 0);
  h.writeUInt16LE(20, 4);       // version needed
  h.writeUInt16LE(0x800, 6);    // UTF-8 filename flag
  h.writeUInt16LE(8, 8);        // deflate
  h.writeUInt16LE(DOS_TIME, 10);
  h.writeUInt16LE(DOS_DATE, 12);
  h.writeUInt32LE(crc, 14);
  h.writeUInt32LE(comp, 18);
  h.writeUInt32LE(raw, 22);
  h.writeUInt16LE(n.length, 26);
  return Buffer.concat([h, n]);
}

function centralHeader(name, crc, comp, raw, offset) {
  const n = Buffer.from(name, 'utf8');
  const h = Buffer.alloc(46);
  h.writeUInt32LE(0x02014b50, 0);
  h.writeUInt16LE(20, 4);
  h.writeUInt16LE(20, 6);
  h.writeUInt16LE(0x800, 8);
  h.writeUInt16LE(8, 10);
  h.writeUInt16LE(DOS_TIME, 12);
  h.writeUInt16LE(DOS_DATE, 14);
  h.writeUInt32LE(crc, 16);
  h.writeUInt32LE(comp, 20);
  h.writeUInt32LE(raw, 24);
  h.writeUInt16LE(n.length, 28);
  h.writeUInt32LE(offset, 42);
  return Buffer.concat([h, n]);
}

if (!existsSync(path.join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json missing — run `npm run build` first.');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
const files = (await walk(dist)).sort((a, b) => a.rel.localeCompare(b.rel));

const parts = [];
const central = [];
let offset = 0;

for (const file of files) {
  const raw = await readFile(file.full);
  const comp = deflateRawSync(raw, { level: 9 });
  const sum = crc32(raw);
  const local = localHeader(file.rel, sum, comp.length, raw.length);
  parts.push(local, comp);
  central.push(centralHeader(file.rel, sum, comp.length, raw.length, offset));
  offset += local.length + comp.length;
}

const dir = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dir.length, 12);
end.writeUInt32LE(offset, 16);

await mkdir(outDir, { recursive: true });
const zipPath = path.join(outDir, `dublin-commute-overlay-${manifest.version}.zip`);
await writeFile(zipPath, Buffer.concat([...parts, dir, end]));

const size = (await stat(zipPath)).size;
console.log(`\n  ${path.relative(root, zipPath)}  (${(size / 1024).toFixed(0)} KB, ${files.length} files)`);
console.log(`  name:    ${manifest.name}`);
console.log(`  version: ${manifest.version}`);
console.log('\n  Upload at https://chrome.google.com/webstore/devconsole\n');
