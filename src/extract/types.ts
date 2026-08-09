// The shape every extractor returns. One discriminated union so the download
// tool can hand back "here is the content" without knowing which format it
// came from, and so a caller can branch on `kind` instead of on MIME strings.

export interface SheetExtract {
  name: string;
  /** Rows actually extracted (not the sheet's declared dimension). */
  rows: number;
  /** Widest row's column count. */
  cols: number;
  /** Cell values as CSV — quoted per RFC 4180. */
  csv: string;
  /** True when the cell budget cut this sheet short. */
  truncated?: boolean;
}

export interface SpreadsheetExtract {
  kind: 'spreadsheet';
  sheets: SheetExtract[];
  omitted?: string[];
  truncated?: boolean;
}

export interface DocumentExtract {
  kind: 'document';
  /** Document text with headings (`#`), list bullets and table rows preserved. */
  text: string;
  truncated?: boolean;
}

export interface SlideExtract {
  /** 1-based slide number. */
  number: number;
  text: string;
  /** Speaker notes, when the slide has a notes part. */
  notes?: string;
}

export interface PresentationExtract {
  kind: 'presentation';
  slides: SlideExtract[];
  omitted?: string[];
  truncated?: boolean;
}

export interface PageExtract {
  /** 1-based page number, in the order pages appear in the file. */
  number: number;
  text: string;
}

export interface PdfExtract {
  kind: 'pdf';
  pages: PageExtract[];
  /**
   * False when the PDF carries no extractable text layer — i.e. it is a scan.
   * The caller gets an explicit "this needs OCR" signal instead of silence.
   */
  textLayer: boolean;
  note?: string;
  omitted?: string[];
  truncated?: boolean;
}

export interface TextExtract {
  kind: 'text';
  text: string;
  truncated?: boolean;
}

export type Extracted =
  | SpreadsheetExtract
  | DocumentExtract
  | PresentationExtract
  | PdfExtract
  | TextExtract;

/**
 * Decides which parts (sheets / slides / pages) to extract. Applied BEFORE a
 * part is decompressed and parsed, so a range request over a large file is
 * cheap rather than "parse everything, then throw most of it away".
 */
export type PartSelector = (index: number, name: string) => boolean;
