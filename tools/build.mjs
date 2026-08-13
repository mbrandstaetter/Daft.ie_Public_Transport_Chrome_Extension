#!/usr/bin/env node
// Bundles the extension into dist/. Plain esbuild: four independent entry points,
// no code splitting (MV3 content scripts cannot load chunks), plus static copies.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ext = path.join(root, 'extension');
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const entries = {
  'main-world': 'src/main-world/index.ts',
  isolated: 'src/isolated/index.ts',
  background: 'src/background/index.ts',
  options: 'src/options/options.ts',
};

async function copyStatic() {
  await cp(path.join(ext, 'manifest.json'), path.join(dist, 'manifest.json'));
  await cp(path.join(ext, 'rules'), path.join(dist, 'rules'), { recursive: true });
  await cp(path.join(ext, 'src/options/options.html'), path.join(dist, 'options.html'));

  const dataDir = path.join(ext, 'public/data');
  if (existsSync(dataDir)) {
    await cp(dataDir, path.join(dist, 'data'), { recursive: true });
  } else {
    console.warn('  ! extension/public/data missing - run `npm run data` to generate it');
  }

  const icons = path.join(ext, 'public/icons');
  if (existsSync(icons)) await cp(icons, path.join(dist, 'icons'), { recursive: true });

  // Panel harness: renders the real isolated.js against stubbed extension APIs, so the
  // UI can be looked at without loading the extension. Served by tools/preview-server.mjs
  // rather than opened as a file, because a file:// page has origin "null" and
  // window.postMessage - which the panel's own bridge uses - rejects that outright.
  await cp(path.join(root, 'tools/preview.html'), path.join(dist, 'preview.html'));

  // Keep the DNR User-Agent string in step with the manifest version.
  const manifest = JSON.parse(await readFile(path.join(ext, 'manifest.json'), 'utf8'));
  const rulesPath = path.join(dist, 'rules/transitous.json');
  const rules = JSON.parse(await readFile(rulesPath, 'utf8'));
  for (const rule of rules) {
    for (const h of rule.action?.requestHeaders ?? []) {
      if (h.header === 'User-Agent') {
        h.value = h.value.replace(/DublinCommuteOverlay\/[\d.]+/, `DublinCommuteOverlay/${manifest.version}`);
      }
    }
  }
  await writeFile(rulesPath, JSON.stringify(rules, null, 2));
}

const options = {
  entryPoints: Object.fromEntries(
    Object.entries(entries).map(([out, src]) => [out, path.join(ext, src)])
  ),
  outdir: dist,
  bundle: true,
  format: 'esm',
  target: 'chrome111',
  splitting: false,
  sourcemap: watch ? 'inline' : false,
  minify: !watch,
  logLevel: 'info',
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  await copyStatic();
  console.log('watching...');
} else {
  await esbuild.build(options);
  await copyStatic();
  console.log(`\nBuilt to ${path.relative(root, dist)}/`);
}
