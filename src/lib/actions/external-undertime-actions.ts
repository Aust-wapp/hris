"use server";

// External DTR undertime: import the other biometric system's monthly summary,
// review it, and let the VL auto-deduction (migration 105) charge it.
//
// The ledger is never written here directly. Rows go into
// hris.external_undertime; the month is then recomputed by
// hris.apply_attendance_vl_deduction, which posts only the difference from what
// is already deducted. So any later edit, hold, exclusion or deletion corrects
// the VL balance by itself, and every change stays in the ledger history.

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser } from "@/lib/actions/auth-actions";
import { hasAnyRole } from "@/lib/auth-helpers";
import { logAudit } from "@/lib/audit";
import { readXlsxSheet } from "@/lib/xlsx-read";
import { parseCsvTextToRows } from "@/lib/parse-csv";
import {
  classifyExternalRow,
  indexEmployees,
  matchEmployee,
  minutesToDays,
  parseExternalUndertime,
  type EmployeeForMatch,
  type ExternalCategory,
  type ExternalUndertimeRow,
  type HoldReason,
  type MatchMethod,
} from "@/lib/external-undertime";

type Admin = ReturnType<typeof createAdminClient>;

async function requireHr() {
  const user = await getCurrentUser();
  if (!user || !hasAnyRole(user.roles, "super_admin", "hr_admin")) return null;
  return user;
}

/** Pages through a PostgREST query past the 1000-row cap. */
async function fetchAll<T>(
  build: () => { range: (a: number, b: number) => PromiseLike<{ data: unknown; error: { message: string } | null }> },
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

const key = (employeeId: string, year: number, month: number) => `${employeeId}|${year}|${month}`;
const monthStart = (y: number, m: number) => `${y}-${String(m).padStart(2, "0")}-01`;
const monthEnd = (y: number, m: number) =>
  `${y}-${String(m).padStart(2, "0")}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;

/* -------------------------------------------------------------------------- */
/* Planning (shared by preview and import)                                    */
/* -------------------------------------------------------------------------- */

export interface ExternalPlanRow {
  sheetRows: number[];
  year: number;
  month: number;
  extId: string;
  extName: string;
  office: string | null;
  minutes: number;
  days: number;
  category: ExternalCategory;
  holdReasons: HoldReason[];
  employeeId: string | null;
  hrisName: string | null;
  hrisIdNumber: string | null;
  employeeStatus: string | null;
  /** How the employee was found; null when unmatched. See MatchMethod. */
  matchMethod: MatchMethod | null;
  /** Unmatched: who holds the file's ID number, or the same-name candidates. */
  idHolders: string | null;
  /** A previous import's row whose status HR set by hand — kept on re-import. */
  lockedStatus: "apply" | "hold" | "excluded" | null;
}

export interface ExternalPlan {
  fileName: string;
  sheetName: string;
  parseErrors: string[];
  rows: ExternalPlanRow[];
  summary: Record<ExternalCategory, { rows: number; minutes: number; days: number }>;
}

function readRows(fileName: string, bytes: Uint8Array) {
  if (fileName.toLowerCase().endsWith(".csv")) {
    const text = new TextDecoder().decode(bytes).replace(/^﻿/, "");
    return {
      sheetName: fileName,
      rows: parseCsvTextToRows(text).map((cells, i) => ({ rowNumber: i + 1, cells })),
    };
  }
  const sheet = readXlsxSheet(bytes);
  return { sheetName: sheet.name, rows: sheet.rows };
}

async function buildPlan(supabase: Admin, file: File): Promise<ExternalPlan> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { sheetName, rows: sheetRows } = readRows(file.name, bytes);
  const parsed = parseExternalUndertime(sheetRows, new Date().getFullYear());

  const summary = Object.fromEntries(
    (["apply", "hold", "skip_unmatched", "skip_not_plantilla", "skip_hris_has_logs", "skip_after_separation"] as const)
      .map((c) => [c, { rows: 0, minutes: 0, days: 0 }]),
  ) as ExternalPlan["summary"];
  if (parsed.rows.length === 0) {
    return { fileName: file.name, sheetName, parseErrors: parsed.errors, rows: [], summary };
  }

  const employees = await fetchAll<EmployeeForMatch>(() =>
    supabase.schema("hris").from("employees")
      // Every employee, with or without an id_number: the name fallback can
      // find people the external file lists under a stale ID.
      .select("id, last_name, first_name, middle_name, id_number, employment_type, status, status_effective_date")
      .order("id"),
  );
  const index = indexEmployees(employees);

  const periods = parsed.rows.map((r) => r.year * 100 + r.month);
  const first = Math.min(...periods);
  const last = Math.max(...periods);
  const from = monthStart(Math.floor(first / 100), first % 100);
  const to = monthEnd(Math.floor(last / 100), last % 100);

  const withLogs = new Set(
    (await fetchAll<{ employee_id: string; year: number; month: number }>(() =>
      supabase.schema("hris").rpc("employee_months_with_logs", { p_from: from, p_to: to })
        .order("employee_id").order("year").order("month"),
    )).map((r) => key(r.employee_id, r.year, r.month)),
  );

  const leaves = await fetchAll<{ employee_id: string; start_date: string; end_date: string }>(() =>
    supabase.schema("hris").from("leave_applications")
      .select("employee_id, start_date, end_date")
      .eq("status", "approved")
      .lte("start_date", to)
      .gte("end_date", from)
      .order("id"),
  );
  const leaveByEmp = new Map<string, { start_date: string; end_date: string }[]>();
  for (const l of leaves) leaveByEmp.set(l.employee_id, [...(leaveByEmp.get(l.employee_id) ?? []), l]);

  const years = [...new Set(parsed.rows.map((r) => r.year))];
  const existing = await fetchAll<{ employee_id: string; year: number; month: number; status: string; status_locked: boolean }>(() =>
    supabase.schema("hris").from("external_undertime")
      .select("employee_id, year, month, status, status_locked")
      .in("year", years)
      .order("id"),
  );
  const lockedByKey = new Map(
    existing.filter((e) => e.status_locked).map((e) => [key(e.employee_id, e.year, e.month), e.status as ExternalPlanRow["lockedStatus"]]),
  );

  // Collapse rows to one per (employee, month). Unmatched rows keep their own
  // entry, keyed by the external ID.
  const groups = new Map<string, {
    rows: ExternalUndertimeRow[];
    employee: EmployeeForMatch | null;
    matchMethod: MatchMethod | null;
    idHolders: string | null;
  }>();
  const describe = (cs: EmployeeForMatch[]) =>
    cs.map((c) => `${c.last_name}, ${c.first_name} (${c.id_number ?? "no ID"})`).join(" / ");
  for (const r of parsed.rows) {
    const m = matchEmployee(r, index);
    const employee = m.kind === "matched" ? m.employee : null;
    const idHolders =
      m.kind === "surname_mismatch" ? `ID belongs to ${describe(m.candidates)}`
      : m.kind === "ambiguous" ? `Same name: ${describe(m.candidates)}`
      : null;
    const k = employee ? key(employee.id, r.year, r.month) : `ext|${r.extId}|${r.year}|${r.month}|${r.sheetRow}`;
    const g = groups.get(k);
    if (g) g.rows.push(r);
    else groups.set(k, { rows: [r], employee, matchMethod: m.kind === "matched" ? m.method : null, idHolders });
  }

  const rows: ExternalPlanRow[] = [];
  for (const { rows: grp, employee, matchMethod, idHolders } of groups.values()) {
    const r = grp[0];
    const minutes = grp.reduce((s, x) => s + x.minutes, 0);
    const overlapsApprovedLeave = employee
      ? (leaveByEmp.get(employee.id) ?? []).some(
          (l) => l.start_date <= monthEnd(r.year, r.month) && l.end_date >= monthStart(r.year, r.month),
        )
      : false;
    const { category, holdReasons } = classifyExternalRow({
      minutes,
      year: r.year,
      month: r.month,
      employee,
      hrisHasLogs: employee ? withLogs.has(key(employee.id, r.year, r.month)) : false,
      overlapsApprovedLeave,
      duplicateInFile: grp.length > 1,
    });
    rows.push({
      sheetRows: grp.map((x) => x.sheetRow),
      year: r.year,
      month: r.month,
      extId: r.extId,
      extName: r.name,
      office: r.office,
      minutes,
      days: minutesToDays(minutes),
      category,
      holdReasons,
      employeeId: employee?.id ?? null,
      hrisName: employee ? `${employee.last_name}, ${employee.first_name}` : null,
      hrisIdNumber: employee?.id_number ?? null,
      employeeStatus: employee?.status ?? null,
      matchMethod,
      idHolders,
      lockedStatus: employee ? lockedByKey.get(key(employee.id, r.year, r.month)) ?? null : null,
    });
    const s = summary[category];
    s.rows += 1;
    s.minutes += minutes;
  }
  for (const s of Object.values(summary)) s.days = minutesToDays(s.minutes);
  rows.sort((a, b) => a.sheetRows[0] - b.sheetRows[0]);

  return { fileName: file.name, sheetName, parseErrors: parsed.errors, rows, summary };
}

function fileFrom(formData: FormData): File | { error: string } {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file to upload." };
  const name = file.name.toLowerCase();
  if (!name.endsWith(".xlsx") && !name.endsWith(".csv")) {
    return { error: "Upload the summary as .xlsx or .csv." };
  }
  return file;
}

/* -------------------------------------------------------------------------- */
/* Preview and import                                                         */
/* -------------------------------------------------------------------------- */

export async function previewExternalUndertime(
  formData: FormData,
): Promise<{ plan: ExternalPlan } | { error: string }> {
  if (!(await requireHr())) return { error: "Unauthorized" };
  const file = fileFrom(formData);
  if ("error" in file) return file;
  try {
    return { plan: await buildPlan(createAdminClient(), file) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read the file." };
  }
}

export async function importExternalUndertime(
  formData: FormData,
): Promise<
  | { applied: number; held: number; skipped: number; months: string[]; vlDaysPosted: number }
  | { error: string }
> {
  const user = await requireHr();
  if (!user) return { error: "Unauthorized" };
  const file = fileFrom(formData);
  if ("error" in file) return file;

  const supabase = createAdminClient();
  let plan: ExternalPlan;
  try {
    plan = await buildPlan(supabase, file);
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not read the file." };
  }

  const toStore = plan.rows.filter(
    (r): r is ExternalPlanRow & { employeeId: string } =>
      (r.category === "apply" || r.category === "hold") && r.employeeId !== null,
  );
  const base = (r: ExternalPlanRow & { employeeId: string }) => ({
    employee_id: r.employeeId,
    year: r.year,
    month: r.month,
    minutes: r.minutes,
    review_reason: r.holdReasons.length ? r.holdReasons.join(",") : null,
    ext_id: r.extId,
    ext_name: r.extName,
    ext_office: r.office,
    source_file: plan.fileName,
    updated_by: user.id,
  });

  // HR's own decisions survive a re-import: rows whose status was set by hand
  // get fresh minutes but keep their status.
  const unlocked = toStore.filter((r) => !r.lockedStatus).map((r) => ({ ...base(r), status: r.category }));
  const locked = toStore.filter((r) => r.lockedStatus).map(base);

  for (const [batch, label] of [[unlocked, "rows"], [locked, "reviewed rows"]] as const) {
    for (let i = 0; i < batch.length; i += 500) {
      const { error } = await supabase.schema("hris").from("external_undertime")
        .upsert(batch.slice(i, i + 500), { onConflict: "employee_id,year,month" });
      if (error) return { error: `Saving ${label} failed: ${error.message}` };
    }
  }
  // created_by is set once, on rows this import created.
  for (let i = 0; i < unlocked.length; i += 500) {
    const ids = unlocked.slice(i, i + 500).map((r) => r.employee_id);
    await supabase.schema("hris").from("external_undertime")
      .update({ created_by: user.id })
      .is("created_by", null)
      .in("employee_id", ids)
      .eq("source_file", plan.fileName);
  }

  // Recompute every month in the file once, set-based, inside Postgres.
  const months = [...new Set(plan.rows.map((r) => `${r.year}-${String(r.month).padStart(2, "0")}`))].sort();
  let vlDaysPosted = 0;
  for (const ym of months) {
    const [y, m] = ym.split("-").map(Number);
    const { data, error } = await supabase.schema("hris").rpc("apply_attendance_vl_deduction", {
      p_year: y, p_month: m, p_employee_id: null,
    });
    if (error) return { error: `Saved, but recomputing ${ym} failed: ${error.message}` };
    const row = Array.isArray(data) ? data[0] : data;
    vlDaysPosted += Number((row as { total_days?: number } | null)?.total_days ?? 0);
  }

  const applied = toStore.filter((r) => (r.lockedStatus ?? r.category) === "apply").length;
  const held = toStore.length - applied;
  const skipped = plan.rows.length - toStore.length;
  vlDaysPosted = Number(vlDaysPosted.toFixed(3));

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: "import_external_undertime",
    tableName: "external_undertime",
    newValues: { file: plan.fileName, applied, held, skipped, months, vlDaysPosted },
  });

  revalidatePath("/admin/external-undertime");
  revalidatePath("/reports/attendance-deductions");
  revalidatePath("/reports/leave-balances");
  revalidatePath("/leaves/credits");
  return { applied, held, skipped, months, vlDaysPosted };
}

/* -------------------------------------------------------------------------- */
/* Records: list, edit, delete                                                */
/* -------------------------------------------------------------------------- */

export interface ExternalUndertimeRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  idNumber: string | null;
  department: string | null;
  employeeStatus: string;
  year: number;
  month: number;
  minutes: number;
  days: number;
  status: "apply" | "hold" | "excluded";
  statusLocked: boolean;
  reviewReason: string | null;
  extId: string | null;
  notes: string | null;
  sourceFile: string | null;
  /** HRIS has biometric logs that month, so this row is not what is charged. */
  hrisHasLogs: boolean;
  /** Net VL days the ledger currently deducts for this employee-month. */
  postedDays: number;
  updatedAt: string;
}

export async function listExternalUndertime(year: number): Promise<ExternalUndertimeRecord[]> {
  if (!(await requireHr())) throw new Error("Unauthorized");
  const supabase = createAdminClient();

  type Row = {
    id: string; employee_id: string; year: number; month: number; minutes: number;
    status: ExternalUndertimeRecord["status"]; status_locked: boolean; review_reason: string | null;
    ext_id: string | null; notes: string | null; source_file: string | null; updated_at: string;
    employees: {
      last_name: string; first_name: string; id_number: string | null; status: string;
      departments: { name: string } | null;
    } | null;
  };
  const rows = await fetchAll<Row>(() =>
    supabase.schema("hris").from("external_undertime")
      .select("id, employee_id, year, month, minutes, status, status_locked, review_reason, ext_id, notes, source_file, updated_at, employees!external_undertime_employee_id_fkey(last_name, first_name, id_number, status, departments!employees_department_id_fkey(name))")
      .eq("year", year)
      .order("id"),
  );
  if (rows.length === 0) return [];

  const withLogs = new Set(
    (await fetchAll<{ employee_id: string; year: number; month: number }>(() =>
      supabase.schema("hris").rpc("employee_months_with_logs", { p_from: `${year}-01-01`, p_to: `${year}-12-31` })
        .order("employee_id").order("year").order("month"),
    )).map((r) => key(r.employee_id, r.year, r.month)),
  );

  const posted = await fetchAll<{ employee_id: string; month: number; amount: number }>(() =>
    supabase.schema("hris").from("leave_credit_accruals")
      .select("employee_id, month, amount")
      .eq("source", "attendance_deduction")
      .eq("year", year)
      .order("id"),
  );
  const postedByKey = new Map<string, number>();
  for (const p of posted) {
    const k = key(p.employee_id, year, p.month);
    postedByKey.set(k, (postedByKey.get(k) ?? 0) + Number(p.amount));
  }

  return rows
    .map((r) => ({
      id: r.id,
      employeeId: r.employee_id,
      employeeName: r.employees ? `${r.employees.last_name}, ${r.employees.first_name}` : "—",
      idNumber: r.employees?.id_number ?? null,
      department: r.employees?.departments?.name ?? null,
      employeeStatus: r.employees?.status ?? "",
      year: r.year,
      month: r.month,
      minutes: r.minutes,
      days: minutesToDays(r.minutes),
      status: r.status,
      statusLocked: r.status_locked,
      reviewReason: r.review_reason,
      extId: r.ext_id,
      notes: r.notes,
      sourceFile: r.source_file,
      hrisHasLogs: withLogs.has(key(r.employee_id, r.year, r.month)),
      postedDays: Number((postedByKey.get(key(r.employee_id, r.year, r.month)) ?? 0).toFixed(3)),
      updatedAt: r.updated_at,
    }))
    .sort((a, b) => a.month - b.month || a.employeeName.localeCompare(b.employeeName));
}

async function recompute(supabase: Admin, employeeId: string, year: number, month: number) {
  const { error } = await supabase.schema("hris").rpc("apply_attendance_vl_deduction", {
    p_year: year, p_month: month, p_employee_id: employeeId,
  });
  return error?.message ?? null;
}

function revalidateAll() {
  revalidatePath("/admin/external-undertime");
  revalidatePath("/reports/attendance-deductions");
  revalidatePath("/reports/leave-balances");
  revalidatePath("/leaves/credits");
}

export async function updateExternalUndertime(input: {
  id: string;
  minutes?: number;
  status?: "apply" | "hold" | "excluded";
  notes?: string | null;
}): Promise<{ success: true } | { error: string }> {
  const user = await requireHr();
  if (!user) return { error: "Unauthorized" };
  if (input.minutes !== undefined && (!Number.isInteger(input.minutes) || input.minutes < 0 || input.minutes > 50000)) {
    return { error: "Minutes must be a whole number from 0 to 50,000." };
  }
  if (input.status !== undefined && !["apply", "hold", "excluded"].includes(input.status)) {
    return { error: "Invalid status." };
  }

  const supabase = createAdminClient();
  const { data: before, error: fetchErr } = await supabase.schema("hris").from("external_undertime")
    .select("employee_id, year, month, minutes, status, notes")
    .eq("id", input.id)
    .single();
  if (fetchErr || !before) return { error: "Record not found." };

  const patch: Record<string, unknown> = { updated_by: user.id };
  if (input.minutes !== undefined) patch.minutes = input.minutes;
  if (input.status !== undefined) {
    patch.status = input.status;
    patch.status_locked = true;
  }
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

  const { error } = await supabase.schema("hris").from("external_undertime").update(patch).eq("id", input.id);
  if (error) return { error: error.message };

  const recomputeErr = await recompute(supabase, before.employee_id, before.year, before.month);

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: "update_external_undertime",
    tableName: "external_undertime",
    recordId: input.id,
    oldValues: { minutes: before.minutes, status: before.status, notes: before.notes },
    newValues: patch,
  });
  revalidateAll();
  return recomputeErr ? { error: `Saved, but the VL recompute failed: ${recomputeErr}` } : { success: true };
}

export async function deleteExternalUndertime(id: string): Promise<{ success: true } | { error: string }> {
  const user = await requireHr();
  if (!user) return { error: "Unauthorized" };
  const supabase = createAdminClient();

  const { data: before, error: fetchErr } = await supabase.schema("hris").from("external_undertime")
    .select("employee_id, year, month, minutes, status, ext_id, source_file")
    .eq("id", id)
    .single();
  if (fetchErr || !before) return { error: "Record not found." };

  const { error } = await supabase.schema("hris").from("external_undertime").delete().eq("id", id);
  if (error) return { error: error.message };

  // The month still has posted rows, so it stays a candidate and the
  // recompute posts the reversing delta.
  const recomputeErr = await recompute(supabase, before.employee_id, before.year, before.month);

  await logAudit({
    userId: user.id,
    userEmail: user.email,
    action: "delete_external_undertime",
    tableName: "external_undertime",
    recordId: id,
    oldValues: before,
  });
  revalidateAll();
  return recomputeErr ? { error: `Deleted, but the VL recompute failed: ${recomputeErr}` } : { success: true };
}
