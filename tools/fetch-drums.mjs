#!/usr/bin/env node
/**
 * Provisions the bundled drum library into <repo>/drums-flac/ (gitignored) from the public R2 bucket, by
 * OPAQUE ID ONLY — the ids come from the committed ui/src/renderer/drums/samples.json, so no real drum
 * filename ever touches a runner, a log or the app. CMake (cmake/BundleDrums.cmake) lays the folder into the
 * built app, where the shell serves it at /drums/sample/<id>.<ext>; without it the app reads drums off R2.
 * Ported from the Electron repo's scripts/fetch-drums-flac.js — same ids, same bucket, same fallback.
 *
 *   node tools/fetch-drums.mjs             # every id (~1180 files, ~80 MB)
 *   node tools/fetch-drums.mjs --limit 5   # smoke test
 *
 * Idempotent (a file already there with size > 0 is skipped) and writes ONLY inside the repo.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';

const R2 = 'https://pub-17b3d7f0dae24aa8b32405d12d43a870.r2.dev';
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function idsFromSamplesJson() {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'ui', 'src', 'renderer', 'drums', 'samples.json'), 'utf8'));
  const out = new Set();
  const walk = (v) => {
    if (typeof v === 'string') { if (/^[0-9a-f]{16}$/.test(v)) out.add(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(raw);
  return [...out];
}

const lastStatus = new Map(); // url → last HTTP status / error (for the report)
function getOnce(url) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      lastStatus.set(url, res.statusCode);
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => { lastStatus.set(url, 'timeout'); req.destroy(); resolve(null); });
    req.on('error', (e) => { lastStatus.set(url, e.code || 'error'); resolve(null); });
  });
}
/** A 404 is final (try the other extension); anything else (429, 5xx, reset, timeout) is retried with backoff —
 *  a runner pulling 1,200 objects from one IP gets throttled now and then. */
async function get(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const buf = await getOnce(url);
    if (buf && buf.length > 0) return buf;
    if (lastStatus.get(url) === 404) return null;
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 300));
  }
  return null;
}
async function fetchOne(id, outDir) {
  for (const [ext, url] of [['flac', `${R2}/drums-flac/${id}.flac`], ['mp3', `${R2}/drums/${id}.mp3`]]) {
    const dest = path.join(outDir, `${id}.${ext}`);
    try { if (fs.statSync(dest).size > 0) return 'skip'; } catch { /* not there */ }
    const buf = await get(url);
    if (buf && buf.length > 0) { fs.writeFileSync(dest, buf); return ext; }
  }
  return null;
}

async function main() {
  const args = process.argv.slice(2);
  const lim = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : 0;
  const outArg = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'drums-flac';
  const outDir = path.resolve(REPO, outArg);
  if (!outDir.startsWith(REPO + path.sep)) { console.error('[drums] --out must be inside the repo'); process.exit(1); }
  fs.mkdirSync(outDir, { recursive: true });
  let ids = idsFromSamplesJson();
  if (lim > 0) ids = ids.slice(0, lim);
  console.log(`[drums] ${ids.length} ids → ${path.relative(REPO, outDir)}/`);
  let done = 0, skipped = 0;
  const missing = [];
  const queue = [...ids];
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      const r = await fetchOne(id, outDir);
      if (r === 'skip') skipped++; else if (r) done++; else missing.push(id);
      if ((done + skipped + missing.length) % 200 === 0) console.log(`[drums] ${done + skipped + missing.length}/${ids.length}`);
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  console.log(`[drums] fetched ${done}, already had ${skipped}, missing ${missing.length}`);
  if (missing.length) {
    const why = {};
    for (const id of missing) {
      const k = String(lastStatus.get(`${R2}/drums-flac/${id}.flac`)) + '/' + String(lastStatus.get(`${R2}/drums/${id}.mp3`));
      why[k] = (why[k] || 0) + 1;
    }
    console.error('[drums] missing ids (first 5):', missing.slice(0, 5), 'statuses flac/mp3:', why);
    process.exit(1); // a thin kit must never ship
  }
}

// CLI only when RUN — importing this module has no side effects (house rule).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[drums]', (e && e.message) || e); process.exit(1); });
}
