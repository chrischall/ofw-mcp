// Test-only PDF writer: enough of the object graph (catalog → pages → page →
// content stream) for the extractor to walk, in both raw and FlateDecode form.

import { deflateSync } from 'node:zlib';

export interface PdfSpec {
  /** One content stream per page. */
  pages: string[];
  /** Compress the content streams with FlateDecode. */
  compress?: boolean;
  /** Emit no /Type /Catalog object, forcing the file-order fallback. */
  noCatalog?: boolean;
  /** Add an /Encrypt entry to the trailer. */
  encrypt?: boolean;
  /** Replace the content-stream filter (e.g. "/DCTDecode"). */
  filter?: string;
  /** Corrupt the compressed payload so inflate fails. */
  corrupt?: boolean;
  /** Point every page at a /Contents object that does not exist. */
  danglingContents?: boolean;
}

export function makePdf(spec: PdfSpec): Buffer {
  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const push = (s: string | Buffer): void => {
    chunks.push(Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'));
  };

  const pageNums = spec.pages.map((_, i) => 3 + i * 2);
  const kids = pageNums.map((n) => `${n} 0 R`).join(' ');

  if (!spec.noCatalog) push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  push(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${spec.pages.length} >>\nendobj\n`);

  spec.pages.forEach((content, i) => {
    const pageNum = pageNums[i];
    const streamNum = pageNum + 1;
    const contentsRef = spec.danglingContents ? '9990 0 R' : `${streamNum} 0 R`;
    push(`${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents ${contentsRef} >>\nendobj\n`);

    let payload = Buffer.from(content, 'latin1');
    let filter = spec.filter ?? '';
    if (spec.compress) {
      payload = deflateSync(payload);
      filter = '/FlateDecode';
    }
    if (spec.corrupt) {
      payload = Buffer.from('this is not deflate data', 'latin1');
      filter = '/FlateDecode';
    }
    push(`${streamNum} 0 obj\n<< /Length ${payload.length}${filter ? ` /Filter ${filter}` : ''} >>\nstream\n`);
    push(payload);
    push('\nendstream\nendobj\n');
  });

  push(`trailer\n<< /Root 1 0 R${spec.encrypt ? ' /Encrypt 99 0 R' : ''} >>\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** A page content stream that shows `text` with a single Tj. */
export function showText(text: string): string {
  return `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
}
