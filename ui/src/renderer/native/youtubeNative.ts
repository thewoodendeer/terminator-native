/**
 * youtubeNative — yt-dlp YouTube audio extraction for Terminator 3.0: the Electron main-process
 * `src/main/youtubeDownloader.ts` (the Julienne engine) ported into the page over `processBridge` (the shell runs
 * the BUNDLED yt-dlp onedir with the bundled quickjs-ng `qjs` as the JS-challenge runtime — `--no-update
 * --js-runtimes quickjs:<dir>` are prepended by the shell) and `terminatorFs` (temp dirs, the meta file, moving the
 * audio into the library). Same flags, same error mapping, same 3-worker playlist batch, same cancel semantics.
 * Pure apart from the two bridges — `createYouTubeNative` takes them injected.
 */
import type { FsApi } from './libraryCore';
import type { makePath } from './libraryCore';
import type { ProcessHandle } from './processBridge';

export type YtErrorCode = 'bad-link' | 'age-restricted' | 'unavailable' | 'network' | 'cancelled' | 'no-binary' | 'mix' | 'failed';
export class YouTubeError extends Error {
  code: YtErrorCode;
  constructor(code: YtErrorCode, message: string) { super(message); this.code = code; }
}
export type YouTubeProgress = { phase: 'starting' | 'downloading'; percent: number };
export interface DownloadedVideo { title: string; durationSec: number; videoId: string; audioPath: string }
export interface PlaylistEntry { id: string; title: string; durationSec?: number }
export interface PlaylistInfo { playlistTitle: string; entries: PlaylistEntry[]; skipped: number; capped: boolean }
export interface BatchProgress { done: number; total: number; currentTitle: string }
export interface BatchSummary { imported: number; failed: number; cancelled: boolean }

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_CAP = 200;

/** A YouTube video id from an id or a URL (watch?v= / youtu.be/…); throws on anything else — never a path payload. */
export function extractVideoId(idOrUrl: string): string {
  if (typeof idOrUrl !== 'string' || !idOrUrl) throw new Error('invalid videoId');
  let candidate = idOrUrl.trim();
  if (/^https?:/i.test(candidate)) {
    try {
      const u = new URL(candidate);
      if (u.hostname === 'youtu.be') candidate = u.pathname.slice(1).split('?')[0];
      else candidate = u.searchParams.get('v') ?? '';
    } catch { candidate = ''; }
  }
  if (!VIDEO_ID_RE.test(candidate)) throw new Error('invalid videoId');
  return candidate;
}
/** Does this URL carry a playlist id? (RD/UL mixes are endless → refused later.) */
export function playlistIdOf(input: string): string | null {
  for (const cand of [input.trim(), `https://${input.trim()}`]) {
    try { const l = new URL(cand).searchParams.get('list'); return l && /^[A-Za-z0-9_-]{2,64}$/.test(l) ? l : null; } catch { /* retry */ }
  }
  return null;
}
/** Filesystem-safe filename from a title. */
export function safeTitleName(title: string, fallback: string): string {
  const clean = title.split('').filter(ch => ch.charCodeAt(0) >= 32).join('')
    .replace(/[/\\:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[. ]+$/, '');
  return clean || fallback;
}
function mapOutput(out: string): YouTubeError {
  if (/sign in to confirm your age|age.restricted/i.test(out)) return new YouTubeError('age-restricted', 'That video is age-restricted — YouTube blocks the download.');
  if (/video unavailable|private video|has been removed|account.*terminated/i.test(out)) return new YouTubeError('unavailable', 'Video unavailable — removed, private, or region-locked.');
  if (/not a valid URL|unsupported URL/i.test(out)) return new YouTubeError('bad-link', "That doesn't look like a YouTube link.");
  if (/getaddrinfo|ECONN|ETIMEDOUT|network|unable to download webpage/i.test(out)) return new YouTubeError('network', 'Network error — check your connection and retry.');
  const errs = out.split('\n').filter(l => /^ERROR/i.test(l.trim()));
  const tail = (errs.length ? errs : out.trim().split('\n')).slice(-2).join(' | ');
  return new YouTubeError('failed', tail || 'yt-dlp failed.');
}

export interface YouTubeDeps {
  fs: FsApi;
  path: ReturnType<typeof makePath>;
  tempDir: string;
  spawn: (tool: 'ytdlp', args: string[], onOutput?: (chunk: string) => void) => Promise<ProcessHandle>;
  tools: () => Promise<{ ytdlp: string }>;
}

export function createYouTubeNative(deps: YouTubeDeps) {
  const { fs, path } = deps;
  interface Job { cancelled: boolean; children: Set<ProcessHandle> }
  const jobs = new Map<string, Job>();
  const acquireJob = (id: string): Job => { let j = jobs.get(id); if (!j) { j = { cancelled: false, children: new Set() }; jobs.set(id, j); } return j; };
  const releaseJob = (id: string) => { jobs.delete(id); };
  const cancelJob = (id: string) => { const j = jobs.get(id); if (!j) return; j.cancelled = true; for (const c of j.children) void c.kill(); };

  let haveBinary: boolean | null = null;
  async function requireYtDlp(): Promise<void> {
    if (haveBinary === null) haveBinary = !!(await deps.tools()).ytdlp;
    if (!haveBinary) throw new YouTubeError('no-binary', 'yt-dlp is missing from this build — reinstall Terminator.');
  }

  /** Run yt-dlp to completion; every output chunk goes to onChunk; rejects with the mapped error on a non-zero exit. */
  async function runYtDlp(job: Job, args: string[], onChunk: (chunk: string) => void): Promise<string> {
    if (job.cancelled) throw new YouTubeError('cancelled', 'Cancelled.');
    let out = '';
    let h: ProcessHandle;
    try { h = await deps.spawn('ytdlp', args, (c) => { out += c; if (out.length > 4 * 1024 * 1024) out = out.slice(-2 * 1024 * 1024); onChunk(c); }); }
    catch (e: any) { throw new YouTubeError('failed', e?.message ?? String(e)); }
    job.children.add(h);
    const code = await h.exit;
    job.children.delete(h);
    if (job.cancelled) throw new YouTubeError('cancelled', 'Cancelled.');
    if (code !== 0) throw mapOutput(out);
    return out;
  }

  const rand = () => Math.random().toString(36).slice(2, 10);

  /** One video → `destDir` (named by title; a different video with the same title gets a ` [videoId]` suffix). */
  async function downloadOneVideo(job: Job, url: string, pinToVideo: boolean, destDir: string, onProgress: (p: YouTubeProgress) => void, nameById = false): Promise<DownloadedVideo> {
    const tmpDir = path.join(deps.tempDir, `terminator-yt-${rand()}`);
    if (!(await fs.mkdir(tmpDir))) throw new YouTubeError('failed', 'could not create a temp folder');
    const outTemplate = path.join(tmpDir, '%(id)s.%(ext)s');
    const metaFile = path.join(tmpDir, 'meta.txt');
    const args = [
      url,
      '-f', 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best',
      '--concurrent-fragments', '8',
      '--retries', '5', '--fragment-retries', '10', '--socket-timeout', '15',
      ...(pinToVideo ? ['--no-playlist'] : ['--playlist-items', '1']),
      '--newline',
      '-o', outTemplate,
      '--print-to-file', '%(id)s\t%(title)s\t%(duration)s', metaFile,
    ];
    onProgress({ phase: 'starting', percent: 0 });
    let lineBuf = '';
    const onChunk = (c: string) => {
      lineBuf += c;
      const lines = lineBuf.split('\n'); lineBuf = lines.pop() ?? '';
      for (const line of lines) { const m = /\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line); if (m) onProgress({ phase: 'downloading', percent: Math.min(100, Number(m[1])) }); }
    };
    try {
      try { await runYtDlp(job, args, onChunk); }
      catch (e) {
        // ONE silent re-run on a media 403 (a fresh extraction = fresh URLs)
        const is403 = e instanceof YouTubeError && e.code === 'failed' && /HTTP Error 403/i.test(e.message);
        if (!is403 || job.cancelled) throw e;
        onProgress({ phase: 'starting', percent: 0 });
        await runYtDlp(job, args, onChunk);
      }
      const metaRaw = (await fs.readText(metaFile)) ?? '';
      const [id, title, durationStr] = metaRaw.trim().split('\t');
      const files = await fs.list(tmpDir);
      const audio = files.find(f => !f.isDir && /\.(m4a|webm|opus|mp3|aac|ogg|wav|mp4)$/i.test(f.fileName) && !f.fileName.startsWith('meta'));
      if (!audio) throw new YouTubeError('failed', 'yt-dlp finished but produced no audio file.');
      const videoId = id || 'unknown';
      const finalTitle = title || videoId;
      const ext = path.extname(audio.fileName);
      await fs.mkdir(destDir);
      let audioPath: string;
      if (nameById) audioPath = path.join(destDir, `${videoId}${ext}`);
      else {
        const base = safeTitleName(finalTitle, videoId);
        audioPath = path.join(destDir, `${base}${ext}`);
        if ((await fs.stat(audioPath)).exists) audioPath = path.join(destDir, `${base} [${videoId}]${ext}`);
      }
      if ((await fs.stat(audioPath)).exists) await fs.trash(audioPath);
      if (!(await fs.move(audio.path, audioPath))) throw new YouTubeError('failed', 'could not move the download into the library');
      return { title: finalTitle, durationSec: Number(durationStr) || 0, videoId, audioPath };
    } finally {
      void fs.trash(tmpDir).catch(() => false);
    }
  }

  /** Fast, download-free enumeration: `yt-dlp --flat-playlist -J`. */
  async function enumeratePlaylist(input: string): Promise<PlaylistInfo> {
    const listId = playlistIdOf(input);
    if (!listId) throw new YouTubeError('bad-link', "That link doesn't carry a playlist.");
    if (/^(RD|UL)/.test(listId)) throw new YouTubeError('mix', "That's an endless YouTube mix — only real playlists can be imported.");
    await requireYtDlp();
    const job = acquireJob(`enum:${listId}`);
    let out: string;
    try { out = await runYtDlp(job, [`https://www.youtube.com/playlist?list=${listId}`, '--flat-playlist', '-J', '--playlist-end', String(PLAYLIST_CAP), '--no-warnings'], () => {}); }
    finally { releaseJob(`enum:${listId}`); }
    // stdout + stderr are merged: the JSON is the (single) line that starts with '{' and parses
    let json: { title?: unknown; entries?: unknown; playlist_count?: unknown } | null = null;
    for (const line of out.split('\n')) { const t = line.trim(); if (!t.startsWith('{')) continue; try { json = JSON.parse(t); break; } catch { /* next */ } }
    if (!json) throw new YouTubeError('failed', 'Could not read that playlist.');
    const raw = Array.isArray(json.entries) ? (json.entries as Array<Record<string, unknown>>) : null;
    if (!raw) throw new YouTubeError('bad-link', "That link doesn't carry a playlist.");
    const entries: PlaylistEntry[] = [];
    let skipped = 0;
    for (const e of raw) {
      const id = typeof e.id === 'string' ? e.id : '';
      const title = typeof e.title === 'string' ? e.title : '';
      if (!VIDEO_ID_RE.test(id) || /^\[(private|deleted|unavailable)/i.test(title)) { skipped += 1; continue; }
      entries.push({ id, title: title || id, ...(typeof e.duration === 'number' && isFinite(e.duration) ? { durationSec: e.duration } : {}) });
    }
    const totalCount = typeof json.playlist_count === 'number' ? json.playlist_count : raw.length;
    return { playlistTitle: typeof json.title === 'string' ? json.title : 'playlist', entries, skipped, capped: totalCount > PLAYLIST_CAP };
  }

  /** Batch download into `destDir`: 3 pull-workers off one shared cursor; per-track failures counted, never fatal. */
  async function importPlaylistAudio(jobId: string, entries: PlaylistEntry[], destDir: string, onProgress: (p: BatchProgress) => void, onTrack: (dl: DownloadedVideo) => Promise<void> | void): Promise<BatchSummary> {
    await requireYtDlp();
    const job = acquireJob(jobId);
    const total = entries.length;
    let next = 0, done = 0, imported = 0, failed = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (job.cancelled) return;
        const index = next++;
        if (index >= total) return;
        const entry = entries[index];
        onProgress({ done, total, currentTitle: entry.title });
        try {
          const dl = await downloadOneVideo(job, `https://www.youtube.com/watch?v=${entry.id}`, true, destDir, () => {});
          await onTrack(dl);
          imported += 1;
        } catch (e) {
          if (e instanceof YouTubeError && e.code === 'cancelled') return;
          failed += 1;
        }
        done += 1;
        onProgress({ done, total, currentTitle: entry.title });
      }
    };
    try { await Promise.all(Array.from({ length: Math.min(3, total) }, () => worker())); }
    finally { releaseJob(jobId); }
    return { imported, failed, cancelled: job.cancelled };
  }

  /** Download ONE video into `destDir` (library import), named by title. */
  async function downloadVideoToDir(input: string, destDir: string, onProgress: (p: YouTubeProgress) => void = () => {}, jobId = 'single'): Promise<DownloadedVideo> {
    await requireYtDlp();
    let url = input.trim();
    let pin = true;
    try { const id = extractVideoId(input); url = `https://www.youtube.com/watch?v=${id}`; } catch { pin = false; }
    const job = acquireJob(jobId);
    try { return await downloadOneVideo(job, url, pin, destDir, onProgress); }
    finally { releaseJob(jobId); }
  }

  /** `yt-dlp --version` through the bridge (the probe's smoke test — no network). */
  async function version(): Promise<string> {
    await requireYtDlp();
    const job = acquireJob('version');
    try { return (await runYtDlp(job, ['--version'], () => {})).trim().split('\n').pop() ?? ''; }
    finally { releaseJob('version'); }
  }

  return { enumeratePlaylist, importPlaylistAudio, downloadVideoToDir, cancelJob, version, requireYtDlp };
}
export type YouTubeNative = ReturnType<typeof createYouTubeNative>;
