// Unit tests for `src/lib/external-undertime.ts`: parsing the external DTR's
// monthly undertime summary, matching rows to HRIS employees, and deciding
// what each row does (charge, hold, skip).
//
// The classification is what protects VL balances from the external file's
// habit of counting whole absent days — and the months after someone retired
// or died — as "undertime", so its matrix is spelled out case by case.
//
// Requires Node >= 22 for --experimental-strip-types.
// Run: npm run test:dtr

import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyExternalRow,
  idNumberTail,
  indexEmployees,
  matchEmployee,
  minutesToDays,
  parseExternalUndertime,
  surnameKey,
  type ClassifyInput,
  type EmployeeForMatch,
} from "../../src/lib/external-undertime.ts";

const HEADER = ["Month", "Date Period", "Office", "#", "Name", "I.D.", "Tardy Count", "Frequency", "Tot. Minutes", "Equiv. Leave Credits"];
const rowsOf = (cells: (string | number | null)[][]) => cells.map((c, i) => ({ rowNumber: i + 1, cells: c }));

test("parses the external summary layout", () => {
  const { rows, errors } = parseExternalUndertime(
    rowsOf([
      HEADER,
      ["May", "May 01-31, 2026", "City Agriculturist Office", 2, "BELI-OT, LEYGIE S.", "CAGO-716", "1 Hrs 1 Min", 4, 61, 0.127],
      ["September", "September 01-30, 2026", "Solid Waste", 67, "TAMULA, JOCELYN M.", "SWEMO-1068", "22 Day", 88, 10560, 22],
    ]),
    2020,
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(rows, [
    { sheetRow: 2, year: 2026, month: 5, extId: "CAGO-716", idNumber: 716, name: "BELI-OT, LEYGIE S.", surname: "BELI-OT", office: "City Agriculturist Office", minutes: 61 },
    { sheetRow: 3, year: 2026, month: 9, extId: "SWEMO-1068", idNumber: 1068, name: "TAMULA, JOCELYN M.", surname: "TAMULA", office: "Solid Waste", minutes: 10560 },
  ]);
});

test("finds the header below a title row and accepts reordered columns", () => {
  const { rows, errors } = parseExternalUndertime(
    rowsOf([
      ["LGU Undertime Summary"],
      [],
      ["Tot. Minutes", "Name", "I.D.", "Month"],
      ["15", "MEJARES, RODOLFO V.", "CEEDO-459", "June"],
    ]),
    2026,
  );
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sheetRow, 4);
  assert.equal(rows[0].month, 6);
  assert.equal(rows[0].year, 2026, "no Date Period, so the default year");
  assert.equal(rows[0].minutes, 15);
  assert.equal(rows[0].office, null);
});

test("reports unreadable rows instead of guessing, and skips blank lines", () => {
  const { rows, errors } = parseExternalUndertime(
    rowsOf([
      HEADER,
      ["Maypole", "", "", 1, "A, B", "X-1", "", 1, 5, 0],
      ["May", "May 01-31, 2026", "", 1, "A, B", "NOID", "", 1, 5, 0],
      ["May", "May 01-31, 2026", "", 1, "A, B", "X-2", "", 1, "lots", 0],
      [null, null, null, null, null, null, null, null, null, null],
    ]),
    2026,
  );
  assert.equal(rows.length, 1, "'Maypole' still reads as May");
  assert.deepEqual(errors, [
    'Row 3: unreadable I.D. "NOID".',
    'Row 4: unreadable minutes "lots".',
  ]);
});

test("fails clearly when the header is missing", () => {
  const { rows, errors } = parseExternalUndertime(rowsOf([["foo", "bar"], ["1", "2"]]), 2026);
  assert.equal(rows.length, 0);
  assert.match(errors[0], /No header row/);
});

test("surnameKey ignores punctuation, accents and generational suffixes", () => {
  assert.equal(surnameKey("ERQUITA JR."), surnameKey("ERQUITA"));
  assert.equal(surnameKey("Gazal, Jr."), "GAZAL");
  assert.equal(surnameKey("NIÑAL"), "NINAL");
  assert.equal(surnameKey("DE LEON"), surnameKey("De-Leon"));
  assert.equal(surnameKey("BELI-OT"), "BELIOT");
  assert.notEqual(surnameKey("JUNIOR"), "", "JR inside a word is kept");
});

test("idNumberTail reads the zero-padded HRIS id_number", () => {
  assert.equal(idNumberTail("CEO-0840"), 840);
  assert.equal(idNumberTail("CTRSMO-0002"), 2);
  assert.equal(idNumberTail(null), null);
  assert.equal(idNumberTail("NONE"), null);
});

const emp = (o: Partial<EmployeeForMatch>): EmployeeForMatch => ({
  id: "e1", last_name: "UY", first_name: "ROLLY", id_number: "CEO-0840",
  employment_type: "plantilla", status: "active", status_effective_date: null, ...o,
});

test("matches on ID number AND surname, even when the office prefix differs", () => {
  const byNum = indexEmployees([
    emp({ id: "balcita", last_name: "BALCITA", id_number: "CADMO-0047" }),
    emp({ id: "caay", last_name: "CAAY", id_number: "CTRSMO-0132" }),
  ]);
  const hit = matchEmployee({ idNumber: 47, surname: "BALCITA" }, byNum);
  assert.equal(hit.kind, "matched");
  assert.equal(hit.kind === "matched" && hit.employee.id, "balcita");

  const wrong = matchEmployee({ idNumber: 132, surname: "FRASER" }, byNum);
  assert.equal(wrong.kind, "surname_mismatch");

  assert.equal(matchEmployee({ idNumber: 9999, surname: "X" }, byNum).kind, "no_id");
});

const base: ClassifyInput = {
  minutes: 61,
  year: 2026,
  month: 7,
  employee: { employment_type: "plantilla", status: "active", status_effective_date: null },
  hrisHasLogs: false,
  overlapsApprovedLeave: false,
  duplicateInFile: false,
};
const classify = (o: Partial<ClassifyInput>) => classifyExternalRow({ ...base, ...o });
const sep = (status: string, date: string | null) => ({
  employment_type: "plantilla", status, status_effective_date: date,
});

test("an ordinary active plantilla month is charged", () => {
  assert.deepEqual(classify({}), { category: "apply", holdReasons: [] });
});

test("skips: unmatched, not plantilla, HRIS has biometrics", () => {
  assert.equal(classify({ employee: null }).category, "skip_unmatched");
  assert.equal(classify({ employee: { ...base.employee!, employment_type: "jo" } }).category, "skip_not_plantilla");
  assert.equal(
    classify({ hrisHasLogs: true, minutes: 10560 }).category,
    "skip_hris_has_logs",
    "HRIS wins even over a huge external total",
  );
});

test("holds a day or more, approved leave overlaps and duplicates", () => {
  assert.deepEqual(classify({ minutes: 479 }).category, "apply");
  assert.deepEqual(classify({ minutes: 480 }), { category: "hold", holdReasons: ["one_day_or_more"] });
  assert.deepEqual(classify({ overlapsApprovedLeave: true }), { category: "hold", holdReasons: ["overlaps_leave"] });
  assert.deepEqual(
    classify({ minutes: 10560, overlapsApprovedLeave: true, duplicateInFile: true }).holdReasons,
    ["one_day_or_more", "overlaps_leave", "duplicate_in_file"],
  );
});

test("separated employees: earlier months charge, the separation month holds, later months skip", () => {
  // Retired 2026-07-31 (the month's last day): all of July was worked.
  assert.equal(classify({ employee: sep("retired", "2026-07-31") }).category, "apply");
  // Retired 2026-08-01: July is entirely before it.
  assert.equal(classify({ employee: sep("retired", "2026-08-01") }).category, "apply");
  // Died 2026-07-15: July is the separation month.
  assert.deepEqual(classify({ employee: sep("deceased", "2026-07-15") }), {
    category: "hold", holdReasons: ["separation_month"],
  });
  // Separated 2026-07-01: the month starts on the date, still part-worked.
  assert.equal(classify({ employee: sep("resigned", "2026-07-01") }).category, "hold");
  // Retired 2026-06-01: July is after.
  assert.equal(classify({ employee: sep("retired", "2026-06-01") }).category, "skip_after_separation");
  // Inactive with no date can't be placed.
  assert.equal(classify({ employee: sep("inactive", null) }).category, "skip_after_separation");
});

test("minutesToDays rounds the way the SQL deduction does", () => {
  assert.equal(minutesToDays(61), 0.127);
  assert.equal(minutesToDays(1), 0.002);
  assert.equal(minutesToDays(10560), 22);
});
