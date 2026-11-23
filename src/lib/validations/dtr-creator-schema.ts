import { z } from "zod";
import {
  correctionItemSchema,
} from "./attendance-correction-schema.ts";
import {
  daysInRange,
  MAX_DTR_BATCH_DAYS,
  MAX_DTR_BATCH_EMPLOYEES,
} from "../dtr-creator.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a YYYY-MM-DD date");

// One submission of the DTR Creator: a department, the employees picked from
// it, and ONE day template that is written for each of them. The template days
// reuse the correction item schema — same slots, same "a time or a reason, never
// both" rule, same ABSENT pairing — because each employee's share is filed as a
// correction request and must pass everything a correction would.
export const dtrBatchSchema = z
  .object({
    department_id: z.uuid("Pick a department"),
    employee_ids: z
      .array(z.uuid())
      .min(1, "Select at least one employee")
      .max(
        MAX_DTR_BATCH_EMPLOYEES,
        `Select at most ${MAX_DTR_BATCH_EMPLOYEES} employees at a time`,
      ),
    date_from: isoDate,
    date_to: isoDate,
    reason: z.string().trim().min(5, "Describe the reason for these entries"),
    items: z.array(correctionItemSchema).min(1, "Include at least one day"),
  })
  .refine((v) => v.date_to >= v.date_from, {
    message: "The end date must not precede the start date",
    path: ["date_to"],
  })
  .refine((v) => daysInRange(v.date_from, v.date_to) <= MAX_DTR_BATCH_DAYS, {
    message: `Pick a range of at most ${MAX_DTR_BATCH_DAYS} days`,
    path: ["date_to"],
  })
  .refine((v) => new Set(v.employee_ids).size === v.employee_ids.length, {
    message: "The same employee is selected twice",
    path: ["employee_ids"],
  })
  .refine(
    (v) => new Set(v.items.map((i) => i.duty_date)).size === v.items.length,
    { message: "The same day appears twice", path: ["items"] },
  )
  .refine(
    (v) => v.items.every((i) => i.duty_date >= v.date_from && i.duty_date <= v.date_to),
    { message: "A day falls outside the date range", path: ["items"] },
  );

export type DtrBatchInput = z.infer<typeof dtrBatchSchema>;
