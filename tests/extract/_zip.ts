// Test-only ZIP writer. Builds the OOXML fixtures (xlsx/docx/pptx are just ZIP
// containers of XML) that the extractors read back, in both STORED and DEFLATE
// flavours so `readZip` exercises both branches against real archives rather
// than a mocked inflate.

import { deflateRawSync, crc32 } from 'node:zlib';

export interface ZipInput {
  name: string;
  data: string | Buffer;
  /** 0 = stored, 8 = deflate (default). */
  method?: number;
}

function u16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0);
  return b;
}

/** Build a ZIP archive from the given entries. */
export function makeZip(entries: ZipInput[], opts: { comment?: string } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.method ?? 8;
    const stored = method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(raw.length), u16(name.length), u16(0),
      name, stored,
    ]);
    locals.push(local);

    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u16(0), u16(0),
      u32(crc), u32(stored.length), u32(raw.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset),
      name,
    ]));
    offset += local.length;
  }

  const central = Buffer.concat(centrals);
  const comment = Buffer.from(opts.comment ?? '', 'utf8');
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(comment.length), comment,
  ]);
  return Buffer.concat([...locals, central, eocd]);
}
