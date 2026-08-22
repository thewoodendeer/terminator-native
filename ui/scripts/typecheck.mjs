#!/usr/bin/env node
// Baseline-aware typecheck: `tsc --noEmit` must report NO error that is not already in tsc-baseline.json.
// The baseline is the Electron renderer's five known errors (file + TS code + message, line numbers ignored so
// edits elsewhere in a file don't shift them). New error → exit 1 with the offending lines. A baseline error
// that disappeared is reported (update the baseline with --update). Usage: node scripts/typecheck.mjs [--update]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const baselineFile = path.join(root, 'tsc-baseline.json');
const update = process.argv.includes('--update');

const tsc = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '--noEmit', '--pretty', 'false'], {
  cwd: root, encoding: 'utf8', shell: process.platform === 'win32',
});
const out = (tsc.stdout || '') + (tsc.stderr || '');
// "src/x.ts(12,30): error TS18048: 'ipc' is possibly 'undefined'."
const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const errors = [];
for (const line of out.split(/\r?\n/)) {
  const m = re.exec(line.trim());
  if (m) errors.push({ file: m[1].replace(/\\/g, '/'), line: Number(m[2]), code: m[4], message: m[5].trim() });
}
const key = (e) => `${e.file} :: ${e.code} :: ${e.message}`;

if (update) {
  const baseline = errors.map(e => ({ file: e.file, code: e.code, message: e.message }));
  fs.writeFileSync(baselineFile, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`tsc baseline written: ${baseline.length} error(s) → ${path.relative(root, baselineFile)}`);
  process.exit(0);
}

const baseline = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : [];
const allowed = new Map(); // key → count
for (const b of baseline) allowed.set(key(b), (allowed.get(key(b)) ?? 0) + 1);
const fresh = [];
const seen = new Map();
for (const e of errors) {
  const k = key(e);
  const n = (seen.get(k) ?? 0) + 1; seen.set(k, n);
  if (n > (allowed.get(k) ?? 0)) fresh.push(e);
}
const gone = [...allowed].filter(([k, n]) => (seen.get(k) ?? 0) < n).map(([k]) => k);
console.log(`tsc: ${errors.length} error(s) total, baseline ${baseline.length}, new ${fresh.length}, gone ${gone.length}`);
for (const g of gone) console.log(`  baseline error no longer reported (update with --update): ${g}`);
if (fresh.length) {
  console.error('NEW TypeScript errors (not in the baseline):');
  for (const e of fresh) console.error(`  ${e.file}(${e.line}): ${e.code}: ${e.message}`);
  process.exit(1);
}
if (tsc.status !== 0 && errors.length === 0) { console.error(out); process.exit(tsc.status ?? 1); }
console.log('typecheck OK (zero new errors on top of the baseline)');
