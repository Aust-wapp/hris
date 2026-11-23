// Stack test for the DTR Creator's write path against real Postgres + PostgREST.
//
// createDtrBatch (src/lib/actions/dtr-creator-actions.ts) needs a signed-in
// session, so this drives the same steps it takes, in the same order, with the
// service-role client: plan each employee's days with planEmployeeDays over the
// rows that really exist, file one direct-apply request per employee tagged
// with a shared dtr_batch_id (migration 110), and apply it through
// apply_attendance_correction. What only a real database can show:
//   * dtr_batch_id exists and groups the batch's requests;
//   * created days come back source 'manual' + correction_locked, so they are
//     editable only through Attendance Corrections and survive re-imports;
//   * a day that already had a record is left exactly as it was.
//
// Requires Node >= 22 and a running stack with migrations applied:
//   colima start && npm run db:start && npm run db:reset && npm run test:db

import assert from "node:assert/strict";
import test from "node:test";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { buildCorrectionRecord } from "../../src/lib/attendance-corrections.ts";
import { DEFAULT_SCHEDULE } from "../../src/lib/attendance-schedule.ts";
import { planEmployeeDays } from "../../src/lib/dtr-creator.ts";

const PROJECT_DIR = fileURLToPath(new URL("../..", import.meta.url));
const status = JSON.parse(
  execSync("npx supabase status -o json", { cwd: PROJECT_DIR, encoding: "utf8" }),
);
const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
  db: { schema: "hris" },
  auth: { autoRefreshToken: false, persistSession: false },
});

// Seeded by supabase/seed.sql.
const EMPLOYEES = [
  "00000000-0000-0000-0000-0000000000e2",
  "00000000-0000-0000-0000-0000000000e3",
];
const CREATOR = "00000000-0000-0000-0000-00000000aaaa";
// Dates nothing else in the suite touches.
const DATES = ["2026-08-03", "2026-08-04", "2026-08-05"];
const PRE_EXISTING = { employee: EMPLOYEES[1], date: "2026-08-04" };

const BATCH_ID = crypto.randomUUID();

async function cleanup() {
  await admin.from("attendance_correction_requests").delete().eq("dtr_batch_id", BATCH_ID);
  await admin.from("attendance_logs").delete().in("employee_id", EMPLOYEES).in("date", DATES);
}

test.before(cleanup);
test.after(cleanup);

const template = DATES.map((duty_date) => ({
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
}));

test("a batch creates locked manual days per employee and skips recorded ones", async () => {
  // One employee already has a biometric day inside the range.
  const { data: existingLog, error: seedErr } = await admin
    .from("attendance_logs")
    .insert({
      employee_id: PRE_EXISTING.employee,
      date: PRE_EXISTING.date,
      time_in_am: `${PRE_EXISTING.date}T07:58:00+08:00`,
      source: "biometric",
    })
    .select("id, time_in_am, source, correction_locked")
    .single();
  assert.equal(seedErr, null);

  for (const employeeId of EMPLOYEES) {
    const { data: rows } = await admin
      .from("attendance_logs")
      .select("date")
      .eq("employee_id", employeeId)
      .in("date", DATES);
    const plan = planEmployeeDays(template, new Set((rows ?? []).map((r) => r.date as string)));
    const dates = plan.create.map((i) => i.duty_date).sort();

    const requestId = crypto.randomUUID();
    const { error: reqErr } = await admin.from("attendance_correction_requests").insert({
      id: requestId,
      employee_id: employeeId,
      date_from: dates[0],
      date_to: dates[dates.length - 1],
      reason: "Field duty per Office Order 2026-120",
      direct_apply: true,
      dtr_batch_id: BATCH_ID,
      requested_by: CREATOR,
      requested_by_email: "dtr@example.gov",
    });
    assert.equal(reqErr, null, reqErr?.message);

    const { error: itemErr } = await admin.from("attendance_correction_items").insert(
      plan.create.map((i) => ({
        request_id: requestId,
        duty_date: i.duty_date,
        attendance_log_id: null,
        disposition: "update",
        proposed_time_in_am: i.time_in_am,
        proposed_time_out_am: i.time_out_am,
        proposed_time_in_pm: i.time_in_pm,
        proposed_time_out_pm: i.time_out_pm,
        before: {},
      })),
    );
    assert.equal(itemErr, null, itemErr?.message);

    const { data: outcome, error: rpcErr } = await admin.rpc("apply_attendance_correction", {
      p_request_id: requestId,
      p_reviewer_id: CREATOR,
      p_reviewer_email: "dtr@example.gov",
      p_rows: plan.create.map((i) => ({
        duty_date: i.duty_date,
        attendance_log_id: null,
        record: buildCorrectionRecord(employeeId, {
          duty_date: i.duty_date,
          disposition: "update",
          schedule: DEFAULT_SCHEDULE,
          scheduleId: null,
          time_in_am: i.time_in_am,
          time_out_am: i.time_out_am,
          time_in_pm: i.time_in_pm,
          time_out_pm: i.time_out_pm,
          reason_in_am: null,
          reason_out_am: null,
          reason_in_pm: null,
          reason_out_pm: null,
        }),
      })),
    });
    assert.equal(rpcErr, null, rpcErr?.message);
    assert.equal(outcome, "applied");
  }

  // The batch is one query away, and every request in it applied.
  const { data: batch } = await admin
    .from("attendance_correction_requests")
    .select("employee_id, status, direct_apply")
    .eq("dtr_batch_id", BATCH_ID);
  assert.equal(batch!.length, 2);
  assert.ok(batch!.every((r) => r.status === "approved" && r.direct_apply));

  // 3 days for the first employee, 2 for the second (one was already recorded).
  const { data: logs } = await admin
    .from("attendance_logs")
    .select("employee_id, date, source, correction_locked, time_in_am, is_absent")
    .in("employee_id", EMPLOYEES)
    .in("date", DATES);
  const created = logs!.filter(
    (l) => !(l.employee_id === PRE_EXISTING.employee && l.date === PRE_EXISTING.date),
  );
  assert.equal(created.length, 5);
  for (const l of created) {
    assert.equal(l.source, "manual");
    assert.equal(l.correction_locked, true);
    assert.equal(l.is_absent, false);
  }
  // Times are stored as the wall-clock value written (see the 06:05 assertion in
  // attendance-corrections-db.test.mts), so 08:00 reads back as 08:00 — the
  // grid's HH:MM must not drift on the way through PostgREST.
  for (const l of created) {
    assert.match(String(l.time_in_am), new RegExp(`${l.date}T08:00`));
  }

  const untouched = logs!.find(
    (l) => l.employee_id === PRE_EXISTING.employee && l.date === PRE_EXISTING.date,
  )!;
  assert.equal(untouched.source, "biometric");
  assert.equal(untouched.correction_locked, false);
  assert.equal(untouched.time_in_am, existingLog!.time_in_am);
});

test("a released request can be marked cancelled, freeing its dates", async () => {
  const requestId = crypto.randomUUID();
  const { error } = await admin.from("attendance_correction_requests").insert({
    id: requestId,
    employee_id: EMPLOYEES[0],
    date_from: "2026-08-06",
    date_to: "2026-08-06",
    reason: "Field duty per Office Order 2026-120",
    direct_apply: true,
    dtr_batch_id: BATCH_ID,
  });
  assert.equal(error, null);
  const { error: upErr } = await admin
    .from("attendance_correction_requests")
    .update({ status: "cancelled", review_notes: "DTR Creator: writing the days failed." })
    .eq("id", requestId);
  assert.equal(upErr, null);
  // A second live request over the same date is accepted once the first is cancelled.
  const second = crypto.randomUUID();
  const { error: againErr } = await admin.from("attendance_correction_requests").insert({
    id: second,
    employee_id: EMPLOYEES[0],
    date_from: "2026-08-06",
    date_to: "2026-08-06",
    reason: "Field duty per Office Order 2026-120",
    direct_apply: true,
    dtr_batch_id: BATCH_ID,
  });
  assert.equal(againErr, null, againErr?.message);
});
