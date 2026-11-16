// Stack test for migration 105: external DTR undertime feeds the VL deduction.
//
// The contract HR relies on is that an external figure is never a fixed
// deduction. Every edit — new minutes, hold, exclude, delete — is followed by
// hris.apply_attendance_vl_deduction, and the ledger must end up at exactly
// what the month requires, with the history kept as delta rows. This runs that
// sequence against real Postgres, plus the two precedence rules:
//   * HRIS biometric logs for the month beat the external figure;
//   * separated employees are charged only for months up to their separation.
//
// Requires Node >= 22 and a running stack:
//   colima start && npm run db:start && npm run db:reset && npm run test:db

import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const PROJECT_DIR = fileURLToPath(new URL("../..", import.meta.url));
const status = JSON.parse(
  execSync("npx supabase status -o json", { cwd: PROJECT_DIR, encoding: "utf8" }),
);
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  db: { schema: "hris" },
  auth: { autoRefreshToken: false, persistSession: false },
});

// Seeded by supabase/seed.sql, both active plantilla on the default schedule.
const EMP = "00000000-0000-0000-0000-0000000000e2";
const SEP = "00000000-0000-0000-0000-0000000000e3";
// A year nothing else in the suite touches.
const YEAR = 2031;

let VL = "";

async function cleanup() {
  for (const id of [EMP, SEP]) {
    await admin.from("external_undertime").delete().eq("employee_id", id).eq("year", YEAR);
    await admin.from("leave_credit_accruals").delete().eq("employee_id", id).eq("year", YEAR);
    await admin.from("leave_credits").delete().eq("employee_id", id).eq("year", YEAR);
    await admin.from("attendance_logs").delete().eq("employee_id", id)
      .gte("date", `${YEAR}-01-01`).lte("date", `${YEAR}-12-31`);
  }
  await admin.from("employees")
    .update({ status: "active", status_effective_date: null, status_remarks: null })
    .eq("id", SEP);
}

async function recompute(employeeId: string | null, month: number) {
  const { error } = await admin.rpc("apply_attendance_vl_deduction", {
    p_year: YEAR, p_month: month, p_employee_id: employeeId,
  });
  assert.equal(error, null);
}

async function ledger(employeeId: string, month: number) {
  const { data, error } = await admin
    .from("leave_credit_accruals")
    .select("amount, notes")
    .eq("employee_id", employeeId)
    .eq("leave_type_id", VL)
    .eq("year", YEAR)
    .eq("month", month)
    .eq("source", "attendance_deduction")
    .order("created_at");
  assert.equal(error, null);
  const rows = (data ?? []).map((r) => ({ amount: Number(r.amount), notes: r.notes as string }));
  return { rows, total: Number(rows.reduce((s, r) => s + r.amount, 0).toFixed(3)) };
}

/**
 * The balance every screen shows is leave_credits.total_credits, not the
 * ledger. Before 105 posting never updated it, so assert they agree.
 */
async function assertBalanceSynced(employeeId: string) {
  const { data: lc } = await admin.from("leave_credits").select("total_credits")
    .eq("employee_id", employeeId).eq("leave_type_id", VL).eq("year", YEAR).maybeSingle();
  const { data: rows } = await admin.from("leave_credit_accruals").select("amount")
    .eq("employee_id", employeeId).eq("leave_type_id", VL).eq("year", YEAR);
  const sum = Number((rows ?? []).reduce((s, r) => s + Number(r.amount), 0).toFixed(3));
  assert.equal(Number(lc?.total_credits ?? 0), sum, "leave_credits.total_credits = SUM(ledger)");
}

async function setExternal(employeeId: string, month: number, minutes: number, st = "apply") {
  const { error } = await admin.from("external_undertime").upsert(
    { employee_id: employeeId, year: YEAR, month, minutes, status: st, ext_id: "TEST" },
    { onConflict: "employee_id,year,month" },
  );
  assert.equal(error, null);
}

test.before(async () => {
  const { data } = await admin.from("leave_types").select("id").eq("code", "VL").single();
  VL = data!.id;
  await cleanup();
});
test.after(cleanup);

test("an applied external row is charged, and every later edit self-corrects", async () => {
  const M = 1;
  await setExternal(EMP, M, 61);
  await recompute(EMP, M);
  let l = await ledger(EMP, M);
  assert.equal(l.total, -0.127, "61 min = 0.127 VL days");
  assert.match(l.rows[0].notes, /External DTR undertime deduction/);

  // Re-running without changes posts nothing new.
  await recompute(EMP, M);
  assert.equal((await ledger(EMP, M)).rows.length, 1);

  // HR corrects the minutes: one delta row, total follows.
  await setExternal(EMP, M, 120);
  await recompute(EMP, M);
  l = await ledger(EMP, M);
  assert.equal(l.total, -0.25);
  assert.equal(l.rows.length, 2);
  await assertBalanceSynced(EMP);

  // On hold charges nothing: the deduction is given back.
  await admin.from("external_undertime").update({ status: "hold" })
    .eq("employee_id", EMP).eq("year", YEAR).eq("month", M);
  await recompute(EMP, M);
  assert.equal((await ledger(EMP, M)).total, 0);

  // Excluded, same.
  await admin.from("external_undertime").update({ status: "excluded" })
    .eq("employee_id", EMP).eq("year", YEAR).eq("month", M);
  await recompute(EMP, M);
  assert.equal((await ledger(EMP, M)).total, 0);
});

test("deleting the external row reverses what it deducted", async () => {
  const M = 2;
  await setExternal(EMP, M, 240);
  await recompute(EMP, M);
  assert.equal((await ledger(EMP, M)).total, -0.5);

  await admin.from("external_undertime").delete().eq("employee_id", EMP).eq("year", YEAR).eq("month", M);
  // The month is still a candidate because it has posted rows.
  await recompute(EMP, M);
  assert.equal((await ledger(EMP, M)).total, 0);
  await assertBalanceSynced(EMP);
});

test("HRIS biometric logs for the month win over the external figure", async () => {
  const M = 3;
  await setExternal(EMP, M, 10560); // "22 days" from the external file
  // One HRIS day, 30 minutes late, otherwise complete (Monday 2031-03-03).
  const { error } = await admin.from("attendance_logs").upsert({
    employee_id: EMP,
    date: "2031-03-03",
    time_in_am: "2031-03-03T08:30:00",
    time_out_am: "2031-03-03T12:00:00",
    time_in_pm: "2031-03-03T13:00:00",
    time_out_pm: "2031-03-03T17:00:00",
    is_absent: false,
    source: "biometric",
  }, { onConflict: "employee_id,date" });
  assert.equal(error, null);

  await recompute(EMP, M);
  const l = await ledger(EMP, M);
  assert.equal(l.total, -0.063, "30 min from the HRIS DTR, not 22 days");
  assert.match(l.rows[0].notes, /Tardy\/undertime auto-deduction/);

  const { data: pairs } = await admin.rpc("employee_months_with_logs", {
    p_from: "2031-03-01", p_to: "2031-03-31",
  });
  assert.ok((pairs ?? []).some((p: { employee_id: string; month: number }) => p.employee_id === EMP && p.month === 3));
});

test("the preview reports the source and the delta", async () => {
  const M = 4;
  await setExternal(EMP, M, 96);
  const { data, error } = await admin.rpc("preview_attendance_vl_deduction", {
    p_year: YEAR, p_month: M, p_employee_id: EMP,
  });
  assert.equal(error, null);
  assert.equal(data.length, 1);
  assert.equal(data[0].source, "external");
  assert.equal(data[0].total_minutes, 96);
  assert.equal(Number(data[0].required_days), -0.2);
  assert.equal(Number(data[0].delta_days), -0.2);
});

test("a separated employee is charged only up to the separation date", async () => {
  await admin.from("employees")
    .update({ status: "retired", status_effective_date: `${YEAR}-06-15`, status_remarks: "test" })
    .eq("id", SEP);
  for (const m of [5, 6, 7]) await setExternal(SEP, m, 48);
  for (const m of [5, 6, 7]) await recompute(null, m); // the batch path, all employees

  assert.equal((await ledger(SEP, 5)).total, -0.1, "May: before separation, charged");
  assert.equal((await ledger(SEP, 6)).total, -0.1, "June: month of separation, still a candidate");
  assert.equal((await ledger(SEP, 7)).total, 0, "July: after separation, never charged");
  await assertBalanceSynced(SEP);
});
