// Store-only ZIP reader — the mirror of zipWriter.buildZip. Reads what we
// write (project bundles) and any plain "stored" zip; deflated entries are
// rejected with a clear error rather than garbage. Lifted from the export
// tests' parseZip.
export interface ZipReadEntry { path: string; data: Uint8Array }

export function parseZip(bytes: Uint8Array): ZipReadEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip: not a zip file (no end record)');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out: ZipReadEntry[] = [];
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('zip: bad central header');
    const method = dv.getUint16(off + 10, true);
    const size = dv.getUint32(off + 24, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const path = td.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    if (method !== 0) throw new Error(`zip: entry "${path}" is compressed — only stored zips are supported`);
    const localNameLen = dv.getUint16(localOff + 26, true);
    const localExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    out.push({ path, data: bytes.subarray(dataStart, dataStart + size) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
