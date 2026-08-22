/**
 * FLAC ENCODER — pure TypeScript, no wasm, no ffmpeg, no native module.
 *
 * Why it exists: a song's four stems stored as 16-bit WAV are ~127 MB for
 * three minutes (4 × 32 MB); FLAC is LOSSLESS — the decoded samples are
 * bit-identical to what the WAV held — and separated stems (lots of near-
 * silence) shrink by half or better. A pure-TS encoder runs in a renderer
 * Web Worker on desktop AND web, and packages with zero asar/binary traps
 * (the stems child learned that lesson the hard way — STEMS-IN-ELECTRON.md).
 * Reading the file back is free: Chrome's decodeAudioData decodes FLAC.
 *
 * What it writes (FLAC format 1.x, every decoder reads it):
 *   fLaC · STREAMINFO (only metadata block, MD5 of the PCM set) · fixed-blocksize
 *   frames of 4096 samples · per block the cheapest of independent /
 *   left-side / right-side / mid-side · per channel the cheapest of CONSTANT,
 *   VERBATIM, FIXED order 0-4, LPC order 1-8 (Levinson-Durbin, 15-bit
 *   quantized coefficients, libFLAC's recurrence) · Rice residuals, partition
 *   order chosen per subframe · CRC-8 header + CRC-16 frame, as the spec asks.
 * Gates: npm run test:flac (reference `flac -d` round-trip, sample-exact) and
 * npm run test:flac-decode (Chrome's own decodeAudioData in an Electron e2e).
 */

export interface FlacEncodeOptions {
  /** Samples per frame (16..65535). 4096 = libFLAC's default. */
  blockSize?: number;
  /** 0 = fixed predictors only (fastest); 8 = libFLAC's -5 depth. */
  maxLpcOrder?: number;
}

const MAX_RICE_PARAM = 14; // 4-bit parameter; 15 is the escape code (unused)

// ── CRCs ────────────────────────────────────────────────────────────────────
const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
  CRC8[i] = c;
  let d = i << 8;
  for (let k = 0; k < 8; k++) d = (d & 0x8000) ? ((d << 1) ^ 0x8005) & 0xffff : (d << 1) & 0xffff;
  CRC16[i] = d;
}

// ── MD5 of the unencoded PCM (STREAMINFO) — lets `flac -t` and strict
// decoders verify the audio, not just the framing. Interleaved little-endian
// samples at bps/8 bytes each, exactly as the spec hashes them. ─────────────
const MD5_S = new Uint8Array([7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]);
const MD5_K = new Int32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;
class MD5 {
  private a = 0x67452301 | 0; private b = 0xefcdab89 | 0; private c = 0x98badcfe | 0; private d = 0x10325476 | 0;
  private block = new Uint8Array(64); private fill = 0; private total = 0;
  private words = new Int32Array(16);
  private compress(blk: Uint8Array, off: number): void {
    const w = this.words;
    for (let i = 0; i < 16; i++) { const o = off + i * 4; w[i] = blk[o] | (blk[o + 1] << 8) | (blk[o + 2] << 16) | (blk[o + 3] << 24); }
    let a = this.a, b = this.b, c = this.c, d = this.d;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const t = d; d = c; c = b;
      const x = (a + f + MD5_K[i] + w[g]) | 0;
      const s = MD5_S[i];
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
      a = t;
    }
    this.a = (this.a + a) | 0; this.b = (this.b + b) | 0; this.c = (this.c + c) | 0; this.d = (this.d + d) | 0;
  }
  update(bytes: Uint8Array, len: number): void {
    this.total += len;
    let i = 0;
    if (this.fill > 0) {
      const take = Math.min(64 - this.fill, len);
      this.block.set(bytes.subarray(0, take), this.fill); this.fill += take; i = take;
      if (this.fill < 64) return;
      this.compress(this.block, 0); this.fill = 0;
    }
    for (; i + 64 <= len; i += 64) this.compress(bytes, i);
    if (i < len) { this.block.set(bytes.subarray(i, len), 0); this.fill = len - i; }
  }
  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array(((this.fill < 56 ? 56 : 120) - this.fill) + 8);
    pad[0] = 0x80;
    const lo = bits % 4294967296, hi = Math.floor(bits / 4294967296);
    const n = pad.length;
    pad[n - 8] = lo & 0xff; pad[n - 7] = (lo >>> 8) & 0xff; pad[n - 6] = (lo >>> 16) & 0xff; pad[n - 5] = (lo >>> 24) & 0xff;
    pad[n - 4] = hi & 0xff; pad[n - 3] = (hi >>> 8) & 0xff; pad[n - 2] = (hi >>> 16) & 0xff; pad[n - 1] = (hi >>> 24) & 0xff;
    this.update(pad, pad.length);
    const out = new Uint8Array(16);
    for (const [i, v] of [this.a, this.b, this.c, this.d].entries()) { out[i * 4] = v & 0xff; out[i * 4 + 1] = (v >>> 8) & 0xff; out[i * 4 + 2] = (v >>> 16) & 0xff; out[i * 4 + 3] = (v >>> 24) & 0xff; }
    return out;
  }
}
function pcmMd5(channels: ArrayLike<number>[], total: number, bps: number): Uint8Array {
  const nch = channels.length, bytesPer = bps / 8;
  const md5 = new MD5();
  const CH = 4096;
  const buf = new Uint8Array(CH * nch * bytesPer);
  for (let pos = 0; pos < total; pos += CH) {
    const n = Math.min(CH, total - pos);
    let o = 0;
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      const v = channels[c][pos + i];
      buf[o++] = v & 0xff; buf[o++] = (v >> 8) & 0xff;
      if (bytesPer === 3) buf[o++] = (v >> 16) & 0xff;
    }
    md5.update(buf, o);
  }
  return md5.digest();
}

// ── bit writer ───────────────────────────────────────────────────────────────
class BitWriter {
  buf = new Uint8Array(1 << 20);
  pos = 0;       // bytes written
  private acc = 0;  // pending bits (< 2^31)
  private nacc = 0;
  private grow(need: number): void {
    if (this.pos + need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + need) cap *= 2;
    const nb = new Uint8Array(cap); nb.set(this.buf.subarray(0, this.pos)); this.buf = nb;
  }
  /** ≤ 16 bits at a time, value already masked. */
  private push(part: number, take: number): void {
    this.acc = (this.acc << take) | part;
    this.nacc += take;
    if (this.nacc >= 8) {
      this.grow(4);
      while (this.nacc >= 8) { this.nacc -= 8; this.buf[this.pos++] = (this.acc >>> this.nacc) & 0xff; }
      this.acc &= (1 << this.nacc) - 1;
    }
  }
  /** Write the low `n` bits of a NON-NEGATIVE value (n ≤ 36). */
  writeBits(value: number, n: number): void {
    while (n > 0) {
      const take = n > 16 ? 16 : n;
      const shift = n - take;
      const part = shift === 0 ? (value % 65536 + 65536) % 65536 & ((1 << take) - 1) : Math.floor(value / 2 ** shift) & ((1 << take) - 1);
      this.push(part, take);
      n -= take;
    }
  }
  /** Two's complement of a signed value in `n` bits (n ≤ 32). */
  writeSigned(value: number, n: number): void {
    this.writeBits(value < 0 ? value + 2 ** n : value, n);
  }
  /** Rice: q zeros then a 1, then k low bits. */
  writeRice(u: number, k: number): void {
    let q = Math.floor(u / 2 ** k);
    while (q >= 16) { this.push(0, 16); q -= 16; }
    this.push(1, q + 1);
    if (k > 0) this.writeBits(u % (2 ** k), k);
  }
  alignByte(): void { if (this.nacc > 0) this.push(0, 8 - this.nacc); }
  crc8(from: number): number { let c = 0; const b = this.buf; for (let i = from; i < this.pos; i++) c = CRC8[c ^ b[i]]; return c; }
  crc16(from: number): number { let c = 0; const b = this.buf; for (let i = from; i < this.pos; i++) c = ((c << 8) ^ CRC16[((c >> 8) ^ b[i]) & 0xff]) & 0xffff; return c; }
  bytes(): Uint8Array { this.alignByte(); return this.buf.slice(0, this.pos); }
}

// ── subframe planning ───────────────────────────────────────────────────────
type Plan =
  | { kind: 'constant'; value: number; bits: number }
  | { kind: 'verbatim'; bits: number }
  | { kind: 'fixed'; order: number; res: Int32Array; partOrder: number; params: Uint8Array; bits: number }
  | { kind: 'lpc'; order: number; precision: number; shift: number; coefs: Int32Array; res: Int32Array; partOrder: number; params: Uint8Array; bits: number };

const log2 = Math.log2;

/** Best Rice partitioning for a residual: estimated bit cost + per-partition k. */
function planRice(res: Int32Array, n: number, predOrder: number, maxPartOrder: number, scratch: Float64Array): { partOrder: number; params: Uint8Array; bits: number } {
  // zigzag sums via a prefix sum of |u| (u = 2r or -2r-1)
  const m = n - predOrder;
  const pre = scratch; // length ≥ m + 1
  pre[0] = 0;
  for (let i = 0; i < m; i++) { const r = res[i]; pre[i + 1] = pre[i] + (r >= 0 ? 2 * r : -2 * r - 1); }
  let bestBits = Infinity, bestPo = 0, bestParams: Uint8Array = new Uint8Array(1);
  for (let po = 0; po <= maxPartOrder; po++) {
    const nparts = 1 << po;
    const per = n >> po;
    if (per <= predOrder && po > 0) break;           // first partition would have no samples
    if ((n & (nparts - 1)) !== 0) break;              // block not divisible
    const params = new Uint8Array(nparts);
    let bits = 6 + 8 * 0;                             // 2 (method) + 4 (order)
    let start = 0;
    for (let p = 0; p < nparts; p++) {
      const count = p === 0 ? per - predOrder : per;
      const sum = pre[start + count] - pre[start];
      let k: number;
      if (count === 0 || sum === 0) k = 0;
      else {
        const mean = sum / count;
        k = mean < 1 ? 0 : Math.floor(log2(mean));
        if (k > MAX_RICE_PARAM) k = MAX_RICE_PARAM;
      }
      // refine ±1 on the estimated cost count*(k+1) + sum/2^k
      let bestK = k, bestC = count * (k + 1) + sum / 2 ** k;
      for (const kk of [k - 1, k + 1]) {
        if (kk < 0 || kk > MAX_RICE_PARAM) continue;
        const c = count * (kk + 1) + sum / 2 ** kk;
        if (c < bestC) { bestC = c; bestK = kk; }
      }
      params[p] = bestK;
      bits += 4 + bestC;
      start += count;
    }
    if (bits < bestBits) { bestBits = bits; bestPo = po; bestParams = params; }
  }
  return { partOrder: bestPo, params: bestParams, bits: bestBits };
}

function sumAbs(res: Int32Array, m: number): number { let s = 0; for (let i = 0; i < m; i++) { const r = res[i]; s += r < 0 ? -r : r; } return s; }
/** Cheap estimate of Rice bits from the residual's mean magnitude (ranking only). */
function estimateBits(sum: number, m: number): number {
  if (m <= 0) return 0;
  const mean = sum / m;
  if (mean < 0.5) return m;
  const k = Math.min(MAX_RICE_PARAM, Math.max(0, Math.floor(log2(mean))));
  return m * (k + 1) + (2 * sum) / 2 ** k;
}

function planChannel(x: Int32Array, n: number, bps: number, maxLpc: number, pool: Int32Array[], scratch: Float64Array, lpcTmp: LpcScratch): Plan {
  // CONSTANT
  let constant = true;
  for (let i = 1; i < n; i++) if (x[i] !== x[0]) { constant = false; break; }
  if (constant) return { kind: 'constant', value: x[0], bits: 8 + bps };
  const verbatimBits = 8 + n * bps;
  const maxPartOrder = Math.min(8, 31 - Math.clz32(n));

  // FIXED 0..4 — residual + cheap estimate, keep the best
  let best: { order: number; sum: number } | null = null;
  const maxFixed = Math.min(4, n - 1);
  for (let o = 0; o <= maxFixed; o++) {
    const res = pool[o];
    const m = n - o;
    switch (o) {
      case 0: for (let i = 0; i < n; i++) res[i] = x[i]; break;
      case 1: for (let i = 1; i < n; i++) res[i - 1] = x[i] - x[i - 1]; break;
      case 2: for (let i = 2; i < n; i++) res[i - 2] = x[i] - 2 * x[i - 1] + x[i - 2]; break;
      case 3: for (let i = 3; i < n; i++) res[i - 3] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]; break;
      default: for (let i = 4; i < n; i++) res[i - 4] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]; break;
    }
    const s = sumAbs(res, m);
    if (!best || estimateBits(s, m) + o * bps < estimateBits(best.sum, n - best.order) + best.order * bps) best = { order: o, sum: s };
  }
  let plan: Plan;
  {
    const o = best!.order;
    const rice = planRice(pool[o], n, o, maxPartOrder, scratch);
    plan = { kind: 'fixed', order: o, res: pool[o], partOrder: rice.partOrder, params: rice.params, bits: 8 + o * bps + rice.bits };
  }

  // LPC 1..maxLpc — Levinson once, pick the order with the best predicted cost,
  // quantize, compute the real residual, keep it if it beats the fixed plan.
  if (maxLpc > 0 && n > maxLpc + 1 && n >= 32) {
    const order = Math.min(maxLpc, 32);
    const ok = lpcAnalyse(x, n, order, lpcTmp);
    if (ok) {
      let bestO = 0, bestCost = Infinity;
      for (let o = 1; o <= order; o++) {
        const err = lpcTmp.error[o - 1];
        if (!(err > 0)) continue;
        const cost = (n - o) * Math.max(0, 0.5 * log2(err / n) + 1) + o * (bps + 15) + 8;
        if (cost < bestCost) { bestCost = cost; bestO = o; }
      }
      if (bestO > 0) {
        const q = quantizeLpc(lpcTmp.coef[bestO - 1], bestO, 15, lpcTmp.q);
        if (q) {
          const res = pool[5];
          const coefs = lpcTmp.q;
          const sh = q.shift;
          const div = 2 ** sh;
          for (let i = bestO; i < n; i++) {
            let sum = 0;
            for (let j = 0; j < bestO; j++) sum += coefs[j] * x[i - 1 - j];
            res[i - bestO] = x[i] - Math.floor(sum / div);
          }
          const rice = planRice(res, n, bestO, maxPartOrder, scratch);
          const bits = 8 + bestO * bps + 4 + 5 + bestO * 15 + rice.bits;
          if (bits < plan.bits) plan = { kind: 'lpc', order: bestO, precision: 15, shift: sh, coefs: Int32Array.from(coefs.subarray(0, bestO)), res, partOrder: rice.partOrder, params: rice.params, bits };
        }
      }
    }
  }
  if (verbatimBits <= plan.bits) return { kind: 'verbatim', bits: verbatimBits };
  return plan;
}

// ── LPC ─────────────────────────────────────────────────────────────────────
interface LpcScratch { win: Float64Array; autoc: Float64Array; coef: Float64Array[]; error: Float64Array; lpc: Float64Array; q: Int32Array }
function makeLpcScratch(maxOrder: number, blockSize: number): LpcScratch {
  return {
    win: new Float64Array(blockSize), autoc: new Float64Array(maxOrder + 1),
    coef: Array.from({ length: maxOrder }, () => new Float64Array(maxOrder)),
    error: new Float64Array(maxOrder), lpc: new Float64Array(maxOrder), q: new Int32Array(maxOrder),
  };
}
/** Welch-windowed autocorrelation + Levinson-Durbin (libFLAC's recurrence).
 *  coef[o-1][j] predicts x[i] = Σ coef[j]·x[i-1-j]; error[o-1] = residual energy. */
function lpcAnalyse(x: Int32Array, n: number, maxOrder: number, s: LpcScratch): boolean {
  const w = s.win;
  const half = (n - 1) / 2, den = (n + 1) / 2;
  for (let i = 0; i < n; i++) { const t = (i - half) / den; w[i] = x[i] * (1 - t * t); }
  const autoc = s.autoc;
  for (let lag = 0; lag <= maxOrder; lag++) {
    let sum = 0;
    for (let i = lag; i < n; i++) sum += w[i] * w[i - lag];
    autoc[lag] = sum;
  }
  if (!(autoc[0] > 0)) return false;
  let err = autoc[0];
  const lpc = s.lpc;
  for (let i = 0; i < maxOrder; i++) {
    let r = -autoc[i + 1];
    for (let j = 0; j < i; j++) r -= lpc[j] * autoc[i - j];
    r /= err;
    err *= (1 - r * r);
    lpc[i] = r;
    let j = 0;
    for (; j < (i >> 1); j++) { const tmp = lpc[j]; lpc[j] += r * lpc[i - 1 - j]; lpc[i - 1 - j] += r * tmp; }
    if (i & 1) lpc[j] += lpc[j] * r;
    for (j = 0; j <= i; j++) s.coef[i][j] = -lpc[j];
    s.error[i] = err;
  }
  return true;
}
/** Quantize to `precision`-bit signed integers with a common shift (libFLAC style). */
function quantizeLpc(coef: Float64Array, order: number, precision: number, out: Int32Array): { shift: number } | null {
  let cmax = 0;
  for (let j = 0; j < order; j++) { const a = Math.abs(coef[j]); if (a > cmax) cmax = a; }
  if (!(cmax > 0) || !isFinite(cmax)) return null;
  let shift = precision - 2 - Math.floor(log2(cmax));
  if (shift > 15) shift = 15;
  if (shift < 0) return null; // coefficients too large to represent — fall back to fixed
  const qmax = 2 ** (precision - 1) - 1, qmin = -(2 ** (precision - 1));
  let errAcc = 0;
  for (let j = 0; j < order; j++) {
    errAcc += coef[j] * 2 ** shift;
    let q = Math.round(errAcc);
    if (q > qmax) q = qmax; else if (q < qmin) q = qmin;
    errAcc -= q;
    out[j] = q;
  }
  return { shift };
}

// ── writing ─────────────────────────────────────────────────────────────────
function writeResidual(bw: BitWriter, res: Int32Array, n: number, predOrder: number, partOrder: number, params: Uint8Array): void {
  bw.writeBits(0, 2);           // Rice, 4-bit parameters
  bw.writeBits(partOrder, 4);
  const nparts = 1 << partOrder;
  const per = n >> partOrder;
  let i = 0;
  for (let p = 0; p < nparts; p++) {
    const k = params[p];
    bw.writeBits(k, 4);
    const count = p === 0 ? per - predOrder : per;
    const end = i + count;
    for (; i < end; i++) { const r = res[i]; bw.writeRice(r >= 0 ? 2 * r : -2 * r - 1, k); }
  }
}
function writeSubframe(bw: BitWriter, x: Int32Array, n: number, bps: number, plan: Plan): void {
  bw.writeBits(0, 1);
  switch (plan.kind) {
    case 'constant':
      bw.writeBits(0b000000, 6); bw.writeBits(0, 1);
      bw.writeSigned(plan.value, bps);
      return;
    case 'verbatim':
      bw.writeBits(0b000001, 6); bw.writeBits(0, 1);
      for (let i = 0; i < n; i++) bw.writeSigned(x[i], bps);
      return;
    case 'fixed':
      bw.writeBits(0b001000 | plan.order, 6); bw.writeBits(0, 1);
      for (let i = 0; i < plan.order; i++) bw.writeSigned(x[i], bps);
      writeResidual(bw, plan.res, n, plan.order, plan.partOrder, plan.params);
      return;
    case 'lpc':
      bw.writeBits(0b100000 | (plan.order - 1), 6); bw.writeBits(0, 1);
      for (let i = 0; i < plan.order; i++) bw.writeSigned(x[i], bps);
      bw.writeBits(plan.precision - 1, 4);
      bw.writeSigned(plan.shift, 5);
      for (let j = 0; j < plan.order; j++) bw.writeSigned(plan.coefs[j], plan.precision);
      writeResidual(bw, plan.res, n, plan.order, plan.partOrder, plan.params);
      return;
  }
}
function writeUtf8Number(bw: BitWriter, v: number): void {
  if (v < 0x80) { bw.writeBits(v, 8); return; }
  let bytes = 2;
  while (bytes < 7 && v >= 2 ** (5 * bytes + 1)) bytes++;  // 2→11 bits, 3→16, 4→21, 5→26, 6→31
  const prefixLead = ((0xff << (8 - bytes)) & 0xff);
  const leadBits = 7 - bytes;
  bw.writeBits(prefixLead | Math.floor(v / 2 ** (6 * (bytes - 1))) & ((1 << leadBits) - 1), 8);
  for (let i = bytes - 2; i >= 0; i--) bw.writeBits(0x80 | (Math.floor(v / 2 ** (6 * i)) & 0x3f), 8);
}
const sampleRateCode = (sr: number): { code: number; extraBits: number; extra: number } => {
  switch (sr) {
    case 88200: return { code: 0b0001, extraBits: 0, extra: 0 };
    case 176400: return { code: 0b0010, extraBits: 0, extra: 0 };
    case 192000: return { code: 0b0011, extraBits: 0, extra: 0 };
    case 8000: return { code: 0b0100, extraBits: 0, extra: 0 };
    case 16000: return { code: 0b0101, extraBits: 0, extra: 0 };
    case 22050: return { code: 0b0110, extraBits: 0, extra: 0 };
    case 24000: return { code: 0b0111, extraBits: 0, extra: 0 };
    case 32000: return { code: 0b1000, extraBits: 0, extra: 0 };
    case 44100: return { code: 0b1001, extraBits: 0, extra: 0 };
    case 48000: return { code: 0b1010, extraBits: 0, extra: 0 };
    case 96000: return { code: 0b1011, extraBits: 0, extra: 0 };
  }
  if (sr < 65536) return { code: 0b1101, extraBits: 16, extra: sr };
  return { code: 0b1110, extraBits: 16, extra: Math.round(sr / 10) };
};
const sampleSizeCode = (bps: number): number => bps === 8 ? 0b001 : bps === 12 ? 0b010 : bps === 16 ? 0b100 : bps === 20 ? 0b101 : bps === 24 ? 0b110 : 0;

/**
 * Encode planar integer PCM (one Int16Array/Int32Array per channel, already at
 * `bitsPerSample`) into a complete FLAC file. Returns the bytes.
 */
export function encodeFLAC(channels: ArrayLike<number>[], sampleRate: number, bitsPerSample: 16 | 24 = 16, opts: FlacEncodeOptions = {}): Uint8Array {
  const nch = channels.length;
  if (nch < 1 || nch > 8) throw new Error('flac: 1–8 channels');
  const total = channels[0].length;
  for (const c of channels) if (c.length !== total) throw new Error('flac: channel lengths differ');
  const blockSize = Math.max(16, Math.min(65535, opts.blockSize ?? 4096));
  const maxLpc = Math.max(0, Math.min(32, opts.maxLpcOrder ?? 8));
  const bps = bitsPerSample;
  const bw = new BitWriter();

  // fLaC + STREAMINFO (last metadata block)
  bw.writeBits(0x66, 8); bw.writeBits(0x4c, 8); bw.writeBits(0x61, 8); bw.writeBits(0x43, 8);
  bw.writeBits(1, 1); bw.writeBits(0, 7); bw.writeBits(34, 24);
  bw.writeBits(blockSize, 16); bw.writeBits(blockSize, 16);
  bw.writeBits(0, 24); bw.writeBits(0, 24);           // min/max frame size unknown
  bw.writeBits(sampleRate, 20); bw.writeBits(nch - 1, 3); bw.writeBits(bps - 1, 5);
  bw.writeBits(total, 36);
  const md5 = pcmMd5(channels, total, bps);
  for (let i = 0; i < 16; i++) bw.writeBits(md5[i], 8);

  const sr = sampleRateCode(sampleRate);
  const bufs = Array.from({ length: 4 }, () => new Int32Array(blockSize)); // L R M S
  const pool = Array.from({ length: 6 }, () => new Int32Array(blockSize));
  const poolB = Array.from({ length: 6 }, () => new Int32Array(blockSize));
  const poolS = Array.from({ length: 6 }, () => new Int32Array(blockSize)); // side / mid plans keep
  const poolM = Array.from({ length: 6 }, () => new Int32Array(blockSize)); // their own residuals
  const scratch = new Float64Array(blockSize + 1);
  const lpcA = makeLpcScratch(Math.max(1, maxLpc), blockSize), lpcB = makeLpcScratch(Math.max(1, maxLpc), blockSize);

  let frame = 0;
  for (let pos = 0; pos < total; pos += blockSize, frame++) {
    const n = Math.min(blockSize, total - pos);
    const start = bw.pos;
    // frame header
    bw.writeBits(0x3ffe, 14); bw.writeBits(0, 1); bw.writeBits(0, 1); // sync, reserved, fixed blocksize
    bw.writeBits(0b0111, 4);                                         // 16-bit blocksize-1 follows
    bw.writeBits(sr.code, 4);
    let chanCode: number; let mode: 0 | 1 | 2 | 3 = 0;               // 0 indep, 1 L/S, 2 R/S, 3 M/S
    const plans: Plan[] = []; const sigs: Int32Array[] = []; const bpss: number[] = [];
    if (nch === 2) {
      const L = bufs[0], R = bufs[1], M = bufs[2], S = bufs[3];
      const cl = channels[0], cr = channels[1];
      for (let i = 0; i < n; i++) { const l = cl[pos + i], r = cr[pos + i]; L[i] = l; R[i] = r; S[i] = l - r; M[i] = (l + r) >> 1; }
      const pL = planChannel(L, n, bps, maxLpc, pool, scratch, lpcA);
      const pR = planChannel(R, n, bps, maxLpc, poolB, scratch, lpcB);
      const pS = planChannel(S, n, bps + 1, maxLpc, poolS, scratch, lpcA);
      const pM = planChannel(M, n, bps, maxLpc, poolM, scratch, lpcB);
      const indep = pL.bits + pR.bits, ls = pL.bits + pS.bits, rs = pS.bits + pR.bits, ms = pM.bits + pS.bits;
      const minBits = Math.min(indep, ls, rs, ms);
      if (minBits === indep) { mode = 0; plans.push(pL, pR); sigs.push(L, R); bpss.push(bps, bps); }
      else if (minBits === ls) { mode = 1; plans.push(pL, pS); sigs.push(L, S); bpss.push(bps, bps + 1); }
      else if (minBits === rs) { mode = 2; plans.push(pS, pR); sigs.push(S, R); bpss.push(bps + 1, bps); }
      else { mode = 3; plans.push(pM, pS); sigs.push(M, S); bpss.push(bps, bps + 1); }
      chanCode = mode === 0 ? 0b0001 : mode === 1 ? 0b1000 : mode === 2 ? 0b1001 : 0b1010;
    } else {
      chanCode = nch - 1;
      for (let c = 0; c < nch; c++) {
        const X = c < 4 ? bufs[c] : new Int32Array(blockSize);
        const src = channels[c];
        for (let i = 0; i < n; i++) X[i] = src[pos + i];
        plans.push(planChannel(X, n, bps, maxLpc, c % 2 ? poolB : pool, scratch, c % 2 ? lpcB : lpcA));
        sigs.push(X); bpss.push(bps);
      }
    }
    bw.writeBits(chanCode, 4);
    bw.writeBits(sampleSizeCode(bps), 3);
    bw.writeBits(0, 1);
    writeUtf8Number(bw, frame);
    bw.writeBits(n - 1, 16);
    if (sr.extraBits) bw.writeBits(sr.extra, sr.extraBits);
    bw.writeBits(bw.crc8(start), 8);
    for (let c = 0; c < plans.length; c++) writeSubframe(bw, sigs[c], n, bpss[c], plans[c]);
    bw.alignByte();
    bw.writeBits(bw.crc16(start), 16);
  }
  return bw.bytes();
}

/** Float [-1,1] planar → 16-bit with TPDF dither, the SAME quantiser (same
 *  PRNG, same interleaved draw order) as encodeWAV's 16-bit path — so a FLAC
 *  and a WAV of the same buffer hold bit-identical samples. */
export function quantizeTPDF16(chans: ArrayLike<number>[], numSamples: number): Int16Array[] {
  const numCh = chans.length;
  const out = chans.map(() => new Int16Array(numSamples));
  let s1 = 0x2545f491, s2 = 0x9e3779b9;
  const rnd = () => {
    s1 ^= s1 << 13; s1 ^= s1 >>> 17; s1 ^= s1 << 5;
    s2 ^= s2 << 13; s2 ^= s2 >>> 17; s2 ^= s2 << 5;
    return ((s1 >>> 0) / 4294967296) - ((s2 >>> 0) / 4294967296);
  };
  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numCh; ch++) {
      const x = Math.max(-1, Math.min(1, chans[ch][i]));
      out[ch][i] = Math.max(-32768, Math.min(32767, Math.round(x * 32767 + rnd())));
    }
  }
  return out;
}
