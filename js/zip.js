// Minimal ZIP reader/writer. No dependencies; works in browsers and Node 20+.
// Reader: stored + deflate entries, ZIP64 directories. Writer: stored entries (images are already compressed).
import { mimeFor, splitPath } from './paths.js';

const SIG = { local: 0x04034b50, central: 0x02014b50, eocd: 0x06054b50, z64eocd: 0x06064b50, z64loc: 0x07064b50 };
const CP437 =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

export class ZipError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

function decodeName(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let s = '';
    for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
    return s;
  }
}

function readZip64Extra(extra, entry, need) {
  const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  for (let i = 0; i + 4 <= dv.byteLength; ) {
    const id = dv.getUint16(i, true);
    const len = dv.getUint16(i + 2, true);
    if (id === 1) {
      let q = i + 4;
      if (need.size) { entry.size = Number(dv.getBigUint64(q, true)); q += 8; }
      if (need.csize) { entry.compressedSize = Number(dv.getBigUint64(q, true)); q += 8; }
      if (need.offset) { entry.offset = Number(dv.getBigUint64(q, true)); }
    }
    i += 4 + len;
  }
}

export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new ZipError('The file is too small to be a ZIP/CBZ archive.');
  const tailLen = Math.min(size, 22 + 0xffff);
  const tail = new DataView(await blob.slice(size - tailLen, size).arrayBuffer());
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === SIG.eocd) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('No ZIP directory found. The file is damaged or is not a ZIP/CBZ archive.');

  let total = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== SIG.z64loc) throw new ZipError('The ZIP64 directory is damaged.');
    const z64 = Number(tail.getBigUint64(loc + 8, true));
    const rec = new DataView(await blob.slice(z64, z64 + 56).arrayBuffer());
    if (rec.byteLength < 56 || rec.getUint32(0, true) !== SIG.z64eocd) throw new ZipError('The ZIP64 directory is damaged.');
    total = Number(rec.getBigUint64(32, true));
    cdSize = Number(rec.getBigUint64(40, true));
    cdOffset = Number(rec.getBigUint64(48, true));
  }

  const cdBuf = await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer();
  const cd = new DataView(cdBuf);
  const bytes = new Uint8Array(cdBuf);
  const entries = [];
  for (let p = 0; p + 46 <= cd.byteLength && cd.getUint32(p, true) === SIG.central; ) {
    const flags = cd.getUint16(p + 8, true);
    const nameLen = cd.getUint16(p + 28, true);
    const extraLen = cd.getUint16(p + 30, true);
    const commentLen = cd.getUint16(p + 32, true);
    const entry = {
      flags,
      encrypted: (flags & 1) === 1,
      method: cd.getUint16(p + 10, true),
      crc: cd.getUint32(p + 16, true),
      compressedSize: cd.getUint32(p + 20, true),
      size: cd.getUint32(p + 24, true),
      offset: cd.getUint32(p + 42, true),
    };
    entry.name = decodeName(bytes.subarray(p + 46, p + 46 + nameLen));
    entry.isDir = entry.name.endsWith('/');
    const need = {
      size: entry.size === 0xffffffff,
      csize: entry.compressedSize === 0xffffffff,
      offset: entry.offset === 0xffffffff,
    };
    if (need.size || need.csize || need.offset) {
      readZip64Extra(bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), entry, need);
    }
    entries.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (entries.length < total) throw new ZipError('The ZIP directory is incomplete. The archive may be damaged.');

  async function dataSlice(entry) {
    if (entry.encrypted) throw new ZipError(`"${entry.name}" is password-protected.`);
    const head = new DataView(await blob.slice(entry.offset, entry.offset + 30).arrayBuffer());
    if (head.byteLength < 30 || head.getUint32(0, true) !== SIG.local) {
      throw new ZipError(`"${entry.name}" has a damaged header.`);
    }
    const start = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    return blob.slice(start, start + entry.compressedSize);
  }

  return {
    entries,
    /** Reads one entry as a Blob. Throws ZipError when it cannot be read. */
    async read(entry) {
      const slice = await dataSlice(entry);
      const type = mimeFor(splitPath(entry.name).ext);
      if (entry.method === 0) return new Blob([slice], { type });
      if (entry.method !== 8) throw new ZipError(`"${entry.name}" uses unsupported compression (method ${entry.method}).`);
      if (typeof DecompressionStream === 'undefined') {
        throw new ZipError('This browser cannot decompress ZIP entries. Use a current Chrome, Edge, Firefox or Safari.');
      }
      const out = await new Response(slice.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
      if (out.size !== entry.size) throw new ZipError(`"${entry.name}" is damaged (size mismatch).`);
      return new Blob([out], { type });
    },
    /** Cheap accessibility check: confirms the entry header is readable. */
    async probe(entry) {
      await dataSlice(entry);
    },
  };
}

// ---------- writer ----------

let crcTable;
export function crc32(data) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Writes stored (uncompressed) entries. ZIP64 records are added automatically when the
 * archive passes 65,535 entries or 4 GB, so there is no practical size limit.
 * With `sink` ({write(chunk)}), data goes straight to it and nothing is kept in memory;
 * without it, finish() returns a Blob.
 */
export class ZipWriter {
  constructor({ sink = null } = {}) {
    this.sink = sink;
    this.parts = [];
    this.central = [];
    this.offset = 0;
    this.names = new Set();
  }

  get count() {
    return this.central.length;
  }

  async emit(chunk, length) {
    if (this.sink) await this.sink.write(chunk);
    else this.parts.push(chunk);
    this.offset += length;
  }

  async addFile(path, blob, modified = new Date()) {
    if (this.names.has(path)) throw new ZipError(`Duplicate entry name "${path}".`);
    const name = new TextEncoder().encode(path);
    if (name.length > 0xffff) throw new ZipError(`The name "${path.slice(0, 60)}…" is too long for a ZIP entry.`);
    const data = new Uint8Array(await blob.arrayBuffer());
    if (data.length >= 0xffffffff) throw new ZipError(`"${path}" is larger than 4 GB; a single page that big is not supported.`);
    const crc = crc32(data);
    const { time, date } = dosDateTime(modified);
    const local = new Uint8Array(30 + name.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, SIG.local, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 0x0800, true); // UTF-8 names
    dv.setUint16(8, 0, true); // stored
    dv.setUint16(10, time, true);
    dv.setUint16(12, date, true);
    dv.setUint32(14, crc, true);
    dv.setUint32(18, data.length, true);
    dv.setUint32(22, data.length, true);
    dv.setUint16(26, name.length, true);
    local.set(name, 30);
    this.central.push({ name, crc, size: data.length, offset: this.offset, time, date });
    this.names.add(path);
    await this.emit(local, local.length);
    await this.emit(blob, data.length);
  }

  /** Writes the directory. Returns a Blob, or null when a sink was used. */
  async finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.central) {
      const big = e.offset >= 0xffffffff;
      const extra = big ? 12 : 0;
      const rec = new Uint8Array(46 + e.name.length + extra);
      const dv = new DataView(rec.buffer);
      dv.setUint32(0, SIG.central, true);
      dv.setUint16(4, big ? 45 : 20, true);
      dv.setUint16(6, big ? 45 : 20, true);
      dv.setUint16(8, 0x0800, true);
      dv.setUint16(12, e.time, true);
      dv.setUint16(14, e.date, true);
      dv.setUint32(16, e.crc, true);
      dv.setUint32(20, e.size, true);
      dv.setUint32(24, e.size, true);
      dv.setUint16(28, e.name.length, true);
      dv.setUint16(30, extra, true);
      dv.setUint32(42, big ? 0xffffffff : e.offset, true);
      rec.set(e.name, 46);
      if (big) {
        dv.setUint16(46 + e.name.length, 1, true);
        dv.setUint16(48 + e.name.length, 8, true);
        dv.setBigUint64(50 + e.name.length, BigInt(e.offset), true);
      }
      await this.emit(rec, rec.length);
      cdSize += rec.length;
    }
    const count = this.central.length;
    const zip64 = count >= 0xffff || cdStart >= 0xffffffff || cdSize >= 0xffffffff;
    if (zip64) {
      const z = new Uint8Array(56 + 20);
      const dv = new DataView(z.buffer);
      dv.setUint32(0, SIG.z64eocd, true);
      dv.setBigUint64(4, 44n, true);
      dv.setUint16(12, 45, true);
      dv.setUint16(14, 45, true);
      dv.setBigUint64(24, BigInt(count), true);
      dv.setBigUint64(32, BigInt(count), true);
      dv.setBigUint64(40, BigInt(cdSize), true);
      dv.setBigUint64(48, BigInt(cdStart), true);
      dv.setUint32(56, SIG.z64loc, true);
      dv.setBigUint64(64, BigInt(cdStart + cdSize), true);
      dv.setUint32(72, 1, true);
      await this.emit(z, z.length);
    }
    const end = new Uint8Array(22);
    const dv = new DataView(end.buffer);
    dv.setUint32(0, SIG.eocd, true);
    dv.setUint16(8, zip64 ? 0xffff : count, true);
    dv.setUint16(10, zip64 ? 0xffff : count, true);
    dv.setUint32(12, zip64 ? 0xffffffff : cdSize, true);
    dv.setUint32(16, zip64 ? 0xffffffff : cdStart, true);
    await this.emit(end, end.length);
    return this.sink ? null : new Blob(this.parts, { type: 'application/vnd.comicbook+zip' });
  }
}
