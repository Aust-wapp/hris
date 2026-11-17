// Which leave types consume another type's credits.
//
// CSC: the 5-day Mandatory/Forced Leave is part of the employee's Vacation
// Leave, not a separate pool. An approved FL application therefore lowers the
// VL balance (the `hris.leave_credit_balances` view counts it — migration 107)
// and the FL row only tracks how many forced-leave days are left this year.
//
// Keep this map and the view's `lct.code = 'VL' AND lat.code = 'FL'` clause in
// step.

export const LEAVE_CHARGED_TO: Readonly<Record<string, string>> = {
  FL: "VL",
};

/** The leave code whose credits `code` also consumes, or null. */
export function chargedToCode(code: string | null | undefined): string | null {
  if (!code) return null;
  return LEAVE_CHARGED_TO[code] ?? null;
}

/**
 * Paid days available to a leave of `code`: its own balance, further capped by
 * the balance of the type it is charged to (FL → VL). A type with no credit
 * row has nothing available, as before.
 *
 * `addBack` is added to every balance involved — used when re-allocating an
 * approved leave whose paid days are already subtracted from them.
 */
export function paidLeaveCapacity(
  code: string | null | undefined,
  balanceOf: (code: string) => number | null | undefined,
  addBack = 0,
): number {
  if (!code) return 0;
  const own = balanceOf(code);
  let capacity = own == null ? 0 : Number(own) + addBack;
  const charged = chargedToCode(code);
  if (charged) {
    const chargedBal = balanceOf(charged);
    capacity = Math.min(capacity, chargedBal == null ? 0 : Number(chargedBal) + addBack);
  }
  return Math.max(0, capacity);
}

/** Does a leave of `code` debit the given credit (e.g. "VL") on CSC Form 6 §7.A? */
export function debitsCredit(code: string | null | undefined, credit: string): boolean {
  return code === credit || chargedToCode(code) === credit;
}

// Only VL and SL may be filed beyond the balance — the excess becomes leave
// without pay. Every other type with a credit pool (SPL, FL, WL, SEL, …) must
// be fully covered by its balance or it cannot be filed. Rehabilitation Leave
// has no credit pool at all, so it is not checked either.
const LWOP_ALLOWED: ReadonlySet<string> = new Set(["VL", "SL", "RL"]);

/** Must a leave of `code` be fully covered by its balance to be filed? */
export function requiresFullCredits(code: string | null | undefined): boolean {
  return !!code && !LWOP_ALLOWED.has(code);
}

/** Error to show when a leave of `code` asks for more days than it has, or null. */
export function insufficientCreditsError(
  code: string | null | undefined,
  name: string | null | undefined,
  daysApplied: number,
  capacity: number,
): string | null {
  if (!requiresFullCredits(code) || daysApplied <= capacity) return null;
  const label = name || code;
  const charged = chargedToCode(code);
  const via = charged ? ` (capped by the ${charged} balance)` : "";
  return `Insufficient ${label} credits: ${parseFloat(capacity.toFixed(3))} day(s) available${via}, ${daysApplied} requested.`;
}
