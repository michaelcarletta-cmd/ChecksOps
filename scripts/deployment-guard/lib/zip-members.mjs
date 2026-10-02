import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = i;
    for (let j = 0; j < 8; j += 1) {
      crc = (crc & 1) ? (0xEDB88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xFFFF);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function readZipMembers(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('invalid zip: EOCD not found');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const members = {};
  let p = cdOffset;
  const cdEnd = cdOffset + cdSize;
  while (p < cdEnd) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith('/')) continue;
    if (Object.prototype.hasOwnProperty.call(members, name)) {
      throw new Error(`DUPLICATE_ZIP_MEMBER: ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = inflateRawSync(compressed);
    else throw new Error(`unsupported zip method ${method} for ${name}`);
    members[name] = Buffer.from(data);
  }
  return members;
}

export function writeZipMembers(members) {
  const names = Object.keys(members).sort();
  const localParts = [];
  const files = [];
  let offset = 0;
  for (const name of names) {
    const raw = Buffer.isBuffer(members[name]) ? members[name] : Buffer.from(members[name]);
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(raw);
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(Buffer.concat([local, nameBuf, payload]));
    files.push({
      nameBuf,
      method,
      crc,
      compSize: payload.length,
      rawSize: raw.length,
      localOffset: offset,
    });
    offset += 30 + nameBuf.length + payload.length;
  }
  const cdParts = [];
  let cdSize = 0;
  for (const file of files) {
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(file.method, 10);
    cd.writeUInt32LE(file.crc, 16);
    cd.writeUInt32LE(file.compSize, 20);
    cd.writeUInt32LE(file.rawSize, 24);
    cd.writeUInt16LE(file.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(file.localOffset, 42);
    cdParts.push(Buffer.concat([cd, file.nameBuf]));
    cdSize += 46 + file.nameBuf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...cdParts, eocd]);
}

export function hashZipMembers(buffer) {
  const members = readZipMembers(buffer);
  const hashes = {};
  for (const [name, data] of Object.entries(members)) {
    hashes[name] = createHash('sha256').update(data).digest('hex');
  }
  return hashes;
}

export function overlayZipMembers(liveZip, replacements) {
  const members = readZipMembers(liveZip);
  for (const [name, data] of Object.entries(replacements || {})) {
    members[name] = Buffer.isBuffer(data) ? data : Buffer.from(data);
  }
  return writeZipMembers(members);
}
