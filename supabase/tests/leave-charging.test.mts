// CSC: Mandatory/Forced Leave is charged to Vacation Leave.
//
// Run: npm run test:dtr

import assert from "node:assert/strict";
import test from "node:test";
import {
  chargedToCode,
  debitsCredit,
  paidLeaveCapacity,
} from "../../src/lib/leave-charging.ts";

const balances = (map: Record<string, number>) => (code: string) => map[code];

test("Forced Leave is charged to VL; other types to nothing", () => {
  assert.equal(chargedToCode("FL"), "VL");
  for (const code of ["VL", "SL", "SPL", "WL", "ML", null, undefined, ""]) {
    assert.equal(chargedToCode(code), null);
  }
});

test("FL capacity is the smaller of its own row and the VL balance", () => {
  assert.equal(paidLeaveCapacity("FL", balances({ FL: 5, VL: 49 })), 5);
  assert.equal(paidLeaveCapacity("FL", balances({ FL: 5, VL: 2.5 })), 2.5);
  assert.equal(paidLeaveCapacity("FL", balances({ FL: 0, VL: 49 })), 0);
});

test("FL with no VL row has nothing paid", () => {
  assert.equal(paidLeaveCapacity("FL", balances({ FL: 5 })), 0);
});

test("uncharged types use only their own balance; a missing row is 0", () => {
  assert.equal(paidLeaveCapacity("WL", balances({ WL: 5, VL: 0 })), 5);
  assert.equal(paidLeaveCapacity("VL", balances({ VL: 12.25 })), 12.25);
  assert.equal(paidLeaveCapacity("SPL", balances({ VL: 10 })), 0);
  assert.equal(paidLeaveCapacity(null, balances({ VL: 10 })), 0);
});

test("negative balances never give negative capacity", () => {
  assert.equal(paidLeaveCapacity("VL", balances({ VL: -0.775 })), 0);
  assert.equal(paidLeaveCapacity("FL", balances({ FL: 5, VL: -1 })), 0);
});

test("addBack re-adds an approved leave's paid days to both balances", () => {
  // An approved 3-day FL: FL row 2 left, VL 1 left after it.
  assert.equal(paidLeaveCapacity("FL", balances({ FL: 2, VL: 1 }), 3), 4);
});

test("Form 6 §7.A: FL debits VL, not SL; WL debits neither", () => {
  assert.equal(debitsCredit("FL", "VL"), true);
  assert.equal(debitsCredit("FL", "SL"), false);
  assert.equal(debitsCredit("VL", "VL"), true);
  assert.equal(debitsCredit("SL", "SL"), true);
  assert.equal(debitsCredit("WL", "VL"), false);
  assert.equal(debitsCredit("SPL", "VL"), false);
});
