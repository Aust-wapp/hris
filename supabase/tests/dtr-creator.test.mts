// Unit tests for the DTR Creator's pure rules:
//   - canCreateDtr / canCreateDtrAnyDepartment (src/lib/auth-helpers.ts)
//   - planEmployeeDays (src/lib/dtr-creator.ts)
//   - dtrBatchSchema (src/lib/validations/dtr-creator-schema.ts)
//
// The access rule matters most: the TypeScript guard is the only thing that
// keeps every Department Admin except CHO's out of a module that applies
// attendance with no approval step.
//
// Requires Node >= 22 for --experimental-strip-types.
// Run: npm run test:dtr

import assert from "node:assert/strict";
import test from "node:test";
import {
  canCreateDtr,
  canCreateDtrAnyDepartment,
} from "../../src/lib/auth-helpers.ts";
import { daysInRange, planEmployeeDays } from "../../src/lib/dtr-creator.ts";
import { dtrBatchSchema } from "../../src/lib/validations/dtr-creator-schema.ts";

// ── Access ─────────────────────────────────────────────────────────────

test("super_admin and dtr_manager may create DTRs for any department", () => {
  for (const role of ["super_admin", "dtr_manager"] as const) {
    assert.equal(canCreateDtr({ roles: [role], departmentCode: null }), true);
    assert.equal(canCreateDtrAnyDepartment([role]), true);
  }
});

test("a CHO department_admin may create DTRs, held to its department", () => {
  const actor = { roles: ["department_admin"] as const, departmentCode: "CHO" };
  assert.equal(canCreateDtr(actor), true);
  assert.equal(canCreateDtrAnyDepartment(actor.roles), false);
});

test("the CHO code is matched case- and whitespace-insensitively", () => {
  assert.equal(canCreateDtr({ roles: ["department_admin"], departmentCode: " cho " }), true);
});

test("a department_admin of any other department may not", () => {
  assert.equal(canCreateDtr({ roles: ["department_admin"], departmentCode: "CTO" }), false);
  assert.equal(canCreateDtr({ roles: ["department_admin"], departmentCode: null }), false);
  assert.equal(canCreateDtr({ roles: ["department_admin"] }), false);
});

test("hr_admin, the combined admin+head role and dept heads in CHO may not", () => {
  for (const role of [
    "hr_admin",
    "department_admin_and_department_head",
    "department_head",
    "ocm_admin",
    "employee",
  ] as const) {
    assert.equal(canCreateDtr({ roles: [role], departmentCode: "CHO" }), false, role);
  }
});

test("multi-role: any granting role is enough", () => {
  assert.equal(
    canCreateDtr({ roles: ["employee", "dtr_manager"], departmentCode: "CTO" }),
    true,
  );
});

// ── planEmployeeDays ───────────────────────────────────────────────────

const item = (duty_date: string, over: Record<string, unknown> = {}) => ({
  duty_date,
  attendance_log_id: null,
  disposition: "update" as const,
  proposed_schedule_id: null,
  time_in_am: "08:00",
  time_out_am: "12:00",
  time_in_pm: "13:00",
  time_out_pm: "17:00",
  reason_in_am: null,
  reason_out_am: null,
  reason_in_pm: null,
  reason_out_pm: null,
  ...over,
});

test("days with an existing record are skipped, never planned", () => {
  const plan = planEmployeeDays(
    [item("2026-11-02"), item("2026-11-03"), item("2026-11-04")],
    new Set(["2026-11-03"]),
  );
  assert.deepEqual(plan.create.map((i) => i.duty_date), ["2026-11-02", "2026-11-04"]);
  assert.deepEqual(plan.existing, ["2026-11-03"]);
});

test("blank days are dropped", () => {
  const blank = item("2026-11-05", {
    time_in_am: null,
    time_out_am: null,
    time_in_pm: null,
    time_out_pm: null,
  });
  const plan = planEmployeeDays([blank], new Set());
  assert.equal(plan.create.length, 0);
  assert.equal(plan.existing.length, 0);
});

test("a reason-only day is kept", () => {
  const ob = item("2026-11-06", {
    time_in_am: null,
    time_out_am: null,
    time_in_pm: null,
    time_out_pm: null,
    reason_in_am: "official_business",
    reason_out_am: "official_business",
    reason_in_pm: "official_business",
    reason_out_pm: "official_business",
  });
  assert.equal(planEmployeeDays([ob], new Set()).create.length, 1);
});

test("every planned item is forced to CREATE, whatever the client sent", () => {
  const sneaky = item("2026-11-09", {
    attendance_log_id: "11111111-1111-4111-8111-111111111111",
    disposition: "clear_as_off",
  });
  const [planned] = planEmployeeDays([sneaky], new Set()).create;
  assert.equal(planned.attendance_log_id, null);
  assert.equal(planned.disposition, "update");
});

// ── Schema ─────────────────────────────────────────────────────────────

const valid = () => ({
  department_id: "22222222-2222-4222-8222-222222222222",
  employee_ids: ["33333333-3333-4333-8333-333333333333"],
  date_from: "2026-11-02",
  date_to: "2026-11-06",
  reason: "Field duty per office order",
  items: [item("2026-11-02")],
});

test("a well-formed batch passes", () => {
  assert.equal(dtrBatchSchema.safeParse(valid()).success, true);
});

test("ranges over 31 days are refused", () => {
  assert.equal(daysInRange("2026-11-01", "2026-12-01"), 31);
  const r = dtrBatchSchema.safeParse({ ...valid(), date_from: "2026-11-01", date_to: "2026-12-02" });
  assert.equal(r.success, false);
});

test("duplicate employees, out-of-range days and no employees are refused", () => {
  const v = valid();
  assert.equal(
    dtrBatchSchema.safeParse({ ...v, employee_ids: [v.employee_ids[0], v.employee_ids[0]] }).success,
    false,
  );
  assert.equal(dtrBatchSchema.safeParse({ ...v, items: [item("2026-11-20")] }).success, false);
  assert.equal(dtrBatchSchema.safeParse({ ...v, employee_ids: [] }).success, false);
});

test("a slot with both a time and a reason is refused", () => {
  const bad = item("2026-11-02", { reason_in_am: "official_business" });
  assert.equal(dtrBatchSchema.safeParse({ ...valid(), items: [bad] }).success, false);
});
