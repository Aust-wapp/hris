// Pure rules for the DTR Creator (/dtr-creator). No database, no Next — the
// server action in src/lib/actions/dtr-creator-actions.ts does the I/O and
// asks this module what to write, so the rules are unit-testable on their own
// (supabase/tests/dtr-creator.test.mts).
//
// Relative imports with .ts extensions so node --experimental-strip-types can
// load this file directly in the tests.

import { isBlankCreateItem } from "./attendance-corrections.ts";
import type { CorrectionItemFormValues } from "./validations/attendance-correction-schema.ts";

/** Most employees one submission may cover — keeps a run inside one request. */
export const MAX_DTR_BATCH_EMPLOYEES = 300;
/** Longest date range one submission may cover. */
export const MAX_DTR_BATCH_DAYS = 31;

/** The days one employee's request will create, and the ones left alone. */
export interface EmployeeDayPlan {
  /** Template days to write: blank-free, and only where no record exists. */
  create: CorrectionItemFormValues[];
  /** Dates that already had an attendance record — never touched here. */
  existing: string[];
}

/**
 * Splits the day template for one employee.
 *
 * A date that already has an attendance row is SKIPPED, never overwritten:
 * changing a recorded day is what Attendance Corrections is for, and doing it
 * here would bypass the review a department's correction gets. A template day
 * with nothing entered is dropped for the same reason the correction wizard
 * drops it (isBlankCreateItem) — it would lock an ABSENT row over a day whose
 * punches may simply not be imported yet.
 */
export function planEmployeeDays(
  template: readonly CorrectionItemFormValues[],
  existingDates: ReadonlySet<string>,
): EmployeeDayPlan {
  const create: CorrectionItemFormValues[] = [];
  const existing: string[] = [];
  for (const item of template) {
    if (existingDates.has(item.duty_date)) {
      existing.push(item.duty_date);
      continue;
    }
    // Every DTR Creator item creates a day, whatever the client sent.
    const createItem: CorrectionItemFormValues = {
      ...item,
      attendance_log_id: null,
      disposition: "update",
    };
    if (isBlankCreateItem(createItem)) continue;
    create.push(createItem);
  }
  return { create, existing };
}

/** What happened to one employee in a batch — shown back to the user. */
export type DtrBatchEmployeeResult =
  | { employeeId: string; name: string; status: "created"; days: number; existing: string[]; requestId: string }
  | { employeeId: string; name: string; status: "skipped"; reason: string; existing: string[] }
  | { employeeId: string; name: string; status: "failed"; reason: string };

/** Inclusive day count of a YYYY-MM-DD range, in UTC so no timezone shifts it. */
export function daysInRange(from: string, to: string): number {
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}
