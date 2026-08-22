/**
 * Minimal store-only ZIP writer. No compression — entries are packed raw so
 * the WAVs inside stay byte-identical to what a DAW expects. About 80 LOC,
 * no external deps. Used to bundle a Drum Rack `.adg` together with its
 * `Samples/` directory into one downloadable archive.
 */

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, e.g. "Presets/Instruments/Drum Rack/Foo.adg" */
  path: string;
  data: Uint8Array;
}

/** Build a flat store-only ZIP. Returns the archive bytes. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  type Prepared = { nameBytes: Uint8Array; crc: number; data: Uint8Array; localOff: number };
  const prepared: Prepared[] = [];

  let localTotal = 0;
  for (const e of entries) {
    const nameBytes = enc.encode(e.path);
    const crc = crc32(e.data);
    prepared.push({ nameBytes, crc, data: e.data, localOff: localTotal });
    localTotal += 30 + nameBytes.length + e.data.length;
  }

  let centralSize = 0;
  for (const p of prepared) centralSize += 46 + p.nameBytes.length;

  const out = new Uint8Array(localTotal + centralSize + 22);
  const dv = new DataView(out.buffer);
  let pos = 0;

  // Local file headers + data
  for (const p of prepared) {
    dv.setUint32(pos, 0x04034b50, true); pos += 4;          // signature
    dv.setUint16(pos, 20, true); pos += 2;                  // version needed
    dv.setUint16(pos, 0, true); pos += 2;                   // flags
    dv.setUint16(pos, 0, true); pos += 2;                   // method (0 = store)
    dv.setUint16(pos, 0, true); pos += 2;                   // mod time
    dv.setUint16(pos, 0x21, true); pos += 2;                // mod date (1980-01-01)
    dv.setUint32(pos, p.crc, true); pos += 4;
    dv.setUint32(pos, p.data.length, true); pos += 4;       // compressed size
    dv.setUint32(pos, p.data.length, true); pos += 4;       // uncompressed size
    dv.setUint16(pos, p.nameBytes.length, true); pos += 2;
    dv.setUint16(pos, 0, true); pos += 2;                   // extra len
    out.set(p.nameBytes, pos); pos += p.nameBytes.length;
    out.set(p.data, pos); pos += p.data.length;
  }

  const centralOff = pos;
  for (const p of prepared) {
    dv.setUint32(pos, 0x02014b50, true); pos += 4;
    dv.setUint16(pos, 20, true); pos += 2;                  // version made by
    dv.setUint16(pos, 20, true); pos += 2;                  // version needed
    dv.setUint16(pos, 0, true); pos += 2;                   // flags
    dv.setUint16(pos, 0, true); pos += 2;                   // method
    dv.setUint16(pos, 0, true); pos += 2;                   // time
    dv.setUint16(pos, 0x21, true); pos += 2;                // date
    dv.setUint32(pos, p.crc, true); pos += 4;
    dv.setUint32(pos, p.data.length, true); pos += 4;
    dv.setUint32(pos, p.data.length, true); pos += 4;
    dv.setUint16(pos, p.nameBytes.length, true); pos += 2;
    dv.setUint16(pos, 0, true); pos += 2;                   // extra
    dv.setUint16(pos, 0, true); pos += 2;                   // comment
    dv.setUint16(pos, 0, true); pos += 2;                   // disk
    dv.setUint16(pos, 0, true); pos += 2;                   // internal attrs
    dv.setUint32(pos, 0, true); pos += 4;                   // external attrs
    dv.setUint32(pos, p.localOff, true); pos += 4;
    out.set(p.nameBytes, pos); pos += p.nameBytes.length;
  }

  // End of central directory record
  dv.setUint32(pos, 0x06054b50, true); pos += 4;
  dv.setUint16(pos, 0, true); pos += 2;                     // this disk
  dv.setUint16(pos, 0, true); pos += 2;                     // disk with central dir
  dv.setUint16(pos, prepared.length, true); pos += 2;       // entries on this disk
  dv.setUint16(pos, prepared.length, true); pos += 2;       // total entries
  dv.setUint32(pos, centralSize, true); pos += 4;
  dv.setUint32(pos, centralOff, true); pos += 4;
  dv.setUint16(pos, 0, true); pos += 2;                     // comment len

  return out;
}
