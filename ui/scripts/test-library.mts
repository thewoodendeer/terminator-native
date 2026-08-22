// Headless Sample Library tests for the native app's libraryCore (the Electron `scripts/test-library-main.js`
// cases, re-asserted against the TS port over a Node FsApi and a TEMP root — never the real ~/Music/Terminator).
// Run: npm run test:library   (Node ≥ 22.6 runs the .ts module directly via type stripping)
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createLibraryCore, type FsApi } from '../src/renderer/native/libraryCore.ts';

const passed: string[] = [], failed: string[] = [];
const ok = (name: string, cond: unknown, extra?: unknown) => { (cond ? passed : failed).push(name + (extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : '')); if (!cond) console.error('FAIL', name, extra ?? ''); };

const trashDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlib-trash-'));
const nodeFs: FsApi = {
  readText: async (p) => { try { return await fsp.readFile(p, 'utf8'); } catch { return null; } },
  writeText: async (p, text) => { try { await fsp.mkdir(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; await fsp.writeFile(tmp, text); await fsp.rename(tmp, p); return true; } catch { return false; } },
  writeBinary: async (p, bytes) => { try { await fsp.mkdir(path.dirname(p), { recursive: true }); await fsp.writeFile(p, bytes); return true; } catch { return false; } },
  stat: async (p) => { try { const st = await fsp.stat(p); return { exists: true, isDir: st.isDirectory(), isFile: st.isFile(), size: st.size, modifiedAt: st.mtimeMs, createdAt: st.birthtimeMs || st.mtimeMs }; } catch { return { exists: false, isDir: false, isFile: false, size: 0, modifiedAt: 0, createdAt: 0 }; } },
  list: async (dir) => {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    const out = [];
    for (const e of ents) { if (e.name.startsWith('.')) continue; const full = path.join(dir, e.name); const st = await fsp.stat(full); out.push({ name: e.name.replace(/\.[^.]+$/, ''), fileName: e.name, path: full, isDir: e.isDirectory(), size: st.size, modifiedAt: st.mtimeMs, createdAt: st.birthtimeMs || st.mtimeMs }); }
    return out;
  },
  mkdir: async (p) => { try { await fsp.mkdir(p, { recursive: true }); return true; } catch { return false; } },
  move: async (from, to) => { try { if (fs.existsSync(to)) return false; await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.rename(from, to); return true; } catch { return false; } },
  copy: async (from, to) => { try { if (fs.existsSync(to)) return false; await fsp.mkdir(path.dirname(to), { recursive: true }); await fsp.cp(from, to, { recursive: true, filter: (q) => !path.basename(q).startsWith('.') }); return true; } catch { return false; } },
  trash: async (p) => { try { await fsp.rename(p, path.join(trashDir, `${Date.now()}-${path.basename(p)}`)); return true; } catch { return false; } },
  reveal: async () => {},
  openPath: async () => {},
  serveRoots: async () => {},
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlib-'));
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'tlib-ext-'));
const lib = createLibraryCore(nodeFs, { defaultRoot: root, sep: '/' });
const wav = (p: string) => fs.writeFileSync(p, Buffer.from('RIFF....WAVEfmt '));
wav(path.join(ext, 'kick one.wav')); wav(path.join(ext, 'snare.mp3')); fs.writeFileSync(path.join(ext, 'notes.txt'), 'x');
const loose = path.join(os.tmpdir(), `tlib-loose-${Date.now()}.wav`); wav(loose);

try {
  let t = await lib.getLibrary();
  ok('bootstrap: 4 system folders at root (incl. USER SAMPLES)', t.root.length === 4 && ['recordings', 'youtube', 'imports', 'user'].every(id => t.nodes[id]?.system), JSON.stringify(t.root));
  ok('index written', fs.existsSync(path.join(root, 'library.json')));
  ok('system dirs created', ['Recordings', 'YouTube', 'Imports', 'User Samples'].every(d => fs.existsSync(path.join(root, d))));

  const f = await lib.createFolder(null, 'My Kicks');
  ok('createFolder root', f.type === 'folder' && f.name === 'My Kicks');
  const sub = await lib.createFolder(f.id, 'Sub/Bad:Name');
  ok('createFolder sanitises name', sub.name === 'Sub-Bad-Name', sub.name);

  const imported = await lib.importPaths([loose, ext, path.join(ext, 'notes.txt')], f.id);
  t = await lib.getLibrary();
  ok('import: loose file copied into Imports/', imported.length === 2 && fs.existsSync(path.join(root, 'Imports', path.basename(loose))));
  const linkId = imported.find(id => t.nodes[id].type === 'link')!;
  ok('import: directory becomes a link (not copied)', !!linkId && !fs.existsSync(path.join(root, 'Imports', 'kick one.wav')));
  ok('link scanned live: 2 audio files, txt ignored', (t.nodes[linkId].children ?? []).length === 2, JSON.stringify(t.nodes[linkId].children));
  ok('placed under My Kicks', (t.nodes[f.id].children ?? []).length === 3);

  const fileId = imported.find(id => t.nodes[id].type === 'file')!;
  const dup = await lib.duplicate([fileId]);
  t = await lib.getLibrary();
  ok('duplicate: "name 2" next to original', dup.length === 1 && t.nodes[dup[0]].name === t.nodes[fileId].name + ' 2' && t.nodes[f.id].children!.indexOf(dup[0]) === t.nodes[f.id].children!.indexOf(fileId) + 1, t.nodes[dup[0]]?.name);
  const dup2 = await lib.duplicate([dup[0]]);
  t = await lib.getLibrary();
  ok('duplicate of "name 2" → "name 3"', t.nodes[dup2[0]].name === t.nodes[fileId].name + ' 3', t.nodes[dup2[0]]?.name);

  const rn = await lib.rename(fileId, 'Renamed Kick');
  ok('rename file: on disk + node', rn.name === 'Renamed Kick' && fs.existsSync(rn.path!) && rn.path!.endsWith('Renamed Kick.wav'));
  let threw = false; try { await lib.rename('recordings', 'X'); } catch { threw = true; }
  ok('rename system folder refused', threw);

  await lib.move([sub.id], null, 0);
  t = await lib.getLibrary();
  ok('move to root index 0', t.root[0] === sub.id && !(t.nodes[f.id].children ?? []).includes(sub.id));
  await lib.move(['imports'], null, 0);
  t = await lib.getLibrary();
  ok('reorder system folder at root', t.root[0] === 'imports');
  await lib.move(['imports'], f.id);
  t = await lib.getLibrary();
  ok('system folder never nests', !(t.nodes[f.id].children ?? []).includes('imports') && t.root.includes('imports'));
  await lib.move([sub.id], f.id); // sub back under My Kicks …
  await lib.move([f.id], sub.id);  // … so this would nest My Kicks inside its own child
  t = await lib.getLibrary();
  ok('move folder into own descendant refused', !(t.nodes[sub.id].children ?? []).includes(f.id) && (t.nodes[f.id].children ?? []).includes(sub.id));

  // copy: a linked file copied into a user folder → a real file in Imports/
  const linkKid = (t.nodes[linkId].children ?? [])[0];
  const copied = await lib.copy([linkKid], f.id);
  t = await lib.getLibrary();
  ok('copy linked file → Imports/ copy (yours)', copied.length === 1 && t.nodes[copied[0]].type === 'file' && t.nodes[copied[0]].path!.startsWith(path.join(root, 'Imports')) && fs.existsSync(t.nodes[copied[0]].path!));
  // copy a folder (recursive, new ids)
  const fCopy = await lib.copy([f.id], null);
  t = await lib.getLibrary();
  const expectKids = (t.nodes[f.id].children ?? []).filter(c => t.nodes[c]?.type !== 'link').length; // links are not cloned (Electron rule)
  ok('copy folder recursively (links dropped, files duplicated)', fCopy.length === 1 && t.nodes[fCopy[0]].type === 'folder' && (t.nodes[fCopy[0]].children ?? []).length === expectKids, `${(t.nodes[fCopy[0]]?.children ?? []).length} vs ${expectKids}`);

  // r2 ref
  const r2 = await lib.addR2Ref(f.id, 'abc123', 'Some Song', 'Soul', 120);
  t = await lib.getLibrary();
  ok('addR2Ref', r2.type === 'r2' && t.nodes[r2.id]?.meta?.r2Id === 'abc123');

  // recording
  const rec = await lib.saveRecording('take 1.wav', new Uint8Array([82, 73, 70, 70]));
  t = await lib.getLibrary();
  ok('saveRecording → Recordings/ + node under RECORDINGS', rec.type === 'file' && fs.existsSync(rec.path!) && (t.nodes.recordings.children ?? []).includes(rec.id));
  const rec2 = await lib.saveRecording('take 1.wav', new Uint8Array([82]));
  ok('saveRecording collision → "take 2.wav" (a trailing number counts up, like Electron)', rec2.name === 'take 2', rec2.name);

  // importFiles (bytes, no paths — the WebView drop)
  const imf = await lib.importFiles([{ name: 'dropped.wav', bytes: new Uint8Array([1, 2, 3]) }, { name: 'readme.txt', bytes: new Uint8Array([1]) }], f.id);
  t = await lib.getLibrary();
  ok('importFiles: audio written into Imports/, txt skipped', imf.length === 1 && fs.existsSync(t.nodes[imf[0]].path!) && (t.nodes[f.id].children ?? []).includes(imf[0]));

  // path safety
  ok('resolveReadable: managed file', (await lib.resolveReadable(fileId)) === rn.path);
  ok('resolveReadable: linked file by virtual id', !!(await lib.resolveReadable(linkKid)));
  ok('resolveReadable: refuses outside paths', (await lib.resolveReadable('/etc/passwd')) === null && (await lib.resolveReadable('link:/etc/passwd')) === null);
  ok('resolveReadableSync: cached', lib.resolveReadableSync(fileId) === rn.path);

  // USER SAMPLES (mirrored)
  const uf = await lib.createFolder('user', 'Kits');
  ok('USER SAMPLES createFolder = real dir', uf.id === 'user:Kits' && fs.existsSync(path.join(root, 'User Samples', 'Kits')));
  const ucopy = await lib.copy([rn.id], 'user:Kits');
  t = await lib.getLibrary();
  ok('copy into USER SAMPLES = real file, scanned', ucopy.length === 1 && t.nodes[ucopy[0]]?.mirrored && fs.existsSync(path.join(root, 'User Samples', 'Kits', 'Renamed Kick.wav')));
  const urn = await lib.rename(ucopy[0], 'Renamed Again');
  ok('USER SAMPLES rename on disk', urn.id === 'user:Kits/Renamed Again.wav' && fs.existsSync(path.join(root, 'User Samples', 'Kits', 'Renamed Again.wav')));
  await lib.move([urn.id], 'user');
  t = await lib.getLibrary();
  ok('USER SAMPLES move between real folders', !!t.nodes['user:Renamed Again.wav'] && !fs.existsSync(path.join(root, 'User Samples', 'Kits', 'Renamed Again.wav')));
  await lib.move(['user:Renamed Again.wav'], f.id);
  t = await lib.getLibrary();
  ok('move OUT of USER SAMPLES → Imports/ + node', fs.existsSync(path.join(root, 'Imports', 'Renamed Again.wav')) && (t.nodes[f.id].children ?? []).some(c => t.nodes[c]?.path?.endsWith('Renamed Again.wav')));

  // remove → trash
  const before = t.nodes[dup[0]].path!;
  await lib.remove([dup[0]]);
  t = await lib.getLibrary();
  ok('remove: managed file to Trash + node gone', !t.nodes[dup[0]] && !fs.existsSync(before));
  await lib.remove(['recordings']);
  t = await lib.getLibrary();
  ok('remove: system folder refused', !!t.nodes.recordings);
  await lib.remove([linkId]);
  t = await lib.getLibrary();
  ok('remove link: unlinked, nothing on disk touched', !t.nodes[linkId] && fs.existsSync(path.join(ext, 'kick one.wav')));

  // listLink / searchLinks on a fresh link
  const [l2] = await lib.importPaths([ext], null);
  const kids = await lib.listLink(l2);
  ok('listLink: direct children', kids.length === 2 && kids.every(k => k.readonly));
  const hits = await lib.searchLinks('kick');
  ok('searchLinks finds by name', (hits[l2] ?? []).length === 1, JSON.stringify(hits));

  // moveLibrary
  const dest = path.join(os.tmpdir(), `tlib-moved-${Date.now()}`);
  const mv = await lib.moveLibrary(dest);
  ok('moveLibrary copies managed files + writes the index there', mv.moved >= 3 && fs.existsSync(path.join(dest, 'library.json')) && fs.existsSync(path.join(dest, 'Imports', 'Renamed Kick.wav')) && lib.libraryRoot() === dest);
  t = await lib.getLibrary();
  ok('after move: nodes point into the new root', Object.values(t.nodes).filter(n => n.type === 'file' && !n.mirrored && !n.readonly).every(n => n.path!.startsWith(dest)));
  fs.rmSync(dest, { recursive: true, force: true });
} catch (e) {
  failed.push(`exception: ${(e as any)?.stack ?? e}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(ext, { recursive: true, force: true });
  fs.rmSync(trashDir, { recursive: true, force: true });
  try { fs.rmSync(loose); } catch { /* */ }
}
console.log(`library tests: ${passed.length} passed, ${failed.length} failed`);
for (const f of failed) console.log('  FAIL', f);
process.exit(failed.length ? 1 : 0);
