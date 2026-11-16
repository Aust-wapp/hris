// Unit tests for the read-only "jo_viewer" role (migrations 103/104).
//
// The split is: canViewJobOrders opens every Job Orders page and read action;
// canManageJobOrders and canManageJobOrderPayroll gate every write. A JO
// Viewer must pass the first and fail both of the others — the server actions
// use the admin client, so these TypeScript checks are what stop a viewer
// from writing.
//
// Run: npm run test:dtr

import assert from "node:assert/strict";
import test from "node:test";
import {
  canAccessDtr,
  canManageJobOrderPayroll,
  canManageJobOrders,
  canViewJobOrders,
  primaryRole,
} from "../../src/lib/auth-helpers.ts";
import { canDeletePayroll } from "../../src/lib/job-order-payroll-guards.ts";

test("jo_viewer may open the Job Orders module", () => {
  assert.equal(canViewJobOrders(["jo_viewer"]), true);
});

test("jo_viewer may not write Job Orders, areas, memos, special orders or signatories", () => {
  assert.equal(canManageJobOrders(["jo_viewer"]), false);
});

test("jo_viewer may not write payroll, whatever the module-payroll switch says", () => {
  assert.equal(canManageJobOrderPayroll({ roles: ["jo_viewer"] }), false);
  assert.equal(
    canManageJobOrderPayroll({ roles: ["jo_viewer"], canManageModulePayroll: true }),
    false,
  );
  assert.equal(canDeletePayroll(["jo_viewer"]), false);
});

test("jo_viewer has no Monthly DTR", () => {
  assert.equal(canAccessDtr(["jo_viewer"]), false);
  // ...but an Employee who is also a viewer keeps their own DTR.
  assert.equal(canAccessDtr(["jo_viewer", "employee"]), true);
});

test("every role that manages Job Orders may also view them", () => {
  for (const role of ["super_admin", "hr_admin", "jo_manager"] as const) {
    assert.equal(canViewJobOrders([role]), true, role);
    assert.equal(canManageJobOrders([role]), true, role);
  }
});

test("roles outside the module may not view it", () => {
  for (const role of ["cos_manager", "employee", "ocm_admin", "department_head"] as const) {
    assert.equal(canViewJobOrders([role]), false, role);
  }
});

test("jo_manager keeps payroll write access with the switch on", () => {
  assert.equal(
    canManageJobOrderPayroll({ roles: ["jo_manager"], canManageModulePayroll: true }),
    true,
  );
});

test("a viewer who is also a JO Manager may write — the manager hat wins", () => {
  assert.equal(canManageJobOrders(["jo_viewer", "jo_manager"]), true);
  assert.equal(primaryRole(["jo_viewer", "jo_manager"]), "jo_manager");
});

test("jo_viewer ranks below the module managers and above employee", () => {
  assert.equal(primaryRole(["jo_viewer", "cos_manager"]), "cos_manager");
  assert.equal(primaryRole(["jo_viewer", "employee"]), "jo_viewer");
});
