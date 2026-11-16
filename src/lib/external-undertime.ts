/**
 * External DTR undertime — pure parsing and classification.
 *
 * Some offices clock in on another biometric system, which hands HR a monthly
 * "Undertime Summary": one row per employee per month with the month's total
 * tardy + undertime minutes and no dates. These helpers turn that sheet into
 * rows and decide, for each, whether it is charged to VL, held for review, or
 * skipped. The database side (migration 105) then charges only 'apply' rows,
 * and only for months where HRIS has no biometric logs of its own.
 *
 * Pure (no I/O) so it runs under `node --test`.
 */

export type ExternalCell = string | number | null;

export interface ExternalUndertimeRow {
  /** 1-based row number in the uploaded sheet, for error messages. */
  sheetRow: number;
  year: number;
  month: number;
  /** As written in the file, e.g. "CAGO-716". */
  extId: string;
  /** The numeric part of extId — what HRIS id_number ends with (zero-padded). */
  idNumber: number;
  name: string;
  surname: string;
  office: string | null;
  minutes: number;
}

export interface ParseResult {
  rows: ExternalUndertimeRow[];
  errors: string[];
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

/** "Tot. Minutes" -> "totminutes", "I.D." -> "id". */
const headerKey = (s: ExternalCell) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADER_ALIASES: Record<string, string[]> = {
  month: ["month"],
  period: ["dateperiod", "period"],
  office: ["office", "department"],
  name: ["name", "employeename"],
  id: ["id", "idno", "idnumber", "employeeid"],
  minutes: ["totminutes", "totalminutes", "minutes"],
};

function monthFromText(s: string): number | null {
  const t = s.trim().toLowerCase();
  const i = MONTHS.findIndex((m) => t.startsWith(m.slice(0, 3)));
  return i >= 0 ? i + 1 : null;
}

/**
 * Parses the external summary. The header row is found by its labels, so a
 * title row above it or reordered columns are fine. The year comes from the
 * "Date Period" text ("May 01-31, 2026"), falling back to `defaultYear`.
 */
export function parseExternalUndertime(
  rows: { rowNumber: number; cells: ExternalCell[] }[],
  defaultYear: number,
): ParseResult {
  const errors: string[] = [];
  const headerIdx = rows.findIndex((r) => {
    const keys = r.cells.map(headerKey);
    return HEADER_ALIASES.id.some((a) => keys.includes(a)) &&
      HEADER_ALIASES.minutes.some((a) => keys.includes(a));
  });
  if (headerIdx < 0) {
    return { rows: [], errors: ['No header row found. Expected columns "I.D." and "Tot. Minutes".'] };
  }
  const keys = rows[headerIdx].cells.map(headerKey);
  const col = (field: string) => keys.findIndex((k) => HEADER_ALIASES[field].includes(k));
  const c = {
    month: col("month"), period: col("period"), office: col("office"),
    name: col("name"), id: col("id"), minutes: col("minutes"),
  };
  if (c.name < 0) return { rows: [], errors: ['No "Name" column found.'] };
  if (c.month < 0 && c.period < 0) {
    return { rows: [], errors: ['No "Month" or "Date Period" column found.'] };
  }

  const out: ExternalUndertimeRow[] = [];
  for (const { rowNumber, cells } of rows.slice(headerIdx + 1)) {
    const get = (i: number) => (i >= 0 ? cells[i] ?? null : null);
    const extId = String(get(c.id) ?? "").trim();
    const name = String(get(c.name) ?? "").trim();
    if (!extId && !name) continue; // blank line

    const period = String(get(c.period) ?? "");
    const month =
      monthFromText(String(get(c.month) ?? "")) ?? monthFromText(period);
    const year = Number(period.match(/\b(20\d{2})\b/)?.[1] ?? defaultYear);
    const idNumber = Number(extId.match(/(\d+)\s*$/)?.[1] ?? NaN);
    const rawMinutes = get(c.minutes);
    const minutes = typeof rawMinutes === "number" ? rawMinutes : Number(String(rawMinutes ?? "").trim());

    if (!month) { errors.push(`Row ${rowNumber}: unreadable month.`); continue; }
    if (!Number.isFinite(idNumber)) { errors.push(`Row ${rowNumber}: unreadable I.D. "${extId}".`); continue; }
    if (!Number.isFinite(minutes) || minutes < 0) {
      errors.push(`Row ${rowNumber}: unreadable minutes "${rawMinutes ?? ""}".`);
      continue;
    }
    out.push({
      sheetRow: rowNumber,
      year,
      month,
      extId,
      idNumber,
      name,
      surname: name.split(",")[0].trim(),
      office: c.office >= 0 ? String(get(c.office) ?? "").trim() || null : null,
      minutes: Math.round(minutes),
    });
  }
  return { rows: out, errors };
}

const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "V"]);

/** Surname key for matching: letters only, generational suffixes dropped. */
export function surnameKey(s: string | null | undefined): string {
  return (s ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Z]+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join("");
}

/** The numeric tail of an HRIS id_number ("CEO-0840" -> 840), or null. */
export function idNumberTail(idNumber: string | null | undefined): number | null {
  const m = (idNumber ?? "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export interface EmployeeForMatch {
  id: string;
  last_name: string;
  first_name: string;
  id_number: string | null;
  employment_type: string;
  status: string;
  status_effective_date: string | null;
}

/** Index HRIS employees by the numeric tail of id_number. */
export function indexEmployees(emps: EmployeeForMatch[]): Map<number, EmployeeForMatch[]> {
  const byNum = new Map<number, EmployeeForMatch[]>();
  for (const e of emps) {
    const n = idNumberTail(e.id_number);
    if (n === null) continue;
    byNum.set(n, [...(byNum.get(n) ?? []), e]);
  }
  return byNum;
}

export type MatchResult =
  | { kind: "matched"; employee: EmployeeForMatch }
  | { kind: "surname_mismatch"; candidates: EmployeeForMatch[] }
  | { kind: "no_id" };

/** An external row matches when the ID number AND the surname agree. */
export function matchEmployee(
  row: Pick<ExternalUndertimeRow, "idNumber" | "surname">,
  byNum: Map<number, EmployeeForMatch[]>,
): MatchResult {
  const cands = byNum.get(row.idNumber) ?? [];
  if (cands.length === 0) return { kind: "no_id" };
  const key = surnameKey(row.surname);
  const hit = cands.find((c) => surnameKey(c.last_name) === key);
  return hit ? { kind: "matched", employee: hit } : { kind: "surname_mismatch", candidates: cands };
}

export type ExternalCategory =
  | "apply"
  | "hold"
  | "skip_unmatched"
  | "skip_not_plantilla"
  | "skip_hris_has_logs"
  | "skip_after_separation";

export type HoldReason =
  | "one_day_or_more"
  | "overlaps_leave"
  | "separation_month"
  | "duplicate_in_file";

export const HOLD_REASON_LABELS: Record<HoldReason, string> = {
  one_day_or_more: "1 day or more (likely absences)",
  overlaps_leave: "Overlaps approved leave",
  separation_month: "Month of separation",
  duplicate_in_file: "Listed more than once in the file",
};

export const CATEGORY_LABELS: Record<ExternalCategory, string> = {
  apply: "Charge to VL",
  hold: "Hold for review",
  skip_unmatched: "Not matched to an employee",
  skip_not_plantilla: "Not plantilla (no leave credits)",
  skip_hris_has_logs: "HRIS has biometrics (HRIS wins)",
  skip_after_separation: "After separation",
};

/** Minutes at or above this are held: one full working day. */
export const HOLD_THRESHOLD_MINUTES = 480;

export interface ClassifyInput {
  minutes: number;
  year: number;
  month: number;
  employee: Pick<EmployeeForMatch, "employment_type" | "status" | "status_effective_date"> | null;
  /** HRIS has at least one attendance_logs row for the employee that month. */
  hrisHasLogs: boolean;
  /** An approved leave application overlaps the month. */
  overlapsApprovedLeave: boolean;
  /** The same employee-month appears more than once in the file. */
  duplicateInFile: boolean;
}

export interface Classification {
  category: ExternalCategory;
  holdReasons: HoldReason[];
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Decides what an external row does. Skips come first (nothing is stored),
 * then hold reasons (stored, charges nothing until HR applies it), else apply.
 *
 * Separated employees: months that start after the separation date are
 * skipped; the month containing it is held (the external total counts the
 * days after separation as absences); earlier months are treated as active.
 * A separated employee with no effective date can't be placed, so is skipped.
 */
export function classifyExternalRow(input: ClassifyInput): Classification {
  const { employee } = input;
  if (!employee) return { category: "skip_unmatched", holdReasons: [] };
  if (employee.employment_type !== "plantilla") return { category: "skip_not_plantilla", holdReasons: [] };
  if (input.hrisHasLogs) return { category: "skip_hris_has_logs", holdReasons: [] };

  const monthStart = iso(input.year, input.month, 1);
  const monthEnd = iso(input.year, input.month, lastDay(input.year, input.month));
  const holdReasons: HoldReason[] = [];

  if (employee.status !== "active") {
    const eff = employee.status_effective_date;
    if (!eff || monthStart > eff) return { category: "skip_after_separation", holdReasons: [] };
    if (eff < monthEnd) holdReasons.push("separation_month");
  }
  if (input.minutes >= HOLD_THRESHOLD_MINUTES) holdReasons.push("one_day_or_more");
  if (input.overlapsApprovedLeave) holdReasons.push("overlaps_leave");
  if (input.duplicateInFile) holdReasons.push("duplicate_in_file");

  return holdReasons.length > 0
    ? { category: "hold", holdReasons }
    : { category: "apply", holdReasons: [] };
}

/** Minutes to VL days, the way the SQL deduction rounds it. */
export const minutesToDays = (minutes: number) => Math.round((minutes / 480) * 1000) / 1000;
