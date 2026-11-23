"use server";

// DTR Creator: attendance for several employees of one department at once.
//
// There is no new write path here. For each selected employee this files an
// ordinary DIRECT-APPLY correction request (migration 068) holding only CREATE
// items (migration 067), and applies it through applyCorrectionItems — the very
// code an approving reviewer runs. So every day this writes is source 'manual'
// + correction_locked, appears in Attendance Corrections, and is changed later
// only by filing a correction there. Requests from one submission share a
// dtr_batch_id (migration 110).
//
// Days that already have a record are skipped and reported, never overwritten.
//
// Access is canCreateDtr (src/lib/auth-helpers.ts): DTR Managers and Super
// Admins for any department, and Department Admins whose account has the DTR
// Creator switch on (migration 111) for their own department only. Those
// Department Admins apply on save like the reviewer roles do — that was the
// decision for this module — but their DATES stay inside the same
// payroll-month window their corrections are held to.

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentUser, type AuthUserData } from "@/lib/actions/auth-actions";
import { logAudit } from "@/lib/audit";
import {
  canCreateDtr,
  canCreateDtrAnyDepartment,
} from "@/lib/auth-helpers";
import { applyCorrectionItems } from "@/lib/attendance-correction-apply";
import { datesInRange } from "@/lib/attendance-corrections";
import {
  correctionWindow,
  correctionWindowError,
  type CorrectionWindow,
} from "@/lib/correction-window";
import { manilaToday } from "@/lib/format-date";
import {
  PROOF_BUCKET,
  proofRejection,
  sanitizeProofFilename,
} from "@/lib/attendance-proof";
import {
  planEmployeeDays,
  type DtrBatchEmployeeResult,
} from "@/lib/dtr-creator";
import {
  dtrBatchSchema,
  type DtrBatchInput,
} from "@/lib/validations/dtr-creator-schema";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returned rather than thrown — Next redacts thrown messages in production. */
export interface DtrCreatorError {
  error: string;
}

function messageOf(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) {
    return String((e as { message: unknown }).message);
  }
  return "Unexpected error";
}

async function requireCreator(): Promise<AuthUserData | null> {
  const user = await getCurrentUser();
  if (!user || !canCreateDtr(user)) return null;
  return user;
}

/** The department a caller may work in, or null when they may pick any. */
function lockedDepartmentOf(user: AuthUserData): string | null {
  return canCreateDtrAnyDepartment(user.roles) ? null : user.departmentId;
}

/** The payroll-month window, or null for roles with no date limit. */
function windowFor(user: AuthUserData): CorrectionWindow | null {
  return canCreateDtrAnyDepartment(user.roles)
    ? null
    : correctionWindow(manilaToday());
}

export interface DtrCreatorDepartment {
  id: string;
  name: string;
  code: string | null;
}

export interface DtrCreatorContext {
  departments: DtrCreatorDepartment[];
  /** Set when the caller is held to their own department. */
  lockedDepartmentId: string | null;
  window: CorrectionWindow | null;
}

export async function getDtrCreatorContext(): Promise<DtrCreatorContext> {
  const user = await requireCreator();
  if (!user) throw new Error("Unauthorized");
  const locked = lockedDepartmentOf(user);
  if (!canCreateDtrAnyDepartment(user.roles) && !locked) {
    throw new Error("Your account is not assigned to a department.");
  }

  const supabase = createAdminClient();
  let query = supabase
    .schema("hris")
    .from("departments")
    .select("id, name, code")
    .order("name");
  if (locked) query = query.eq("id", locked);
  const { data, error } = await query;
  if (error) throw error;
  return {
    departments: (data ?? []) as DtrCreatorDepartment[],
    lockedDepartmentId: locked,
    window: windowFor(user),
  };
}

export interface DtrCreatorEmployee {
  id: string;
  name: string;
  first_name: string;
  last_name: string;
  biometric_no: number | null;
  schedule_id: string | null;
}

/**
 * Active employees of a department, by EFFECTIVE department
 * (detailed_department_id ?? department_id) — the same rule the correction
 * module uses, since the office supervising the duty is the one that signs the
 * DTR.
 */
async function employeesOf(departmentId: string): Promise<DtrCreatorEmployee[]> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .schema("hris")
    .from("employees")
    .select("id, first_name, last_name, biometric_no, schedule_id")
    .eq("status", "active")
    .or(
      `detailed_department_id.eq.${departmentId},` +
        `and(detailed_department_id.is.null,department_id.eq.${departmentId})`,
    )
    .order("last_name")
    .order("first_name");
  if (error) throw error;
  return (data ?? []).map((e) => ({
    id: e.id as string,
    name: `${e.last_name}, ${e.first_name}`,
    first_name: e.first_name as string,
    last_name: e.last_name as string,
    biometric_no: (e.biometric_no as number | null) ?? null,
    schedule_id: (e.schedule_id as string | null) ?? null,
  }));
}

function departmentRefusal(user: AuthUserData, departmentId: string): string | null {
  if (!UUID_RE.test(departmentId)) return "Pick a department.";
  const locked = lockedDepartmentOf(user);
  if (canCreateDtrAnyDepartment(user.roles)) return null;
  if (!locked || locked !== departmentId) {
    return "You can only create DTRs for your own department.";
  }
  return null;
}

export async function getDtrCreatorEmployees(
  departmentId: string,
): Promise<DtrCreatorEmployee[] | DtrCreatorError> {
  const user = await requireCreator();
  if (!user) return { error: "You are not allowed to create DTRs." };
  const refusal = departmentRefusal(user, departmentId);
  if (refusal) return { error: refusal };
  try {
    return await employeesOf(departmentId);
  } catch (e) {
    console.error("[dtr-creator] getDtrCreatorEmployees", e);
    return { error: `Could not load employees: ${messageOf(e)}` };
  }
}

export interface DtrProofTicket {
  batchId: string;
  path: string;
  token: string;
}

export interface DtrProofRef {
  batchId: string;
  path: string;
  filename: string;
}

// One supporting document for the whole batch, uploaded by the browser straight
// into Storage (see createProofUploadTicket in attendance-correction-actions.ts
// for why it never rides in an action body). It lives under the BATCH, not an
// employee, and every request the batch files points at the same object.
export async function createDtrProofUploadTicket(
  filename: string,
): Promise<DtrProofTicket | DtrCreatorError> {
  const user = await requireCreator();
  if (!user) return { error: "You are not allowed to create DTRs." };
  const batchId = crypto.randomUUID();
  const path = `dtr-batches/${batchId}/${sanitizeProofFilename(filename)}`;
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage
    .from(PROOF_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !data) {
    console.error("[dtr-creator] createDtrProofUploadTicket", error);
    return {
      error: `Could not start the upload: ${error?.message ?? "no upload URL was issued"}`,
    };
  }
  return { batchId, path, token: data.token };
}

export interface DtrBatchResult {
  batchId: string;
  results: DtrBatchEmployeeResult[];
}

/** Runs `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export async function createDtrBatch(
  input: DtrBatchInput,
  proof: DtrProofRef | null,
): Promise<DtrBatchResult | DtrCreatorError> {
  const user = await requireCreator();
  if (!user) return { error: "You are not allowed to create DTRs." };

  const parsedResult = dtrBatchSchema.safeParse(input);
  if (!parsedResult.success) {
    return {
      error:
        parsedResult.error.issues[0]?.message ??
        "Some of those days are not filled in correctly.",
    };
  }
  const parsed = parsedResult.data;

  const refusal = departmentRefusal(user, parsed.department_id);
  if (refusal) return { error: refusal };

  // Every date is tested, not just the range ends — see assertCorrectionWindow.
  const window = windowFor(user);
  if (window) {
    for (const date of [parsed.date_from, parsed.date_to, ...parsed.items.map((i) => i.duty_date)]) {
      const err = correctionWindowError(date, window);
      if (err) return { error: err };
    }
  }

  const supabase = createAdminClient();
  const batchId = proof?.batchId ?? crypto.randomUUID();
  const path = proof?.path ?? null;
  const discardProof = async () => {
    if (path) await supabase.storage.from(PROOF_BUCKET).remove([path]);
  };

  // Verify the uploaded document rather than trusting the claim about it.
  let proofSize: number | null = null;
  let proofMime: string | null = null;
  if (proof && path) {
    if (!UUID_RE.test(proof.batchId) || !path.startsWith(`dtr-batches/${proof.batchId}/`)) {
      return { error: "That supporting document does not belong to this batch." };
    }
    const slash = path.lastIndexOf("/");
    const objectName = path.slice(slash + 1);
    const { data: objects } = await supabase.storage
      .from(PROOF_BUCKET)
      .list(path.slice(0, slash), { limit: 100, search: objectName });
    const object = (objects ?? []).find((o) => o.name === objectName);
    if (!object) {
      return { error: "The supporting document did not finish uploading. Attach it again." };
    }
    proofSize = (object.metadata?.size as number | undefined) ?? null;
    proofMime = (object.metadata?.mimetype as string | undefined) ?? null;
    const rejection = proofRejection(proofSize, proofMime);
    if (rejection) {
      await discardProof();
      return { error: rejection };
    }
  }

  // Reach: every selected employee must belong to the department right now.
  let roster: DtrCreatorEmployee[];
  try {
    roster = await employeesOf(parsed.department_id);
  } catch (e) {
    await discardProof();
    return { error: `Could not load employees: ${messageOf(e)}` };
  }
  const rosterById = new Map(roster.map((e) => [e.id, e]));
  const outside = parsed.employee_ids.filter((id) => !rosterById.has(id));
  if (outside.length > 0) {
    await discardProof();
    return {
      error: `${outside.length} selected employee(s) are no longer active in this department. Reload and pick again.`,
    };
  }

  const rangeDates = datesInRange(parsed.date_from, parsed.date_to);

  const processEmployee = async (employeeId: string): Promise<DtrBatchEmployeeResult> => {
    const name = rosterById.get(employeeId)!.name;
    try {
      const { data: existingRows, error: existErr } = await supabase
        .schema("hris")
        .from("attendance_logs")
        .select("date")
        .eq("employee_id", employeeId)
        .in("date", rangeDates);
      if (existErr) throw existErr;
      const plan = planEmployeeDays(
        parsed.items,
        new Set((existingRows ?? []).map((r) => r.date as string)),
      );
      if (plan.create.length === 0) {
        return {
          employeeId,
          name,
          status: "skipped",
          reason: plan.existing.length > 0
            ? "Every included day already has a record."
            : "Nothing was entered for the included days.",
          existing: plan.existing,
        };
      }

      const dates = plan.create.map((i) => i.duty_date).sort();
      const dateFrom = dates[0];
      const dateTo = dates[dates.length - 1];

      // A live correction over these dates holds them (acr_no_overlapping_pending);
      // say who filed it instead of failing on the constraint.
      const { data: blocking } = await supabase
        .schema("hris")
        .from("attendance_correction_requests")
        .select("date_from, date_to, requested_by_email")
        .eq("employee_id", employeeId)
        .in("status", ["pending", "needs_rebase"])
        .lte("date_from", dateTo)
        .gte("date_to", dateFrom)
        .limit(1)
        .maybeSingle();
      if (blocking) {
        return {
          employeeId,
          name,
          status: "skipped",
          reason:
            `A correction for ${blocking.date_from} to ${blocking.date_to} is awaiting review` +
            (blocking.requested_by_email ? ` (filed by ${blocking.requested_by_email})` : "") +
            ". Decide it in Attendance Corrections first.",
          existing: plan.existing,
        };
      }

      const requestId = crypto.randomUUID();
      const { error: reqError } = await supabase
        .schema("hris")
        .from("attendance_correction_requests")
        .insert({
          id: requestId,
          employee_id: employeeId,
          department_id: parsed.department_id,
          date_from: dateFrom,
          date_to: dateTo,
          reason: parsed.reason,
          direct_apply: true,
          dtr_batch_id: batchId,
          proof_path: path,
          proof_filename: proof?.filename ?? null,
          proof_mime: proofMime,
          proof_size: proofSize,
          requested_by: user.id,
          requested_by_email: user.email,
        });
      if (reqError) {
        if (reqError.message.includes("acr_no_overlapping_pending")) {
          return {
            employeeId,
            name,
            status: "skipped",
            reason: "A correction covering these dates was filed meanwhile.",
            existing: plan.existing,
          };
        }
        throw reqError;
      }

      // From here the request row exists and is 'pending', holding the dates.
      // Any failure releases it as 'cancelled' rather than leaving a request the
      // filer may not be able to act on — the RPC is transactional, so nothing
      // reached the DTR.
      const release = async (note: string) => {
        await supabase
          .schema("hris")
          .from("attendance_correction_requests")
          .update({
            status: "cancelled",
            review_notes: note,
            updated_at: new Date().toISOString(),
          })
          .eq("id", requestId);
      };

      const { error: itemError } = await supabase
        .schema("hris")
        .from("attendance_correction_items")
        .insert(
          plan.create.map((i) => ({
            request_id: requestId,
            duty_date: i.duty_date,
            attendance_log_id: null,
            disposition: "update",
            proposed_schedule_id: i.proposed_schedule_id,
            proposed_time_in_am: i.time_in_am,
            proposed_time_out_am: i.time_out_am,
            proposed_time_in_pm: i.time_in_pm,
            proposed_time_out_pm: i.time_out_pm,
            proposed_in_am_reason: i.reason_in_am,
            proposed_out_am_reason: i.reason_out_am,
            proposed_in_pm_reason: i.reason_in_pm,
            proposed_out_pm_reason: i.reason_out_pm,
            // A CREATE item has no prior row — see createCorrectionRequest.
            before: {},
          })),
        );
      if (itemError) {
        await release("DTR Creator: the days could not be saved.");
        throw itemError;
      }

      let outcome: "applied" | "needs_rebase";
      try {
        outcome = await applyCorrectionItems(
          supabase,
          requestId,
          employeeId,
          { id: user.id, email: user.email },
          parsed.reason,
        );
      } catch (e) {
        await release("DTR Creator: writing the days failed.");
        throw e;
      }
      if (outcome === "needs_rebase") {
        await release("DTR Creator: attendance was recorded for one of these days meanwhile.");
        return {
          employeeId,
          name,
          status: "skipped",
          reason: "Attendance was recorded for one of these days while saving. Run it again for this employee.",
          existing: plan.existing,
        };
      }

      await logAudit({
        userId: user.id,
        userEmail: user.email,
        action: "dtr_created",
        tableName: "attendance_correction_requests",
        recordId: requestId,
        newValues: {
          dtr_batch_id: batchId,
          employee_id: employeeId,
          department_id: parsed.department_id,
          date_from: dateFrom,
          date_to: dateTo,
          days: plan.create.length,
          skipped_existing: plan.existing,
          has_proof: !!proof,
        },
      });

      return {
        employeeId,
        name,
        status: "created",
        days: plan.create.length,
        existing: plan.existing,
        requestId,
      };
    } catch (e) {
      console.error("[dtr-creator] createDtrBatch", employeeId, e);
      return { employeeId, name, status: "failed", reason: messageOf(e) };
    }
  };

  const results = await mapLimited(parsed.employee_ids, 4, processEmployee);

  // A document nothing ended up referencing would sit in the bucket forever.
  if (!results.some((r) => r.status === "created")) await discardProof();

  revalidatePath("/attendance-corrections");
  revalidatePath("/attendance");
  revalidatePath("/dtr");
  return { batchId, results };
}
