// CSC MC 41 s.1998 §22–23: monetization of leave credits.
//
// Run: npm run test:dtr

import assert from "node:assert/strict";
import test from "node:test";
import {
  monetizationAmount,
  monetizationCharge,
  monetizationError,
  monetizationShare,
} from "../../src/lib/leave-monetization.ts";

const regular = (days: number, vlBalance: number, regularDaysThisYear = 0) =>
  monetizationError({ type: "regular", days, vlBalance, slBalance: 50, regularDaysThisYear });

test("regular: 10–30 days with 15+ VL and 5 kept is allowed", () => {
  assert.equal(regular(10, 15), null);
  assert.equal(regular(30, 40), null);
  assert.equal(regular(15, 20), null);
});

test("regular: needs at least 15 days of VL", () => {
  assert.match(regular(10, 14.999)!, /at least 15 days of VL/);
});

test("regular: minimum of 10 days", () => {
  assert.match(regular(9.5, 40)!, /minimum of 10 days/);
});

test("regular: at least 5 days of VL kept", () => {
  assert.match(regular(11, 15)!, /at most 10 day\(s\)/);
});

test("regular: 30-day yearly limit counts what is already filed", () => {
  assert.equal(regular(10, 40, 20), null);
  assert.match(regular(11, 40, 20)!, /Only 10 more/);
  assert.match(regular(10, 40, 30)!, /already used up/);
});

test("special: ignores the regular limits, capped by VL + SL", () => {
  const special = (days: number, vl: number, sl: number) =>
    monetizationError({ type: "special", days, vlBalance: vl, slBalance: sl, regularDaysThisYear: 30 });
  assert.equal(special(5, 3, 10), null);
  assert.equal(special(60, 40, 20), null);
  assert.match(special(60.5, 40, 20)!, /Only 60 day/);
});

test("days must be positive with at most 3 decimals", () => {
  const e = (days: number) =>
    monetizationError({ type: "special", days, vlBalance: 40, slBalance: 0, regularDaysThisYear: 0 });
  assert.ok(e(0));
  assert.ok(e(Number.NaN));
  assert.ok(e(1.0005));
  assert.equal(e(1.125), null);
});

test("charging: VL first; only special spills into SL", () => {
  assert.deepEqual(monetizationCharge("regular", 10, 40), { vlDays: 10, slDays: 0 });
  assert.deepEqual(monetizationCharge("special", 30, 40), { vlDays: 30, slDays: 0 });
  assert.deepEqual(monetizationCharge("special", 30, 12.5), { vlDays: 12.5, slDays: 17.5 });
  assert.deepEqual(monetizationCharge("special", 5, 0), { vlDays: 0, slDays: 5 });
});

test("amount = monthly salary × days × 0.0481927", () => {
  // 30,000 × 10 × 0.0481927 = 14,457.81
  assert.equal(monetizationAmount(30000, 10), 14457.81);
  assert.equal(monetizationAmount(0, 10), 0);
});

test("share of combined VL + SL", () => {
  assert.equal(monetizationShare(30, 40, 20), 50);
  assert.equal(monetizationShare(10, 0, 0), 0);
});
