// Unit tests for `src/lib/xlsx-read.ts`, the zero-dependency .xlsx reader
// behind the External Undertime import.
//
// Two archive shapes matter: the STORED zips our own writer (src/lib/xlsx.ts)
// produces, and the DEFLATE zips Excel saves, which carry a sharedStrings part
// instead of inline strings. Both are built here; the DEFLATE one by a tiny
// test-only zip writer so no fixture file holding real employee data is needed.
//
// Requires Node >= 22 for --experimental-strip-types.
// Run: npm run test:dtr

import assert from "node:assert/strict";
import test from "node:test";
import { deflateRawSync } from "node:zlib";
import { buildXlsx, crc32 } from "../../src/lib/xlsx.ts";
import { readXlsxSheet, unzip } from "../../src/lib/xlsx-read.ts";

const enc = new TextEncoder();

/** Minimal DEFLATE zip writer, the shape Excel saves. */
function deflateZip(entries: { name: string; text: string }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const data = enc.encode(e.text);
    const comp = new Uint8Array(deflateRawSync(data));
    const name = enc.encode(e.name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + comp.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(comp, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((s, c) => s + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, p);
    p += part.length;
  }
  return out;
}

const WORKBOOK = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Undertime Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`;
const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`;
const SHARED = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4">
<si><t>Name</t></si>
<si><t>Tot. Minutes</t></si>
<si><r><t>NIÑAL, </t></r><r><rPr><b/></rPr><t>MARIFEL &amp; CO</t></r></si>
<si><t xml:space="preserve"> padded </t></si>
</sst>`;
// Row 2 skips column B (sparse), row 4 is a self-closed empty row.
const SHEET = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>61</v></c></row>
<row r="3"><c r="A3" t="str"><v>formula text</v></c><c r="B3"><v>0.127</v></c><c r="C3" t="s"><v>3</v></c></row>
<row r="4"/>
</sheetData></worksheet>`;

test("reads a DEFLATE workbook with shared strings, rich text and sparse cells", () => {
  const bytes = deflateZip([
    { name: "xl/workbook.xml", text: WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", text: RELS },
    { name: "xl/sharedStrings.xml", text: SHARED },
    { name: "xl/worksheets/sheet1.xml", text: SHEET },
  ]);
  const sheet = readXlsxSheet(bytes);
  assert.equal(sheet.name, "Undertime Summary");
  assert.deepEqual(sheet.rows, [
    { rowNumber: 1, cells: ["Name", "Tot. Minutes"] },
    { rowNumber: 2, cells: ["NIÑAL, MARIFEL & CO", null, 61] },
    { rowNumber: 3, cells: ["formula text", 0.127, " padded "] },
    { rowNumber: 4, cells: [] },
  ]);
});

test("round-trips a STORED workbook written by src/lib/xlsx.ts", () => {
  const bytes = buildXlsx({
    sheetName: "Export",
    columns: [
      { header: "Name", value: (r: { name: string; mins: number | null }) => r.name },
      { header: "Minutes", value: (r) => r.mins },
    ],
    rows: [
      { name: "BELI-OT, LEYGIE S.", mins: 61 },
      { name: "O'NEIL <test>", mins: null },
    ],
  });
  const sheet = readXlsxSheet(bytes);
  assert.equal(sheet.name, "Export");
  assert.deepEqual(sheet.rows.map((r) => r.cells), [
    ["Name", "Minutes"],
    ["BELI-OT, LEYGIE S.", 61],
    // The writer still emits a (styled, empty) cell for null; it reads as null.
    ["O'NEIL <test>", null],
  ]);
});

test("unzip returns every entry by path", () => {
  const files = unzip(deflateZip([{ name: "a.txt", text: "hello" }, { name: "b/c.txt", text: "world" }]));
  assert.deepEqual([...files.keys()], ["a.txt", "b/c.txt"]);
  assert.equal(new TextDecoder().decode(files.get("b/c.txt")), "world");
});

test("rejects bytes that are not a zip", () => {
  assert.throws(() => readXlsxSheet(enc.encode("Month,Name\nMay,X\n")), /not a valid \.xlsx/i);
});

test("rejects a workbook without the requested sheet", () => {
  const bytes = deflateZip([
    { name: "xl/workbook.xml", text: WORKBOOK },
    { name: "xl/_rels/workbook.xml.rels", text: RELS },
    { name: "xl/worksheets/sheet1.xml", text: SHEET },
  ]);
  assert.throws(() => readXlsxSheet(bytes, 1), /no sheet #2/);
});
