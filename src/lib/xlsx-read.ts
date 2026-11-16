/**
 * Minimal .xlsx reader — no dependencies beyond Node's zlib.
 *
 * The counterpart of `src/lib/xlsx.ts` (which only writes). Used server-side to
 * read spreadsheets HR uploads, e.g. the external DTR's undertime summary,
 * without asking them to "Save As CSV" first.
 *
 * Scope is deliberately small: the first worksheet (or one by index), cell
 * values as strings or numbers. Shared strings, inline strings, formula string
 * results and rich text runs are handled; styles, dates-as-dates and formulas
 * are not. ZIP64 archives are rejected — a spreadsheet that needs one is far
 * beyond anything HR uploads.
 *
 * Node-only (node:zlib), so import it from server code and tests, never from a
 * client component.
 */
import { inflateRawSync } from "node:zlib";

export type XlsxReadCell = string | number | null;

export interface XlsxReadSheet {
  name: string;
  /** Row arrays in sheet order; `rowNumber` is the 1-based row in Excel. */
  rows: { rowNumber: number; cells: XlsxReadCell[] }[];
}

/* -------------------------------------------------------------------------- */
/* ZIP                                                                        */
/* -------------------------------------------------------------------------- */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Every file in a ZIP archive, by path. Supports STORE and DEFLATE. */
export function unzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // The end-of-central-directory record sits at the end, after an optional
  // comment of up to 65535 bytes.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Not a valid .xlsx file (no ZIP directory found).");

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  if (count === 0xffff || offset === 0xffffffff) {
    throw new Error("ZIP64 spreadsheets are not supported.");
  }

  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) {
      throw new Error("Corrupt .xlsx file (bad ZIP directory entry).");
    }
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;

    if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
      throw new Error(`Corrupt .xlsx file (bad local header for ${name}).`);
    }
    // The local header's name/extra lengths can differ from the central copy.
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    if (method === 0) files.set(name, raw);
    else if (method === 8) files.set(name, new Uint8Array(inflateRawSync(raw)));
    else throw new Error(`Unsupported ZIP compression method ${method} for ${name}.`);
  }
  return files;
}

/* -------------------------------------------------------------------------- */
/* XML helpers                                                                */
/* -------------------------------------------------------------------------- */

function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Concatenated text of every <t> inside a fragment (handles rich-text runs). */
function textRuns(fragment: string): string {
  let out = "";
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) out += m[1];
  return decodeXml(out);
}

function attr(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
}

/** "A" -> 0, "Z" -> 25, "AA" -> 26. */
function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* -------------------------------------------------------------------------- */
/* Workbook                                                                   */
/* -------------------------------------------------------------------------- */

function sheetPaths(files: Map<string, Uint8Array>): { name: string; path: string }[] {
  const decoder = new TextDecoder();
  const workbook = files.get("xl/workbook.xml");
  if (!workbook) throw new Error("Not a valid .xlsx file (no workbook).");
  const rels = files.get("xl/_rels/workbook.xml.rels");
  const relTargets = new Map<string, string>();
  if (rels) {
    for (const m of decoder.decode(rels).matchAll(/<Relationship\b([^>]*)\/?>/g)) {
      const id = attr(m[1], "Id");
      const target = attr(m[1], "Target");
      if (id && target) relTargets.set(id, target);
    }
  }
  const out: { name: string; path: string }[] = [];
  for (const m of decoder.decode(workbook).matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(attr(m[1], "name") ?? "");
    const rid = attr(m[1], "r:id");
    let target = (rid && relTargets.get(rid)) || `worksheets/sheet${out.length + 1}.xml`;
    target = target.replace(/^\//, "");
    out.push({ name, path: target.startsWith("xl/") ? target : `xl/${target}` });
  }
  return out;
}

function sharedStrings(files: Map<string, Uint8Array>): string[] {
  const bytes = files.get("xl/sharedStrings.xml");
  if (!bytes) return [];
  const xml = new TextDecoder().decode(bytes);
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textRuns(m[1]));
}

/** Reads one worksheet (default: the first) as rows of strings / numbers. */
export function readXlsxSheet(bytes: Uint8Array, sheetIndex = 0): XlsxReadSheet {
  const files = unzip(bytes);
  const sheets = sheetPaths(files);
  const sheet = sheets[sheetIndex];
  if (!sheet) throw new Error(`The workbook has no sheet #${sheetIndex + 1}.`);
  const data = files.get(sheet.path);
  if (!data) throw new Error(`Sheet "${sheet.name}" is missing from the file.`);
  const shared = sharedStrings(files);
  const xml = new TextDecoder().decode(data);

  const rows: XlsxReadSheet["rows"] = [];
  let implicitRow = 0;
  for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNumber = Number(attr(rm[1], "r") ?? implicitRow + 1);
    implicitRow = rowNumber;
    const cells: XlsxReadCell[] = [];
    let implicitCol = 0;
    for (const cm of (rm[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(cm[1], "r");
      const col = ref ? columnIndex(ref) : implicitCol;
      implicitCol = col + 1;
      const type = attr(cm[1], "t");
      const body = cm[2] ?? "";
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let value: XlsxReadCell = null;
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? null;
      else if (type === "inlineStr") value = textRuns(body);
      else if (type === "str" || type === "e") value = v !== undefined ? decodeXml(v) : null;
      else if (type === "b") value = v === "1" ? "TRUE" : v === "0" ? "FALSE" : null;
      else if (v !== undefined) {
        const n = Number(v);
        value = Number.isFinite(n) ? n : decodeXml(v);
      }
      while (cells.length < col) cells.push(null);
      cells[col] = value;
    }
    rows.push({ rowNumber, cells });
  }
  return { name: sheet.name, rows };
}
