// Stack test for migration 107: approved Forced Leave lowers the VL balance
// (CSC), and Wellness Leave exists with a 5-day 2026 seed.
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

// Seeded by supabase/seed.sql, active plantilla.
const EMP = "00000000-0000-0000-0000-0000000000e2";
// A year nothing else in the suite touches.
const YEAR = 2032;

const typeId: Record<string, string> = {};

async function cleanup() {
  // provision_year() seeds every active employee, so clear the whole year.
  await admin.from("leave_credit_accruals").delete().eq("year", YEAR);
  await admin.from("leave_applications").delete().eq("employee_id", EMP)
    .gte("start_date", `${YEAR}-01-01`).lte("start_date", `${YEAR}-12-31`);
  await admin.from("leave_credits").delete().eq("year", YEAR);
}

async function balance(code: string) {
  const { data, error } = await admin.from("leave_credit_balances")
    .select("total_credits, used_credits, balance")
    .eq("employee_id", EMP).eq("leave_type_id", typeId[code]).eq("year", YEAR)
    .single();
  assert.equal(error, null);
  return {
    total: Number(data!.total_credits),
    used: Number(data!.used_credits),
    balance: Number(data!.balance),
  };
}

async function fileLeave(code: string, date: string, days: number, status: string) {
  const { error } = await admin.from("leave_applications").insert({
    employee_id: EMP,
    leave_type_id: typeId[code],
    start_date: date,
    end_date: date,
    days_applied: days,
    days_with_pay: days,
    leave_dates: [date],
    status,
  });
  assert.equal(error, null);
}

test.before(async () => {
  const { data, error } = await admin.from("leave_types").select("id, code");
  assert.equal(error, null);
  for (const t of data ?? []) typeId[t.code] = t.id;
  await cleanup();
  const { error: lcErr } = await admin.from("leave_credits").insert([
    { employee_id: EMP, leave_type_id: typeId.VL, year: YEAR, total_credits: 20 },
    { employee_id: EMP, leave_type_id: typeId.FL, year: YEAR, total_credits: 5 },
    { employee_id: EMP, leave_type_id: typeId.SL, year: YEAR, total_credits: 10 },
  ]);
  assert.equal(lcErr, null);
});

test.after(cleanup);

test("approved Forced Leave lowers both the FL row and the VL balance", async () => {
  await fileLeave("FL", `${YEAR}-03-02`, 3, "approved");

  assert.deepEqual(await balance("FL"), { total: 5, used: 3, balance: 2 });
  assert.deepEqual(await balance("VL"), { total: 20, used: 3, balance: 17 });
  assert.deepEqual(await balance("SL"), { total: 10, used: 0, balance: 10 });
});

test("VL counts its own leaves plus FL; pending and cancelled count nowhere", async () => {
  await fileLeave("VL", `${YEAR}-04-06`, 2, "approved");
  await fileLeave("FL", `${YEAR}-05-04`, 1, "pending");
  await fileLeave("FL", `${YEAR}-06-01`, 1, "cancelled");

  assert.deepEqual(await balance("VL"), { total: 20, used: 5, balance: 15 });
  assert.deepEqual(await balance("FL"), { total: 5, used: 3, balance: 2 });
});

test("Wellness Leave exists: 5 days a year, not cumulative, not convertible", async () => {
  const { data, error } = await admin.from("leave_types")
    .select("name, max_credits, annual_credits, is_cumulative, is_convertible")
    .eq("code", "WL").single();
  assert.equal(error, null);
  assert.equal(data!.name, "Wellness Leave");
  assert.equal(Number(data!.max_credits), 5);
  assert.equal(data!.annual_credits, null);
  assert.equal(data!.is_cumulative, false);
  assert.equal(data!.is_convertible, false);
});

test("provision_year seeds 5 days of Wellness Leave for the year", async () => {
  const { error } = await admin.rpc("provision_year", { p_year: YEAR });
  assert.equal(error, null);
  assert.equal((await balance("WL")).total, 5);
});
