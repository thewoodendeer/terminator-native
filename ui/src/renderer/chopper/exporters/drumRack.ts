/**
 * Ableton Drum Rack (`.adg`) exporter.
 *
 * Output is a ZIP archive shaped exactly the way Ableton itself saves a
 * Drum Rack into User Library — verified by inspecting a rack Ableton
 * produced after "Save Drum Rack":
 *
 *   <setName>/<setName>.adg
 *   <setName>/Samples/<n>.wav
 *   README.txt
 *
 * The user extracts the whole zip into `~/Music/Ableton/User Library/`
 * and the rack appears in Live's browser under User Library as a folder
 * containing the .adg. Sample references use RelativePathType=6 with the
 * path `<setName>/Samples/<n>.wav` relative to User Library — matches
 * Ableton's own save format byte-for-byte (besides the absolute Path,
 * which we leave empty so the export is cross-user portable).
 *
 * Every pad sets ChokeGroup=1 so retriggering a pad cuts the previous one
 * — the MPC mono-pad behaviour the user explicitly asked for.
 *
 * The XML templates (head + branch + tail) are extracted from a real
 * Live 11 drum rack and parameterised per-chop. We replace a small set of
 * placeholder values per branch:
 *   - DrumBranchPreset Id (unique 0..N-1)
 *   - sample Name
 *   - SampleEnd / loop ends / DefaultDuration → frame count
 *   - RelativePath / Path → where the WAV lives
 *   - OriginalFileSize → WAV byte length
 *   - OriginalCrc → 0 (Ableton recomputes on load when NeedsAnalysisData)
 *   - LastModDate → current unix time
 *   - DefaultSampleRate → from the rendered WAV
 *   - ReceivingNote → 36 + padIdx (standard MPC drum-mode mapping)
 *   - ChokeGroup → 1 (mono-pad behaviour)
 */

import { ChopperEngine } from '../ChopperEngine';
import { buildZip } from './zipWriter';
import { encodeWAV } from '../../audio/StemExporter';
import { channelForTrack } from '../../arranger/renderArrangementDAW';
import type { DrumEngine } from '../../drums/DrumEngine';
import HEAD_XML from './templates/drumRack-head.xml?raw';
import BRANCH_XML from './templates/drumRack-branch.xml?raw';
import TAIL_XML from './templates/drumRack-tail.xml?raw';

interface WavInfo {
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  frameCount: number;
  byteLength: number;
}

/** Read the fixed 44-byte WAV header that StemExporter.encodeWAV emits. */
function probeWav(buf: ArrayBuffer): WavInfo {
  const dv = new DataView(buf);
  const numChannels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  // The "data" chunk starts at byte 36; its size is at byte 40.
  const dataSize = dv.getUint32(40, true);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const frameCount = blockAlign > 0 ? Math.floor(dataSize / blockAlign) : 0;
  return { sampleRate, numChannels, bitsPerSample, frameCount, byteLength: buf.byteLength };
}

/** Escape XML attribute / text content. Sample names can have & / < / " etc. */
function xmlEscape(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Safe-for-filesystem filename — drum rack samples live inside a path Ableton
 *  has to read back, so be conservative. */
function safeFileChunk(s: string): string {
  return String(s).replace(/[/\\:*?"<>|\0]/g, '-').replace(/\s+/g, '_').slice(0, 80) || 'chop';
}

/** Replace a fixed-string placeholder in `src` with `next`. Throws if the
 *  literal isn't found, so silent drift between template and code surfaces
 *  loudly at dev time instead of producing broken .adgs in the wild. */
function strictReplace(src: string, literal: string, next: string): string {
  const idx = src.indexOf(literal);
  if (idx < 0) throw new Error(`drumRack template missing literal: ${literal.slice(0, 60)}…`);
  return src.slice(0, idx) + next + src.slice(idx + literal.length);
}

/** Replace every occurrence of `literal` in `src` with `next`. */
function strictReplaceAll(src: string, literal: string, next: string): string {
  if (!src.includes(literal)) throw new Error(`drumRack template missing literal: ${literal.slice(0, 60)}…`);
  return src.split(literal).join(next);
}

interface BranchParams {
  branchId: number;
  padIdx: number;
  sampleName: string;
  relativePath: string;
  wav: WavInfo;
  /** 1 = MPC-style mono choke (chops); 0 = ring independently (drums). */
  chokeGroup: number;
}

function buildBranch(p: BranchParams): string {
  let xml = BRANCH_XML;
  // The opening DrumBranchPreset Id — has to be unique across the rack.
  xml = strictReplace(xml, '<DrumBranchPreset Id="1">', `<DrumBranchPreset Id="${p.branchId}">`);
  // The MultiSamplePart name (inside Simpler). The template's hardcoded
  // name "Ski 5150 Kick 3" appears twice — once as MultiSamplePart Name
  // and once as the filename in RelativePath / Path. We escape it inside
  // XML and rely on the strict ordering of replaceAll calls below.
  xml = strictReplace(xml, '<Name Value="Ski 5150 Kick 3" />', `<Name Value="${xmlEscape(p.sampleName)}" />`);
  // SampleEnd is the trim end, which we want = frame count (full sample).
  xml = strictReplace(xml, '<SampleEnd Value="39689" />', `<SampleEnd Value="${p.wav.frameCount}" />`);
  // SustainLoop + ReleaseLoop both have <End Value="39689" />. Both should
  // also be frame count so the loops can't run past the actual data.
  xml = strictReplaceAll(xml, '<End Value="39689" />', `<End Value="${p.wav.frameCount}" />`);
  // FileRef paths. RelativePathType stays at 6 (User Library) — that's the
  // only resolver that works portably for a standalone .adg outside an
  // Ableton Project. Path is left empty so Ableton doesn't anchor to a
  // specific user's home dir if RelativePath can't resolve.
  xml = strictReplace(xml,
    '<RelativePath Value="Samples/E-A-Ski - 5150 Drums/WAV/Ski 5150 Kick 3.wav" />',
    `<RelativePath Value="${xmlEscape(p.relativePath)}" />`);
  xml = strictReplace(xml,
    '<Path Value="/Users/USER/Music/Ableton/User Library/Samples/E-A-Ski - 5150 Drums/WAV/Ski 5150 Kick 3.wav" />',
    '<Path Value="" />');
  xml = strictReplace(xml, '<OriginalFileSize Value="165052" />', `<OriginalFileSize Value="${p.wav.byteLength}" />`);
  // OriginalCrc=0 lets Ableton recompute on first load. Safer than emitting
  // a stale value from another file.
  xml = strictReplace(xml, '<OriginalCrc Value="53203" />', '<OriginalCrc Value="0" />');
  // Ableton uses 315550800 (≈1980-01-30) as its "freshly imported, no real
  // modification time" sentinel — observed across its own resaved racks.
  // Matching this avoids spurious "needs re-analysis" flags on first open.
  xml = strictReplace(xml, '<LastModDate Value="1752687442" />', '<LastModDate Value="315550800" />');
  xml = strictReplace(xml, '<DefaultDuration Value="39690" />', `<DefaultDuration Value="${p.wav.frameCount + 1}" />`);
  xml = strictReplace(xml, '<DefaultSampleRate Value="44100" />', `<DefaultSampleRate Value="${p.wav.sampleRate}" />`);
  // Routing: pad N → MIDI note 4 + N. With reverse order, this lands the
  // last item (lowest in the rack) at MIDI 4 = E-2 in the user's Ableton
  // labeling; the top item ends up at MIDI 4 + (N-1). Clamp to the valid MIDI
  // range (drums now lead the rack, so a very large rack would otherwise push
  // the highest notes past 127 and Ableton would silently drop the routing).
  xml = strictReplace(xml, '<ReceivingNote Value="91" />', `<ReceivingNote Value="${Math.min(127, 4 + p.padIdx)}" />`);
  // Choke group 1 → chops cut each other off (MPC-style mono); drums stay in
  // group 0 so a kick can't choke a ringing open hat.
  xml = strictReplace(xml, '<ChokeGroup Value="0" />', `<ChokeGroup Value="${p.chokeGroup}" />`);
  return xml;
}

async function gzipBytes(s: string): Promise<Uint8Array> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

export interface DrumRackResult {
  filename: string;        // ZIP filename to suggest
  bytes: Uint8Array;       // ZIP archive contents
  padCount: number;
}

const README_BODY = (setName: string, padCount: number) => `Terminator Drum Rack — ${setName}
===============================================

INSTALL

  1. Extract this zip. You'll get a folder named:
       ${setName}/
     containing ${setName}.adg, a Samples/ folder, and this README.

  2. Move that whole "${setName}" folder into your Ableton User Library:
       Mac:     ~/Music/Ableton/User Library/
       Windows: Documents\\Ableton\\User Library\\

     The final shape should be:
       User Library/${setName}/${setName}.adg
       User Library/${setName}/Samples/*.wav

     IMPORTANT: drop the "${setName}" folder DIRECTLY into User Library.
     Don't leave it inside any other wrapper folder — Ableton's sample
     resolver expects exactly that path depth.

  3. In Ableton: Browser → Places → User Library → ${setName}.
     Drag ${setName}.adg onto a MIDI track.

PAD LAYOUT

  Pad N → MIDI note 46+N (Pad 1 = C3 in this Ableton's labeling)
  All pads share Choke Group 1 → MPC-style mono retrigger
  ${padCount} pad${padCount === 1 ? '' : 's'} loaded.

TROUBLESHOOTING

  If Ableton shows "missing samples", check that User Library/${setName}/
  exists with the .adg and Samples/ as direct children — if there's an
  extra wrapper folder, just move ${setName} up one level.
`;

/** Build a complete Drum Rack ZIP for the engine's current chops. With
 *  `extras.drumEngine` (desktop unified export) the 5 drum one-shots lead the
 *  rack — pad order kick, snare, hat, openhat, perc, then the chops — each
 *  baked through its mixer channel's insert FX + fader when the mixer is wired
 *  (same treatment the chop WAVs already get). Drums use choke group 0 (ring),
 *  chops keep the MPC-style mono choke group 1. */
export async function buildDrumRackZip(
  engine: ChopperEngine,
  setName: string,
  extras?: { drumEngine?: DrumEngine; onProgress?: (pct: number) => void },
): Promise<DrumRackResult> {
  const chops = await engine.exportChops(16, extras?.onProgress);
  if (chops.length === 0) throw new Error('No chops to export — chop the sample first.');

  // Drum one-shots (desktop unified export): current sample per audible track,
  // mixer channel FX baked when available.
  const drums: Array<{ name: string; data: ArrayBuffer }> = [];
  if (extras?.drumEngine) {
    const tracks = await extras.drumEngine.getExportTracks();
    for (const t of tracks) {
      if (!t.audible || !t.buffer) continue;
      const baked = engine.mixerEngine
        ? await engine.mixerEngine.renderWithMixerFX(t.buffer, channelForTrack(t.key))
        : t.buffer;
      drums.push({ name: t.key, data: encodeWAV(baked, 16) });
    }
  }

  const safeSet = safeFileChunk(setName);
  // The zip is named exactly the same as the .adg, with FLAT contents (no
  // inner <setName>/ wrapper). When the user extracts on Mac/Windows, the
  // unzipper creates a folder named after the zip file — e.g.
  // `<safeSet>/` — and drops .adg + Samples/ inside. That's exactly the
  // shape Ableton wants in User Library, so the user drags the extracted
  // folder straight in. Without the inner wrapper there's no double-nesting
  // accident.

  const branches: string[] = [];
  const zipEntries: { path: string; data: Uint8Array }[] = [];

  // Reverse order: item 0 (kick when drums ride along, else the first chop)
  // → highest receiving note, so it sits at the top of the drum rack. Last
  // item → lowest note (E-2 at offset 4).
  const items: Array<{ name: string; data: ArrayBuffer; chokeGroup: number }> = [
    ...drums.map((d) => ({ name: d.name, data: d.data, chokeGroup: 0 })),
    ...chops.map((c) => ({ name: c.name, data: c.data, chokeGroup: 1 })),
  ];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const wav = probeWav(item.data);
    const fileName = `${safeFileChunk(item.name)}.wav`;
    const relativePath = `${safeSet}/Samples/${fileName}`;
    const padIdxForNote = (items.length - 1) - i;
    branches.push(buildBranch({
      branchId: i,
      padIdx: padIdxForNote,
      sampleName: item.name,
      relativePath,
      wav,
      chokeGroup: item.chokeGroup,
    }));
    // Inside the zip the WAVs live at `Samples/<file>.wav` (flat). Extraction
    // wraps everything in a folder named after the zip → `<safeSet>/Samples/`.
    zipEntries.push({ path: `Samples/${fileName}`, data: new Uint8Array(item.data) });
  }

  const xml = HEAD_XML + branches.join('\n') + TAIL_XML;
  const adgBytes = await gzipBytes(xml);
  zipEntries.unshift({
    path: `${safeSet}.adg`,
    data: adgBytes,
  });
  zipEntries.push({
    path: 'README.txt',
    data: new TextEncoder().encode(README_BODY(safeSet, items.length)),
  });

  const zipBytes = buildZip(zipEntries);
  return { filename: `${safeSet}.zip`, bytes: zipBytes, padCount: items.length };
}
