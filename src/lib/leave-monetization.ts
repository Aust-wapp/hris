// Monetization of leave credits — CSC MC No. 41, s. 1998 (Omnibus Rules on
// Leave), Rule XVI:
//
//   §22 REGULAR. An official or employee with at least 15 days of vacation
//       leave credits may monetize a minimum of 10 days, up to 30 days in a
//       year, provided at least 5 days of VL are retained afterwards.
//   §23 SPECIAL. Monetization of 50% or more of the accumulated leave credits
//       may be allowed for valid and justifiable reasons (health, medical and
//       hospitalization needs, natural calamities, education of self or
//       children, payment of mortgages and loans, and analogous cases), at the
//       discretion of the head of agency and subject to available funds. CSC
//       reads §23 as an exception to §22, so its 10/30/5-day limits do not apply.
//
// Charging: VL is used first; a special monetization charges SL only for the
// days VL cannot cover. Amount: monthly salary × days × 0.0481927 (the CSC/DBM
// constant factor used for leave commutation).
//
// Pure functions only — shared by the form, the server action and the tests.

export type MonetizationType = "regular" | "special";

export const MONETIZATION_FACTOR = 0.0481927;

export const REGULAR_MIN_VL_BALANCE = 15;
export const REGULAR_MIN_DAYS = 10;
export const REGULAR_MAX_DAYS_PER_YEAR = 30;
export const REGULAR_MIN_VL_RETAINED = 5;

export const MONETIZATION_TYPE_LABELS: Record<MonetizationType, string> = {
  regular: "Regular (CSC MC 41 s.1998, §22)",
  special: "Special — 50% or more (CSC MC 41 s.1998, §23)",
};

/** Short label for lists and badges. */
export const MONETIZATION_SHORT_LABELS: Record<MonetizationType, string> = {
  regular: "Monetization",
  special: "Monetization (Special)",
};

/** §23's justifiable reasons, offered as a pick-list on the form. */
export const SPECIAL_MONETIZATION_REASONS = [
  "Health, medical and hospitalization needs",
  "Financial aid and assistance brought about by natural calamities, typhoons, fire, etc.",
  "Educational needs of self or children",
  "Payment of mortgages and loans",
  "Other analogous reason",
] as const;

export const MONETIZATION_DETAILS = "Monetization of Leave Credits";

export function isMonetizationType(v: unknown): v is MonetizationType {
  return v === "regular" || v === "special";
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const fmt = (n: number) => parseFloat(round3(n).toFixed(3)).toString();

export interface MonetizationInput {
  type: MonetizationType;
  days: number;
  /** VL balance before this application. */
  vlBalance: number;
  /** SL balance before this application. */
  slBalance: number;
  /** Regular monetization days already filed this year (approved or pending), excluding this one. */
  regularDaysThisYear: number;
}

export interface MonetizationCharge {
  vlDays: number;
  slDays: number;
}

/** Why `input` breaks the CSC rules, or null when it may be filed/approved. */
export function monetizationError(input: MonetizationInput): string | null {
  const { type, days } = input;
  const vl = Math.max(0, input.vlBalance);
  const sl = Math.max(0, input.slBalance);

  if (!Number.isFinite(days) || days <= 0) return "Enter the number of days to monetize.";
  if (round3(days) !== days) return "Days can have at most 3 decimal places.";

  if (type === "regular") {
    if (vl < REGULAR_MIN_VL_BALANCE) {
      return `Regular monetization needs at least ${REGULAR_MIN_VL_BALANCE} days of VL; the balance is ${fmt(vl)}.`;
    }
    if (days < REGULAR_MIN_DAYS) {
      return `Regular monetization is a minimum of ${REGULAR_MIN_DAYS} days.`;
    }
    const left = REGULAR_MAX_DAYS_PER_YEAR - input.regularDaysThisYear;
    if (days > left) {
      return left <= 0
        ? `The ${REGULAR_MAX_DAYS_PER_YEAR}-day yearly limit for regular monetization is already used up.`
        : `Only ${fmt(left)} more day(s) can be monetized this year (limit ${REGULAR_MAX_DAYS_PER_YEAR}; ${fmt(input.regularDaysThisYear)} already filed).`;
    }
    if (vl - days < REGULAR_MIN_VL_RETAINED) {
      return `At least ${REGULAR_MIN_VL_RETAINED} days of VL must be kept: at most ${fmt(Math.max(0, vl - REGULAR_MIN_VL_RETAINED))} day(s) can be monetized.`;
    }
    return null;
  }

  if (days > vl + sl) {
    return `Only ${fmt(vl + sl)} day(s) of VL and SL are available.`;
  }
  return null;
}

/** How the days are charged: VL first, then (special only) SL. */
export function monetizationCharge(
  type: MonetizationType,
  days: number,
  vlBalance: number,
): MonetizationCharge {
  const vl = Math.max(0, vlBalance);
  if (type === "regular") return { vlDays: round3(days), slDays: 0 };
  const vlDays = round3(Math.min(days, vl));
  return { vlDays, slDays: round3(days - vlDays) };
}

/** Share of the combined VL + SL balance being monetized, 0–100. */
export function monetizationShare(days: number, vlBalance: number, slBalance: number): number {
  const total = Math.max(0, vlBalance) + Math.max(0, slBalance);
  return total > 0 ? Math.round((days / total) * 1000) / 10 : 0;
}

/** Monthly salary × days × 0.0481927, rounded to centavos. */
export function monetizationAmount(monthlySalary: number, days: number): number {
  return Math.round(monthlySalary * days * MONETIZATION_FACTOR * 100) / 100;
}

export function formatPeso(n: number): string {
  return `₱${n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Paid days of a leave application: days_with_pay plus a special
 * monetization's SL portion. days_applied minus this is leave without pay.
 */
export function paidDaysOf(app: {
  days_applied: number | string;
  days_with_pay?: number | string | null;
  sl_days_with_pay?: number | string | null;
}): number {
  return Number(app.days_with_pay ?? app.days_applied) + Number(app.sl_days_with_pay ?? 0);
}

/** Leave type name, or the monetization label for a monetization. */
export function leaveDisplayName(
  typeName: string | null | undefined,
  monetizationType: string | null | undefined,
): string {
  return isMonetizationType(monetizationType)
    ? MONETIZATION_SHORT_LABELS[monetizationType]
    : typeName ?? "Unknown";
}
