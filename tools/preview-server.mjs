#!/usr/bin/env node
/**
 * Serves dist/ over HTTP so the panel can be exercised in a browser with a real origin.
 *
 * A file:// or data: page has origin "null", which window.postMessage rejects outright -
 * so the panel's own message bridge cannot run there. This exists only to preview and
 * hand-test the UI; it is not part of the extension.
 *
 *   node tools/preview-server.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const port = Number(process.argv[2] ?? 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = url.pathname === '/' ? '/preview.html' : url.pathname;
  const file = path.join(root, path.normalize(rel).replace(/^[/\\]+/, ''));

  if (!file.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`preview: http://localhost:${port}/preview.html`));
