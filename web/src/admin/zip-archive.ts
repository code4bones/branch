const encoder = new TextEncoder();
const maxZipEntries = 64;
const maxZipEntryBytes = 1024 * 1024;
const maxZipArchiveBytes = 8 * 1024 * 1024;
const dosDate1980Jan1 = 33;

interface EncodedZipEntry {
  readonly path: Uint8Array<ArrayBuffer>;
  readonly content: Uint8Array<ArrayBuffer>;
  readonly crc32: number;
}

export interface ZipArchiveEntry {
  readonly path: string;
  readonly content: string;
}

export function makeStoredZipArchive(entries: readonly ZipArchiveEntry[]): Uint8Array<ArrayBuffer> {
  if (entries.length === 0 || entries.length > maxZipEntries) {
    throw new Error("zip entry count outside bounds");
  }

  const encoded = entries.map(encodeEntry);
  let localOffset = 0;
  const localParts: Uint8Array<ArrayBuffer>[] = [];
  const centralParts: Uint8Array<ArrayBuffer>[] = [];
  for (const entry of encoded) {
    const local = makeLocalFileHeader(entry);
    localParts.push(local, entry.content);
    centralParts.push(makeCentralDirectoryHeader(entry, localOffset));
    localOffset += local.byteLength + entry.content.byteLength;
  }

  const centralSize = byteLengthOf(centralParts);
  const archiveSize = localOffset + centralSize + 22;
  if (archiveSize > maxZipArchiveBytes) {
    throw new Error("zip archive too large");
  }

  const output = new Uint8Array(archiveSize);
  let offset = writeParts(output, 0, localParts);
  const centralOffset = offset;
  offset = writeParts(output, offset, centralParts);
  writeEndOfCentralDirectory(output, offset, encoded.length, centralSize, centralOffset);
  return output;
}

function encodeEntry(entry: ZipArchiveEntry): EncodedZipEntry {
  validateZipPath(entry.path);
  const path = encoder.encode(entry.path);
  const content = encoder.encode(entry.content);
  if (path.byteLength === 0 || path.byteLength > 65535) {
    throw new Error("zip path outside bounds");
  }
  if (content.byteLength > maxZipEntryBytes) {
    throw new Error("zip entry too large");
  }
  return {
    path,
    content,
    crc32: crc32(content)
  };
}

function validateZipPath(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error("zip path must be relative");
  }
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error("zip path must be normalized");
  }
}

function makeLocalFileHeader(entry: EncodedZipEntry): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(30 + entry.path.byteLength);
  const view = new DataView(header.buffer);
  let offset = 0;
  offset = writeUint32LE(view, offset, 0x04034b50);
  offset = writeUint16LE(view, offset, 20);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, dosDate1980Jan1);
  offset = writeUint32LE(view, offset, entry.crc32);
  offset = writeUint32LE(view, offset, entry.content.byteLength);
  offset = writeUint32LE(view, offset, entry.content.byteLength);
  offset = writeUint16LE(view, offset, entry.path.byteLength);
  offset = writeUint16LE(view, offset, 0);
  header.set(entry.path, offset);
  return header;
}

function makeCentralDirectoryHeader(entry: EncodedZipEntry, localOffset: number): Uint8Array<ArrayBuffer> {
  const header = new Uint8Array(46 + entry.path.byteLength);
  const view = new DataView(header.buffer);
  let offset = 0;
  offset = writeUint32LE(view, offset, 0x02014b50);
  offset = writeUint16LE(view, offset, 20);
  offset = writeUint16LE(view, offset, 20);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, dosDate1980Jan1);
  offset = writeUint32LE(view, offset, entry.crc32);
  offset = writeUint32LE(view, offset, entry.content.byteLength);
  offset = writeUint32LE(view, offset, entry.content.byteLength);
  offset = writeUint16LE(view, offset, entry.path.byteLength);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint32LE(view, offset, 0);
  offset = writeUint32LE(view, offset, localOffset);
  header.set(entry.path, offset);
  return header;
}

function writeEndOfCentralDirectory(
  target: Uint8Array,
  offset: number,
  entryCount: number,
  centralSize: number,
  centralOffset: number
): void {
  const view = new DataView(target.buffer);
  offset = writeUint32LE(view, offset, 0x06054b50);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, 0);
  offset = writeUint16LE(view, offset, entryCount);
  offset = writeUint16LE(view, offset, entryCount);
  offset = writeUint32LE(view, offset, centralSize);
  offset = writeUint32LE(view, offset, centralOffset);
  writeUint16LE(view, offset, 0);
}

function writeParts(target: Uint8Array<ArrayBuffer>, offset: number, parts: readonly Uint8Array<ArrayBuffer>[]): number {
  for (const part of parts) {
    target.set(part, offset);
    offset += part.byteLength;
  }
  return offset;
}

function byteLengthOf(parts: readonly Uint8Array<ArrayBuffer>[]): number {
  return parts.reduce((sum, part) => sum + part.byteLength, 0);
}

function writeUint16LE(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}

function writeUint32LE(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value >>> 0, true);
  return offset + 4;
}

function crc32(data: Uint8Array<ArrayBuffer>): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ readCRC32Table((crc ^ byte) & 0xff);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeCRC32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

const crc32Table = makeCRC32Table();

function readCRC32Table(index: number): number {
  const value = crc32Table[index];
  if (value === undefined) {
    throw new Error("crc32 table index outside range");
  }
  return value;
}
