#!/usr/bin/env node
/**
 * Turns NTA/TFI GTFS feeds into the compact GeoJSON the extension ships with.
 *
 * Why a build step at all: Transitous' /api/experimental/map/routes returns polyline
 * *indices* with no geometry (~500KB for a small Dublin bbox, plus one request per
 * route to resolve). Fetching network geometry per viewport is not viable, so the
 * geometry is precomputed here and the live API is used only for routing.
 *
 *   node tools/build-transport-data.mjs [--keep] [--bus]
 *
 * Output: extension/public/data/{dublin-rail-lines,dublin-rail-stops}.json
 *         extension/public/data/ATTRIBUTION.md
 */
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(root, '.tmp/gtfs');
const outDir = path.join(root, 'extension/public/data');

// Resolved 2026-08-12 by probing; these are the live paths behind the data.gov.ie
// dataset pages, which are more stable than the portal's own resource links.
// GTFS_LUAS.zip is uppercase - GTFS_Luas.zip 404s.
const FEEDS = [
  { key: 'luas', url: 'https://www.transportforireland.ie/transitData/Data/GTFS_LUAS.zip' },
  { key: 'irishrail', url: 'https://www.transportforireland.ie/transitData/Data/GTFS_Irish_Rail.zip' },
];

// Greater Dublin. Lines running beyond it (Sligo, Cork, Belfast) are clipped at the
// edge rather than dropped, so a commuter line still reads as "heads north out of town".
const BBOX = { w: -6.65, s: 53.10, e: -5.90, n: 53.70 };
const MARGIN = 0.08;

// Neither feed populates route_color - both ship the column empty. This table is the
// primary colour source, not a fallback. Values are the operators' own brand colours.
const COLORS = {
  'Luas Green': '#00A94F',
  'Luas Red': '#E5292A',
  DART: '#0F8C3B',
  Commuter: '#4B2E83',
  InterCity: '#8A8D8F',
};

const SIMPLIFY_TOLERANCE_M = 8;
const MAX_LINES_BYTES = 2 * 1024 * 1024;

/* ------------------------------- CSV parsing ------------------------------ */

/** Minimal RFC4180 parser. GTFS quotes fields containing commas (stop names do). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().replace(/^﻿/, ''));
  return rows.slice(1).filter((r) => r.length > 1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

async function readTable(feedKey, file) {
  return parseCsv(await readFile(path.join(tmp, feedKey, file), 'utf8'));
}

/* --------------------------------- geometry -------------------------------- */

const inBox = ([lon, lat]) =>
  lon >= BBOX.w - MARGIN && lon <= BBOX.e + MARGIN &&
  lat >= BBOX.s - MARGIN && lat <= BBOX.n + MARGIN;

/** Split a polyline into the runs that fall inside the bbox, keeping one point of
 *  overhang each side so clipped lines run to the edge instead of stopping short. */
function clipToBox(coords) {
  const parts = [];
  let cur = [];
  for (let i = 0; i < coords.length; i++) {
    if (inBox(coords[i])) {
      if (!cur.length && i > 0) cur.push(coords[i - 1]);
      cur.push(coords[i]);
    } else if (cur.length) {
      cur.push(coords[i]);
      parts.push(cur);
      cur = [];
    }
  }
  if (cur.length) parts.push(cur);
  return parts.filter((p) => p.length >= 2);
}

const M_PER_DEG_LAT = 111_320;
function perpDistanceM(p, a, b) {
  const latRad = (a[1] * Math.PI) / 180;
  const kx = M_PER_DEG_LAT * Math.cos(latRad);
  const px = (p[0] - a[0]) * kx, py = (p[1] - a[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * kx, by = (b[1] - a[1]) * M_PER_DEG_LAT;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / len2));
  return Math.hypot(px - t * bx, py - t * by);
}

function simplify(coords, tolM) {
  if (coords.length <= 2) return coords;
  let maxD = 0, idx = 0;
  for (let i = 1; i < coords.length - 1; i++) {
    const d = perpDistanceM(coords[i], coords[0], coords[coords.length - 1]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD <= tolM) return [coords[0], coords[coords.length - 1]];
  return [
    ...simplify(coords.slice(0, idx + 1), tolM).slice(0, -1),
    ...simplify(coords.slice(idx), tolM),
  ];
}

const round5 = (c) => [Math.round(c[0] * 1e5) / 1e5, Math.round(c[1] * 1e5) / 1e5];

function lengthM(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
    const kx = M_PER_DEG_LAT * Math.cos((y1 * Math.PI) / 180);
    total += Math.hypot((x2 - x1) * kx, (y2 - y1) * M_PER_DEG_LAT);
  }
  return total;
}

/* ---------------------------------- unzip --------------------------------- */

/**
 * Extracts a ZIP using only node:zlib. Shelling out to `tar`/`unzip` is not portable
 * enough here: GNU tar under Git Bash on Windows reads `C:\...` as a remote host and
 * tries to resolve it. GTFS archives are flat and use store/deflate only.
 */
async function unzipTo(zipPath, destDir) {
  const buf = await readFile(zipPath);

  // End of central directory: scan back from the tail (comment is usually empty).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(`${path.basename(zipPath)}: no ZIP end-of-central-directory`);

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOff = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith('/')) continue;
    // Local header repeats the name/extra lengths, which may differ from the central copy.
    const lnameLen = buf.readUInt16LE(localOff + 26);
    const lextraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + compSize);
    const data = method === 0 ? raw : inflateRawSync(raw);

    const outPath = path.join(destDir, path.basename(name));
    await writeFile(outPath, data);
  }
}

/* -------------------------------- download -------------------------------- */

async function fetchFeeds() {
  await mkdir(tmp, { recursive: true });
  for (const feed of FEEDS) {
    const zip = path.join(tmp, `${feed.key}.zip`);
    const dir = path.join(tmp, feed.key);
    if (existsSync(path.join(dir, 'routes.txt'))) {
      console.log(`  ${feed.key}: cached`);
      continue;
    }
    if (!existsSync(zip)) {
      process.stdout.write(`  ${feed.key}: downloading... `);
      const res = await fetch(feed.url);
      if (!res.ok) throw new Error(`${feed.url} -> HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
      console.log(`${((await stat(zip)).size / 1e6).toFixed(1)} MB`);
    }
    await mkdir(dir, { recursive: true });
    await unzipTo(zip, dir);
  }
}

/* -------------------------------- classify -------------------------------- */

function classify(route) {
  const short = (route.route_short_name || '').trim();
  const long = (route.route_long_name || '').trim();
  if (route.route_type === '0') {
    const name = /green/i.test(route.route_id) ? 'Green' : 'Red';
    return { mode: 'luas', name: `Luas ${name}`, label: `Luas ${name}`, detail: long };
  }
  if (/^dart$/i.test(short)) return { mode: 'dart', name: 'DART', label: 'DART', detail: long };
  if (/^commuter$/i.test(short)) return { mode: 'commuter', name: 'Commuter', label: 'Commuter', detail: long };
  if (/^intercity$/i.test(short)) return { mode: 'commuter', name: 'InterCity', label: 'InterCity', detail: long };
  return { mode: 'commuter', name: 'Commuter', label: 'Rail', detail: long };
}

/* ---------------------------------- main ---------------------------------- */

async function buildLines() {
  const features = [];
  const seenNames = new Set();

  for (const feed of FEEDS) {
    const routes = await readTable(feed.key, 'routes.txt');
    const trips = await readTable(feed.key, 'trips.txt');

    // shapes.txt is the big one (21 MB for Irish Rail); stream-group it by id.
    const shapePoints = new Map();
    for (const row of await readTable(feed.key, 'shapes.txt')) {
      let arr = shapePoints.get(row.shape_id);
      if (!arr) shapePoints.set(row.shape_id, (arr = []));
      arr.push([Number(row.shape_pt_lon), Number(row.shape_pt_lat), Number(row.shape_pt_sequence)]);
    }
    for (const arr of shapePoints.values()) {
      arr.sort((a, b) => a[2] - b[2]);
    }

    // One representative geometry per route: the longest shape any of its trips uses.
    const bestByRoute = new Map();
    for (const trip of trips) {
      if (!trip.shape_id) continue;
      const pts = shapePoints.get(trip.shape_id);
      if (!pts || pts.length < 2) continue;
      const prev = bestByRoute.get(trip.route_id);
      if (!prev || pts.length > prev.length) bestByRoute.set(trip.route_id, pts);
    }

    for (const route of routes) {
      const pts = bestByRoute.get(route.route_id);
      if (!pts) continue;
      const parts = clipToBox(pts.map((p) => [p[0], p[1]]))
        .map((part) => simplify(part, SIMPLIFY_TOLERANCE_M).map(round5))
        .filter((part) => part.length >= 2 && lengthM(part) > 300);
      if (!parts.length) continue;

      const info = classify(route);
      seenNames.add(info.name);
      features.push({
        type: 'Feature',
        properties: {
          routeId: route.route_id,
          name: info.label,
          detail: info.detail,
          mode: info.mode,
          color: (route.route_color && `#${route.route_color}`) || COLORS[info.name] || '#666666',
        },
        geometry:
          parts.length === 1
            ? { type: 'LineString', coordinates: parts[0] }
            : { type: 'MultiLineString', coordinates: parts },
      });
    }
  }
  return { features: mergeIdenticalGeometry(features), seenNames };
}

/**
 * Long-distance routes share a corridor out of Dublin and, once clipped to the bbox,
 * become the same line: Cork/Galway/Limerick/Tralee/Westport are all "Heuston to the
 * Kildare boundary". Drawn separately they stack invisibly and make hover ambiguous,
 * so collapse them into one feature listing every destination it serves.
 */
function mergeIdenticalGeometry(features) {
  // Their coordinates differ by a few metres (separately surveyed shapes for the same
  // track), so an exact key never matches. Signature on endpoints at ~100 m and total
  // length at ~200 m: two rail routes agreeing on all three are the same corridor.
  const signature = (f) => {
    const parts = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates;
    const flat = parts.flat();
    const r3 = (c) => `${c[0].toFixed(3)},${c[1].toFixed(3)}`;
    const total = parts.reduce((sum, p) => sum + lengthM(p), 0);
    return `${f.properties.mode}|${r3(flat[0])}|${r3(flat[flat.length - 1])}|${Math.round(total / 200)}`;
  };

  const byGeom = new Map();
  for (const f of features) {
    const key = signature(f);
    const existing = byGeom.get(key);
    if (existing) {
      existing.properties.detail += ` / ${f.properties.detail.replace(/^Dublin - /, '')}`;
      existing.properties.routeId += `,${f.properties.routeId}`;
    } else {
      byGeom.set(key, f);
    }
  }
  return [...byGeom.values()];
}

async function buildStops() {
  const features = [];
  for (const feed of FEEDS) {
    const mode = feed.key === 'luas' ? 'luas' : 'rail';
    // Only stops actually served by a trip in this feed, so disused entries drop out.
    const served = new Set((await readTable(feed.key, 'stop_times.txt')).map((r) => r.stop_id));
    for (const stop of await readTable(feed.key, 'stops.txt')) {
      const lon = Number(stop.stop_lon), lat = Number(stop.stop_lat);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      if (!inBox([lon, lat])) continue;
      if (served.size && !served.has(stop.stop_id)) continue;
      if (stop.location_type === '1') continue; // parent stations duplicate platforms
      features.push({
        type: 'Feature',
        properties: { stopId: stop.stop_id, name: stop.stop_name, mode },
        geometry: { type: 'Point', coordinates: round5([lon, lat]) },
      });
    }
  }
  // Collapse platform-level duplicates that share a name and sit within ~40 m.
  const kept = [];
  for (const f of features) {
    const dup = kept.find(
      (k) =>
        k.properties.name === f.properties.name &&
        Math.abs(k.geometry.coordinates[1] - f.geometry.coordinates[1]) < 0.0004 &&
        Math.abs(k.geometry.coordinates[0] - f.geometry.coordinates[0]) < 0.0007
    );
    if (!dup) kept.push(f);
  }
  return kept;
}

async function main() {
  console.log('Fetching GTFS feeds...');
  await fetchFeeds();

  console.log('Building lines...');
  const { features: lines, seenNames } = await buildLines();
  console.log('Building stops...');
  const stops = await buildStops();

  // Fail loudly rather than shipping a bundle that is silently missing a mode.
  const required = ['Luas Green', 'Luas Red', 'DART'];
  const missing = required.filter((r) => !seenNames.has(r));
  const commuterCount = lines.filter((f) => f.properties.mode === 'commuter').length;
  if (missing.length) throw new Error(`Missing required routes: ${missing.join(', ')}`);
  if (commuterCount < 1) throw new Error('No commuter-rail routes in output');
  if (stops.length < 50) throw new Error(`Only ${stops.length} stops - filter is too aggressive`);

  await mkdir(outDir, { recursive: true });
  const linesJson = JSON.stringify({ type: 'FeatureCollection', features: lines });
  const stopsJson = JSON.stringify({ type: 'FeatureCollection', features: stops });
  if (linesJson.length > MAX_LINES_BYTES) {
    throw new Error(`Lines bundle ${(linesJson.length / 1e6).toFixed(1)} MB exceeds cap`);
  }
  await writeFile(path.join(outDir, 'dublin-rail-lines.json'), linesJson);
  await writeFile(path.join(outDir, 'dublin-rail-stops.json'), stopsJson);

  const feedInfo = parseCsv(await readFile(path.join(tmp, 'irishrail/feed_info.txt'), 'utf8'))[0] ?? {};
  await writeFile(
    path.join(outDir, 'ATTRIBUTION.md'),
    `# Bundled transport data\n\n` +
      `Generated ${new Date().toISOString().slice(0, 10)} by \`tools/build-transport-data.mjs\`.\n\n` +
      `Source: National Transport Authority / Transport for Ireland GTFS, published as open\n` +
      `data on [data.gov.ie](https://data.gov.ie/) under CC-BY 4.0.\n\n` +
      FEEDS.map((f) => `- \`${f.url}\``).join('\n') +
      `\n\n- Feed version: \`${feedInfo.feed_version ?? 'unknown'}\`\n` +
      `- Feed validity: ${feedInfo.feed_start_date ?? '?'} to ${feedInfo.feed_end_date ?? '?'}\n` +
      `- Publisher: ${feedInfo.feed_publisher_name ?? 'National Transport Authority'}\n\n` +
      `Route colours are **not** present in these feeds (the \`route_color\` column ships\n` +
      `empty); they come from the table in the build script.\n`
  );

  const byMode = lines.reduce((acc, f) => {
    acc[f.properties.mode] = (acc[f.properties.mode] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n  lines: ${lines.length} (${JSON.stringify(byMode)}) - ${(linesJson.length / 1024).toFixed(0)} KB`);
  console.log(`  stops: ${stops.length} - ${(stopsJson.length / 1024).toFixed(0)} KB`);
  console.log(`  routes found: ${[...seenNames].join(', ')}`);

  if (!process.argv.includes('--keep')) await rm(tmp, { recursive: true, force: true });
  console.log(`\nWrote ${path.relative(root, outDir)}/`);
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err.message}`);
  process.exit(1);
});
