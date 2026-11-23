// The one code path that turns a correction request's items into attendance
// rows. Shared by attendance-correction-actions.ts (approval, direct-apply) and
// dtr-creator-actions.ts (batch creation) so every route onto a DTR writes the
// same thing — see the note on applyCorrectionItems.
//
// A plain server module, NOT "use server": nothing here checks authority, so
// none of it may become a Server Action callable from the browser. Callers
// check first.
import "server-only";

import type { createAdminClient } from "@/lib/supabase/admin";
import { loadScheduleContext } from "@/lib/schedule-context";
import {
  buildCorrectionRecord,
  isBlankCreateItem,
  resolveItemSchedules,
  type ResolvedItemSchedule,
} from "@/lib/attendance-corrections";
import {
  DEFAULT_SCHEDULE,
  type ScheduleLike,
} from "@/lib/attendance-schedule";
import type { CorrectionReason } from "@/lib/constants";

/** HH:MM out of a stored TIME column. Mirrors extractTime in attendance-actions.ts. */
export function hhmmOf(ts: string | null): string | null {
  return ts?.match(/(\d{2}:\d{2})/)?.[1] ?? null;
}

// Batch-fetches everything resolveItemSchedules (attendance-corrections.ts)
// needs — the employee's own schedule, each item's row-level pin (via its
// attendance_log's schedule_id), and every schedule either might reference —
// in three queries regardless of how many items the request has, then hands
// off to the pure resolver. approveCorrectionRequest and
// getCorrectionReviewSummary both call ONLY this for schedule resolution, so
// the minutes HR reviews and the minutes approval writes cannot diverge —
// they are the same computation over the same data, not two independent
// re-derivations that can drift apart.
export async function loadItemSchedules(
  supabase: ReturnType<typeof createAdminClient>,
  employeeId: string,
  items: {
    duty_date: string;
    attendance_log_id: string | null;
    proposed_schedule_id: string | null;
  }[],
): Promise<ResolvedItemSchedule[]> {
  // Without a pin, each day is measured against what the employee's rotation
  // or a per-date override says for THAT date (resolveDaySchedule), and a rest
  // day is charged nothing — the same answer the DTR gives.
  const dates = items.map((i) => i.duty_date).sort();
  const resolveDay =
    dates.length > 0
      ? await loadScheduleContext(supabase, [employeeId], dates[0], dates[dates.length - 1])
      : null;

  // CREATE items have no row, so no row-level pin to look up — resolution for
  // them falls through to the employee's schedule (or the org default).
  const logIds = items
    .map((i) => i.attendance_log_id)
    .filter((v): v is string => !!v);
  const { data: logs, error: logsErr } =
    logIds.length === 0
      ? { data: [], error: null }
      : await supabase
          .schema("hris")
          .from("attendance_logs")
          .select("id, schedule_id")
          .in("id", logIds);
  if (logsErr) throw logsErr;
  const rowScheduleIdByLogId = new Map(
    (logs ?? []).map((l) => [l.id as string, l.schedule_id as string | null]),
  );

  const scheduleIds = [
    ...new Set(
      items
        .map((i) => i.proposed_schedule_id)
        .concat([...rowScheduleIdByLogId.values()])
        .filter((v): v is string => !!v),
    ),
  ];
  const { data: schedules, error: schedErr } =
    scheduleIds.length === 0
      ? { data: [] as ScheduleLike[], error: null }
      : await supabase
          .schema("hris")
          .from("schedules")
          .select("id, time_in, time_out, break_start, break_end")
          .in("id", scheduleIds);
  if (schedErr) throw schedErr;
  const scheduleById = new Map(
    (schedules ?? []).map((s) => [s.id as string, s as ScheduleLike]),
  );

  return items.map((item) => {
    const day = resolveDay ? resolveDay(employeeId, item.duty_date) : null;
    const [resolved] = resolveItemSchedules(
      [item],
      scheduleById,
      rowScheduleIdByLogId,
      day?.sched ?? null,
      DEFAULT_SCHEDULE,
    );
    const rowScheduleId = item.attendance_log_id
      ? (rowScheduleIdByLogId.get(item.attendance_log_id) ?? null)
      : null;
    const pinned = !!item.proposed_schedule_id || !!rowScheduleId;
    return { ...resolved, restDay: pinned ? false : day?.restDay };
  });
}

// Builds every day's finished attendance row and commits them through the
// transactional RPC. Extracted so the two ways a correction can reach a DTR —
// an HR reviewer approving a department's request, and a reviewer-level role
// filing one that applies on submit — run the SAME code. They must not become
// two re-derivations of "what does this correction write": that class of drift
// already produced one bug here, where the review summary and approval
// resolved schedules differently (see loadItemSchedules).
//
// Assumes the caller has checked authority and that the request is live.
export async function applyCorrectionItems(
  supabase: ReturnType<typeof createAdminClient>,
  requestId: string,
  employeeId: string,
  reviewer: { id: string; email: string },
  /** The request's narrative, written onto each day's `remarks`. */
  narrative: string | null,
): Promise<"applied" | "needs_rebase"> {
  const { data: items, error: itemErr } = await supabase
    .schema("hris")
    .from("attendance_correction_items")
    .select("*")
    .eq("request_id", requestId)
    .order("duty_date");
  if (itemErr) throw itemErr;
  if (!items || items.length === 0) throw new Error("This request has no days");

  const resolved = await loadItemSchedules(supabase, employeeId, items);

  // A schedule deleted between submit and approval must not silently revert
  // the day to the inherited schedule — send the request back instead.
  // Unreachable through app code today: attendance_correction_items_proposed_schedule_id_fkey
  // is ON DELETE NO ACTION (migration 065), so Postgres itself refuses to
  // delete a schedule any live item still references — contrast
  // attendance_logs_schedule_id_fkey, which is ON DELETE SET NULL. This check
  // is defense-in-depth on top of that FK, not the primary guarantee: a
  // direct DB edit or a future migration that loosens the FK should still
  // fail safe here instead of silently applying numbers nobody reviewed.
  if (resolved.some((r) => r.itemPinMissing)) {
    await supabase
      .schema("hris")
      .from("attendance_correction_requests")
      .update({ status: "needs_rebase", updated_at: new Date().toISOString() })
      .eq("id", requestId);
    return "needs_rebase";
  }

  // Requests filed before isBlankCreateItem existed can still carry blank
  // CREATE items; drop them here too rather than lock an ABSENT row over a day
  // whose punches have not been imported yet.
  const kept = items
    .map((item, i) => ({ item, sched: resolved[i] }))
    .filter(
      ({ item }) =>
        !isBlankCreateItem({
          attendance_log_id: item.attendance_log_id,
          disposition: item.disposition,
          time_in_am: item.proposed_time_in_am,
          time_out_am: item.proposed_time_out_am,
          time_in_pm: item.proposed_time_in_pm,
          time_out_pm: item.proposed_time_out_pm,
          reason_in_am: item.proposed_in_am_reason,
          reason_out_am: item.proposed_out_am_reason,
          reason_in_pm: item.proposed_in_pm_reason,
          reason_out_pm: item.proposed_out_pm_reason,
        }),
    );

  // duty_date is the key the RPC looks items up by (migration 067) —
  // attendance_log_id is nullable now and several items can share NULL, so it
  // no longer identifies a row. It is still sent for readability of the payload
  // in the audit log; the function reads the item's own value, not this one.
  const rows = kept.map(({ item, sched }) => ({
    duty_date: item.duty_date,
    attendance_log_id: item.attendance_log_id,
    record: buildCorrectionRecord(employeeId, {
      duty_date: item.duty_date,
      disposition: item.disposition,
      schedule: sched.schedule,
      restDay: sched.restDay,
      scheduleId: item.proposed_schedule_id,
      time_in_am: hhmmOf(item.proposed_time_in_am),
      time_out_am: hhmmOf(item.proposed_time_out_am),
      time_in_pm: hhmmOf(item.proposed_time_in_pm),
      time_out_pm: hhmmOf(item.proposed_time_out_pm),
      reason_in_am: item.proposed_in_am_reason as CorrectionReason | null,
      reason_out_am: item.proposed_out_am_reason as CorrectionReason | null,
      reason_in_pm: item.proposed_in_pm_reason as CorrectionReason | null,
      reason_out_pm: item.proposed_out_pm_reason as CorrectionReason | null,
      remarks: narrative,
    }),
  }));

  const { data: outcome, error: rpcError } = await supabase
    .schema("hris")
    .rpc("apply_attendance_correction", {
      p_request_id: requestId,
      p_reviewer_id: reviewer.id,
      p_reviewer_email: reviewer.email,
      p_rows: rows,
    });
  if (rpcError) throw rpcError;
  return outcome as "applied" | "needs_rebase";
}
