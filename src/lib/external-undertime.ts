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
  middle_name: string | null;
  id_number: string | null;
  employment_type: string;
  status: string;
  status_effective_date: string | null;
}

/** Letters-only, accent-free tokens; generational suffixes and stray dots dropped. */
function nameTokens(s: string | null | undefined): string[] {
  return (s ?? "")
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^A-Z]+/)
    .filter((t) => t && !SUFFIXES.has(t));
}

export interface ParsedPersonName {
  surname: string;
  /** First name(s), letters only — "MARIA FLORELYN" -> "MARIAFLORELYN". */
  first: string;
  /** The same, word by word — ["MARIA", "FLORELYN"]. */
  firstWords: string[];
  /** Middle initial, or null when the name carries none. */
  middleInitial: string | null;
}

/**
 * Splits the external file's "LAST, FIRST [SUFFIX] M." into parts. Copes with
 * the variants it actually contains: "GAZAL, JR., PAQUITO R.",
 * "COBRADO, PATERNO JR. M.", "ERQUITA JR., ERNESTO A.", "TIGLEY, MARCELO .".
 * A trailing single letter is the middle initial.
 */
export function parseExternalName(name: string): ParsedPersonName {
  const [last, ...rest] = name.split(",");
  const tokens = nameTokens(rest.join(" "));
  let middleInitial: string | null = null;
  if (tokens.length > 1 && tokens[tokens.length - 1].length === 1) {
    middleInitial = tokens.pop()!;
  }
  return { surname: surnameKey(last), first: tokens.join(""), firstWords: tokens, middleInitial };
}

function hrisName(e: Pick<EmployeeForMatch, "last_name" | "first_name" | "middle_name">): ParsedPersonName {
  const words = nameTokens(e.first_name);
  return {
    surname: surnameKey(e.last_name),
    first: words.join(""),
    firstWords: words,
    middleInitial: nameTokens(e.middle_name)[0]?.charAt(0) ?? null,
  };
}

/**
 * How well two first names agree, word by word:
 *   "exact"  — same letters ("MARIA FLORELYN" = "MARIA FLORELYN")
 *   "prefix" — each word of the shorter name starts the matching word of the
 *              longer, and the first word has at least 2 letters: "MA.
 *              VICTORIA" = "MARIA VICTORIA", "LEYGIE" = "LEYGIE ANN"
 *   null     — anything else
 */
function firstNameAgreement(a: string[], b: string[]): "exact" | "prefix" | null {
  if (a.length === 0 || b.length === 0) return null;
  if (a.join("") === b.join("")) return "exact";
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short[0].length < 2) return null;
  const fits = short.every((w, i) => long[i].startsWith(w) || w.startsWith(long[i]));
  return fits ? "prefix" : null;
}

export interface EmployeeIndex {
  byNum: Map<number, EmployeeForMatch[]>;
  bySurname: Map<string, EmployeeForMatch[]>;
}

/** Index HRIS employees by the numeric tail of id_number and by surname. */
export function indexEmployees(emps: EmployeeForMatch[]): EmployeeIndex {
  const byNum = new Map<number, EmployeeForMatch[]>();
  const bySurname = new Map<string, EmployeeForMatch[]>();
  for (const e of emps) {
    const n = idNumberTail(e.id_number);
    if (n !== null) byNum.set(n, [...(byNum.get(n) ?? []), e]);
    const s = surnameKey(e.last_name);
    if (s) bySurname.set(s, [...(bySurname.get(s) ?? []), e]);
  }
  return { byNum, bySurname };
}

/**
 * How a row was matched:
 *   id         — ID number and surname agree (the normal case)
 *   id_first   — ID number, first name and (if both have one) middle initial
 *                agree but the surname differs: a surname change, e.g. by
 *                marriage
 *   name       — the ID is wrong or missing; surname + first name (+ middle
 *                initial) single out exactly one employee
 */
export type MatchMethod = "id" | "id_first" | "name";

export type MatchResult =
  | { kind: "matched"; employee: EmployeeForMatch; method: MatchMethod }
  | { kind: "ambiguous"; candidates: EmployeeForMatch[] }
  | { kind: "surname_mismatch"; candidates: EmployeeForMatch[] }
  | { kind: "no_id" };

const initialsAgree = (a: string | null, b: string | null) => !a || !b || a === b;

/**
 * Matches an external row to one HRIS employee. The ID number is tried first;
 * the external system's IDs are often stale (HRIS re-numbered people), so the
 * full name is the fallback. A name match must be unique — two employees who
 * fit equally well are reported as ambiguous, never guessed between, since
 * the result is charged to someone's VL.
 */
export function matchEmployee(
  row: Pick<ExternalUndertimeRow, "idNumber" | "name">,
  index: EmployeeIndex,
): MatchResult {
  const ext = parseExternalName(row.name);
  const idHolders = index.byNum.get(row.idNumber) ?? [];

  const byId = idHolders.find((c) => surnameKey(c.last_name) === ext.surname);
  if (byId) return { kind: "matched", employee: byId, method: "id" };

  const renamed = idHolders.filter((c) => {
    const h = hrisName(c);
    return h.first === ext.first && h.first.length >= 2;
  });
  if (renamed.length === 1) return { kind: "matched", employee: renamed[0], method: "id_first" };

  const sameSurname = (index.bySurname.get(ext.surname) ?? []).filter((c) =>
    initialsAgree(ext.middleInitial, hrisName(c).middleInitial),
  );
  const agreement = (c: EmployeeForMatch) => firstNameAgreement(ext.firstWords, hrisName(c).firstWords);
  const exact = sameSurname.filter((c) => agreement(c) === "exact");
  const pool = exact.length > 0 ? exact : sameSurname.filter((c) => agreement(c) === "prefix");
  if (pool.length === 1) return { kind: "matched", employee: pool[0], method: "name" };
  if (pool.length > 1) return { kind: "ambiguous", candidates: pool };

  return idHolders.length > 0
    ? { kind: "surname_mismatch", candidates: idHolders }
    : { kind: "no_id" };
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
