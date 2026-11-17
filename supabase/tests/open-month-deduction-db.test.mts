// Stack test for migration 108: tardy/undertime is charged to VL only once the
// month is over (Asia/Manila calendar).
//
//   * the current month posts nothing, whatever its minutes;
//   * postings already made for it are reversed (history kept) and the VL
//     balance follows;
//   * the previous, closed month is charged — including by the daily cron.
//
// Uses its own employee because the dates are relative to today and other
// suites write 2026 attendance for the seeded ones.
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

const EMP = "00000000-0000-0000-0000-0000000108e1";
const DEPT = "00000000-0000-0000-0000-0000000000d1";

// Current and previous month on the Manila calendar (UTC+8, no DST).
const manila = new Date(Date.now() + 8 * 3600 * 1000);
const CUR = { year: manila.getUTCFullYear(), month: manila.getUTCMonth() + 1 };
const PREV = CUR.month === 1
  ? { year: CUR.year - 1, month: 12 }
  : { year: CUR.year, month: CUR.month - 1 };

let VL = "";

async function cleanup() {
  await admin.from("external_undertime").delete().eq("employee_id", EMP);
  await admin.from("leave_credit_accruals").delete().eq("employee_id", EMP);
  await admin.from("leave_credits").delete().eq("employee_id", EMP);
  await admin.from("employees").delete().eq("id", EMP);
}

async function setExternal(ym: { year: number; month: number }, minutes: number) {
  const { error } = await admin.from("external_undertime").upsert(
    { employee_id: EMP, year: ym.year, month: ym.month, minutes, status: "apply", ext_id: "T108" },
    { onConflict: "employee_id,year,month" },
  );
  assert.equal(error, null);
}

async function apply(ym: { year: number; month: number }) {
  const { error } = await admin.rpc("apply_attendance_vl_deduction", {
    p_year: ym.year, p_month: ym.month, p_employee_id: EMP,
  });
  assert.equal(error, null);
}

async function posted(ym: { year: number; month: number }) {
  const { data, error } = await admin.from("leave_credit_accruals")
    .select("amount, notes")
    .eq("employee_id", EMP).eq("leave_type_id", VL)
    .eq("year", ym.year).eq("month", ym.month).eq("source", "attendance_deduction")
    .order("created_at");
  assert.equal(error, null);
  const rows = (data ?? []).map((r) => ({ amount: Number(r.amount), notes: r.notes as string }));
  return { rows, total: Number(rows.reduce((s, r) => s + r.amount, 0).toFixed(3)) };
}

async function vlTotal(year: number) {
  const { data } = await admin.from("leave_credits").select("total_credits")
    .eq("employee_id", EMP).eq("leave_type_id", VL).eq("year", year).maybeSingle();
  return data ? Number(data.total_credits) : null;
}

test.before(async () => {
  const { data } = await admin.from("leave_types").select("id").eq("code", "VL").single();
  VL = data!.id;
  await cleanup();
  const { error } = await admin.from("employees").insert({
    id: EMP, employee_no: "TEST-108", first_name: "Open", last_name: "Month",
    employment_type: "plantilla", department_id: DEPT, salary_grade: 11,
    step_increment: 1, hire_date: "2015-01-05", status: "active",
  });
  assert.equal(error, null);
});

test.after(cleanup);

test("the current month is not charged, however many minutes it has", async () => {
  await setExternal(CUR, 240);
  await apply(CUR);
  assert.deepEqual((await posted(CUR)).rows, []);

  const { data, error } = await admin.rpc("preview_attendance_vl_deduction", {
    p_year: CUR.year, p_month: CUR.month, p_employee_id: EMP,
  });
  assert.equal(error, null);
  assert.equal(data[0].total_minutes, 0);
  assert.equal(data[0].source, "open_month");
});

test("deductions already posted for the open month are reversed, VL follows", async () => {
  // What an import made before migration 108 left behind.
  const { error } = await admin.from("leave_credit_accruals").insert({
    employee_id: EMP, leave_type_id: VL, year: CUR.year, month: CUR.month,
    amount: -0.5, source: "attendance_deduction", notes: "pre-108 posting",
  });
  assert.equal(error, null);

  await apply(CUR);
  const p = await posted(CUR);
  assert.equal(p.total, 0);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].amount, 0.5);
  assert.match(p.rows[1].notes, /^Month not yet closed/);
  assert.equal(await vlTotal(CUR.year), 0);

  // Re-running is a no-op.
  await apply(CUR);
  assert.equal((await posted(CUR)).rows.length, 2);
});

test("the previous, closed month is charged", async () => {
  await setExternal(PREV, 240);
  await apply(PREV);
  const p = await posted(PREV);
  assert.equal(p.total, -0.5);
  assert.match(p.rows[0].notes, /^External DTR undertime deduction/);
});

test("the daily cron charges the month that just closed", async () => {
  await setExternal(PREV, 480);
  const { data, error } = await admin.rpc("cron_run_closed_month_vl_deduction");
  assert.equal(error, null);
  assert.match(String(data), new RegExp(`${PREV.year}-${String(PREV.month).padStart(2, "0")}`));
  assert.equal((await posted(PREV)).total, -1);
});
