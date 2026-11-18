// Stack test for migration 109: approved monetization lowers VL by
// days_with_pay and SL by sl_days_with_pay; pending ones change nothing.
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
const YEAR = 2033;

const typeId: Record<string, string> = {};

async function cleanup() {
  await admin.from("leave_applications").delete().eq("employee_id", EMP)
    .gte("start_date", `${YEAR}-01-01`).lte("start_date", `${YEAR}-12-31`);
  await admin.from("leave_credits").delete().eq("employee_id", EMP).eq("year", YEAR);
}

async function balance(code: string) {
  const { data, error } = await admin.from("leave_credit_balances")
    .select("used_credits, balance")
    .eq("employee_id", EMP).eq("leave_type_id", typeId[code]).eq("year", YEAR)
    .single();
  assert.equal(error, null);
  return { used: Number(data!.used_credits), balance: Number(data!.balance) };
}

async function fileMonetization(
  type: "regular" | "special",
  vlDays: number,
  slDays: number,
  appStatus: string,
) {
  const date = `${YEAR}-06-15`;
  const { data, error } = await admin.from("leave_applications").insert({
    employee_id: EMP,
    leave_type_id: typeId.VL,
    start_date: date,
    end_date: date,
    leave_dates: [],
    days_applied: vlDays + slDays,
    days_with_pay: vlDays,
    sl_days_with_pay: slDays,
    monetization_type: type,
    monetization_monthly_salary: 30000,
    commutation_requested: true,
    status: appStatus,
  }).select("id").single();
  assert.equal(error, null);
  return data!.id as string;
}

test.before(async () => {
  const { data, error } = await admin.from("leave_types").select("id, code");
  assert.equal(error, null);
  for (const t of data ?? []) typeId[t.code] = t.id;
  await cleanup();
  const { error: lcErr } = await admin.from("leave_credits").insert([
    { employee_id: EMP, leave_type_id: typeId.VL, year: YEAR, total_credits: 20 },
    { employee_id: EMP, leave_type_id: typeId.SL, year: YEAR, total_credits: 30 },
  ]);
  assert.equal(lcErr, null);
});

test.after(cleanup);

test("pending monetization changes no balance", async () => {
  await fileMonetization("special", 20, 10, "pending");
  assert.equal((await balance("VL")).balance, 20);
  assert.equal((await balance("SL")).balance, 30);
});

test("approved regular monetization lowers VL only", async () => {
  await cleanup();
  await admin.from("leave_credits").insert([
    { employee_id: EMP, leave_type_id: typeId.VL, year: YEAR, total_credits: 20 },
    { employee_id: EMP, leave_type_id: typeId.SL, year: YEAR, total_credits: 30 },
  ]);
  await fileMonetization("regular", 10, 0, "approved");
  assert.deepEqual(await balance("VL"), { used: 10, balance: 10 });
  assert.deepEqual(await balance("SL"), { used: 0, balance: 30 });
});

test("approved special monetization lowers VL and SL by their portions", async () => {
  const id = await fileMonetization("special", 10, 12.5, "approved");
  assert.deepEqual(await balance("VL"), { used: 20, balance: 0 });
  assert.deepEqual(await balance("SL"), { used: 12.5, balance: 17.5 });

  // Cancelling gives both back.
  await admin.from("leave_applications").update({ status: "cancelled" }).eq("id", id);
  assert.deepEqual(await balance("VL"), { used: 10, balance: 10 });
  assert.deepEqual(await balance("SL"), { used: 0, balance: 30 });
});

test("monetization_type only accepts regular or special", async () => {
  const { error } = await admin.from("leave_applications").insert({
    employee_id: EMP,
    leave_type_id: typeId.VL,
    start_date: `${YEAR}-06-15`,
    end_date: `${YEAR}-06-15`,
    days_applied: 1,
    days_with_pay: 1,
    monetization_type: "bonus",
    status: "pending",
  });
  assert.ok(error);
});
