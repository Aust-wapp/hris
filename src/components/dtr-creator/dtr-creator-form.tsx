"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckCircle2, CircleSlash, Loader2, XCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createDtrBatch,
  createDtrProofUploadTicket,
  getDtrCreatorEmployees,
  type DtrBatchResult,
  type DtrCreatorDepartment,
  type DtrCreatorEmployee,
  type DtrProofRef,
} from "@/lib/actions/dtr-creator-actions";
import type { ScheduleRow } from "@/lib/actions/schedule-actions";
import type { CorrectionItemFormValues } from "@/lib/validations/attendance-correction-schema";
import { createClient } from "@/lib/supabase/client";
import {
  ALLOWED_PROOF_TYPES,
  PROOF_BUCKET,
  proofRejection,
} from "@/lib/attendance-proof";
import {
  datesInRange,
  isBlankCreateItem,
  weekendReasonFor,
} from "@/lib/attendance-corrections";
import {
  NO_REASON,
  scheduleHoursLabel,
  scheduleOptions,
  setSlotReason,
  settleAbsentPairs,
  type SlotName,
} from "@/lib/correction-draft";
import {
  dayOfWeekFor,
  DEFAULT_SCHEDULE,
  hasBreak,
  type ScheduleLike,
} from "@/lib/attendance-schedule";
import { buildAttendanceRecord, dayReasonFor } from "@/lib/attendance-record";
import {
  correctionWindowError,
  describeCorrectionWindow,
  type CorrectionWindow,
} from "@/lib/correction-window";
import {
  CORRECTION_REASONS,
  NO_TIME_REASON_LABELS,
  type CorrectionReason,
} from "@/lib/constants";
import { daysInRange, MAX_DTR_BATCH_DAYS } from "@/lib/dtr-creator";
import { formatManilaShortDate } from "@/lib/format-date";
import { cn } from "@/lib/utils";

// "Each employee's own schedule" — base-ui Select cannot hold null.
const INHERIT = "__inherit__";

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SLOTS = [
  ["in_am", "time_in_am", "reason_in_am"],
  ["out_am", "time_out_am", "reason_out_am"],
  ["in_pm", "time_in_pm", "reason_in_pm"],
  ["out_pm", "time_out_pm", "reason_out_pm"],
] as const;

interface DayDraft {
  include: boolean;
  scheduleId: string;
  time_in_am: string;
  time_out_am: string;
  time_in_pm: string;
  time_out_pm: string;
  reason_in_am: string;
  reason_out_am: string;
  reason_in_pm: string;
  reason_out_pm: string;
}

type SlotValues = Omit<DayDraft, "include">;

function blankSlots(scheduleId = INHERIT): SlotValues {
  return {
    scheduleId,
    time_in_am: "",
    time_out_am: "",
    time_in_pm: "",
    time_out_pm: "",
    reason_in_am: NO_REASON,
    reason_out_am: NO_REASON,
    reason_in_pm: NO_REASON,
    reason_out_pm: NO_REASON,
  };
}

// A weekend defaults to SATURDAY / SUNDAY so it reads as a rest day, same as
// the correction wizard. Nothing is included until the user says so.
function draftFor(date: string): DayDraft {
  const weekend = weekendReasonFor(date);
  const base = blankSlots();
  return weekend
    ? {
        ...base,
        include: false,
        reason_in_am: weekend,
        reason_out_am: weekend,
        reason_in_pm: weekend,
        reason_out_pm: weekend,
      }
    : { ...base, include: false };
}

const nullIfBlank = (v: string) => (v.trim() === "" ? null : v.trim());
const asReason = (v: string) => (v === NO_REASON ? null : (v as CorrectionReason));

const REASON_ITEMS: { value: string; label: string }[] = [
  { value: NO_REASON, label: "Set time" },
  ...CORRECTION_REASONS.map((r) => ({ value: r, label: NO_TIME_REASON_LABELS[r] })),
];

export function DtrCreatorForm({
  departments,
  lockedDepartmentId,
  correctionWindow,
  schedules,
}: {
  departments: DtrCreatorDepartment[];
  lockedDepartmentId: string | null;
  correctionWindow: CorrectionWindow | null;
  schedules: ScheduleRow[];
}) {
  const [departmentId, setDepartmentId] = useState(lockedDepartmentId ?? "");
  const [employees, setEmployees] = useState<DtrCreatorEmployee[] | null>(null);
  const [loadingEmployees, setLoadingEmployees] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [dates, setDates] = useState<string[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DayDraft>>({});
  const [fill, setFill] = useState<SlotValues>(blankSlots());

  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<DtrBatchResult | null>(null);

  const departmentItems = useMemo(
    () =>
      departments.map((d) => ({
        value: d.id,
        label: d.code ? `${d.code} — ${d.name}` : d.name,
      })),
    [departments],
  );

  // ── Schedules ────────────────────────────────────────────────────────────
  const scheduleFor = useCallback(
    (scheduleId: string): ScheduleLike | null =>
      scheduleId === INHERIT ? null : (schedules.find((s) => s.id === scheduleId) ?? null),
    [schedules],
  );
  // With no pin, each employee is measured against their own schedule, which
  // differs per person. The grid shows break slots unless a pinned schedule
  // has none.
  const withBreak = useCallback(
    (scheduleId: string) => hasBreak(scheduleFor(scheduleId) ?? DEFAULT_SCHEDULE),
    [scheduleFor],
  );
  const { scheduleItems, scheduleChoices } = useMemo(() => {
    const inherit = { value: INHERIT, label: "Each employee's own schedule" };
    const { all, choices } = scheduleOptions(schedules);
    return { scheduleItems: [inherit, ...all], scheduleChoices: [inherit, ...choices] };
  }, [schedules]);

  const fitToSchedule = useCallback(
    <T extends SlotValues>(d: T): T => {
      const brk = withBreak(d.scheduleId);
      return settleAbsentPairs(
        brk
          ? d
          : { ...d, time_out_am: "", time_in_pm: "", reason_out_am: NO_REASON, reason_in_pm: NO_REASON },
        brk,
      );
    },
    [withBreak],
  );

  // ── Department and employees ─────────────────────────────────────────────
  const loadEmployees = async (id: string) => {
    setLoadingEmployees(true);
    setEmployees(null);
    setSelected(new Set());
    const res = await getDtrCreatorEmployees(id);
    if ("error" in res) toast.error(res.error);
    else setEmployees(res);
    setLoadingEmployees(false);
  };

  const filteredEmployees = useMemo(() => {
    if (!employees) return [];
    const q = search.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        `${e.first_name} ${e.last_name}`.toLowerCase().includes(q) ||
        String(e.biometric_no ?? "").includes(q),
    );
  }, [employees, search]);

  const toggleEmployee = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const selectFiltered = (on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const e of filteredEmployees) {
        if (on) next.add(e.id);
        else next.delete(e.id);
      }
      return next;
    });

  // ── Days ─────────────────────────────────────────────────────────────────
  const loadDays = () => {
    if (!dateFrom || !dateTo) {
      toast.error("Pick a date range first.");
      return;
    }
    if (dateTo < dateFrom) {
      toast.error("The end date must not precede the start date.");
      return;
    }
    if (daysInRange(dateFrom, dateTo) > MAX_DTR_BATCH_DAYS) {
      toast.error(`Pick a range of at most ${MAX_DTR_BATCH_DAYS} days.`);
      return;
    }
    if (correctionWindow) {
      const err =
        correctionWindowError(dateFrom, correctionWindow) ??
        correctionWindowError(dateTo, correctionWindow);
      if (err) {
        toast.error(err);
        return;
      }
    }
    const list = datesInRange(dateFrom, dateTo);
    setDates(list);
    setDrafts(Object.fromEntries(list.map((d) => [d, draftFor(d)])));
    setResult(null);
  };

  const patch = (date: string, values: Partial<DayDraft>) =>
    setDrafts((prev) => ({ ...prev, [date]: { ...prev[date], ...values } }));

  const setIncluded = (pick: (date: string) => boolean) =>
    setDrafts((prev) =>
      Object.fromEntries(Object.entries(prev).map(([date, d]) => [date, { ...d, include: pick(date) }])),
    );

  const includedDates = useMemo(
    () => (dates ?? []).filter((d) => drafts[d]?.include),
    [dates, drafts],
  );

  const applyFill = () => {
    if (includedDates.length === 0) {
      toast.error("Include at least one day first.");
      return;
    }
    const fitted = fitToSchedule(fill);
    setDrafts((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([date, d]) => [date, d.include ? { ...d, ...fitted } : d]),
      ),
    );
    toast.success(`Applied to ${includedDates.length} day(s).`);
  };

  const itemFor = (date: string): CorrectionItemFormValues => {
    const d = fitToSchedule(drafts[date]);
    return {
      duty_date: date,
      attendance_log_id: null,
      disposition: "update",
      proposed_schedule_id: d.scheduleId === INHERIT ? null : d.scheduleId,
      time_in_am: nullIfBlank(d.time_in_am),
      time_out_am: nullIfBlank(d.time_out_am),
      time_in_pm: nullIfBlank(d.time_in_pm),
      time_out_pm: nullIfBlank(d.time_out_pm),
      reason_in_am: asReason(d.reason_in_am),
      reason_out_am: asReason(d.reason_out_am),
      reason_in_pm: asReason(d.reason_in_pm),
      reason_out_pm: asReason(d.reason_out_pm),
    };
  };

  // What a day will read as. Exact for a reason or a pinned schedule; with each
  // employee's own schedule the late/undertime differs per person, so only the
  // reason (if any) can be said up front.
  const previewFor = (date: string, d: DayDraft) => {
    const item = itemFor(date);
    if (isBlankCreateItem(item)) return "nothing entered — skipped";
    const fields = {
      time_in_am: item.time_in_am,
      time_out_am: item.time_out_am,
      time_in_pm: item.time_in_pm,
      time_out_pm: item.time_out_pm,
      reason_in_am: item.reason_in_am,
      reason_out_am: item.reason_out_am,
      reason_in_pm: item.reason_in_pm,
      reason_out_pm: item.reason_out_pm,
    };
    const dayReason = dayReasonFor(fields);
    if (dayReason) return NO_TIME_REASON_LABELS[dayReason as CorrectionReason];
    const sched = scheduleFor(d.scheduleId);
    if (!sched) return "measured against each employee's schedule";
    const record = buildAttendanceRecord("preview", date, fields, sched);
    if (record.is_absent) return "absent";
    const parts: string[] = [];
    if (record.late_minutes > 0) parts.push(`late ${record.late_minutes}m`);
    if (record.undertime_minutes > 0) parts.push(`UT ${record.undertime_minutes}m`);
    return parts.length > 0 ? parts.join(" · ") : "on time";
  };

  // ── Submit ───────────────────────────────────────────────────────────────
  const handleSubmit = async () => {
    if (!departmentId) return void toast.error("Pick a department.");
    if (selected.size === 0) return void toast.error("Select at least one employee.");
    const items = includedDates.map(itemFor).filter((i) => !isBlankCreateItem(i));
    if (items.length === 0) {
      return void toast.error("None of the included days has a time or a reason.");
    }
    if (reason.trim().length < 5) return void toast.error("Describe the reason for these entries.");
    if (file) {
      const rejection = proofRejection(file.size, file.type);
      if (rejection) return void toast.error(rejection);
    }

    setSubmitting(true);
    try {
      let proofRef: DtrProofRef | null = null;
      if (file) {
        const ticket = await createDtrProofUploadTicket(file.name);
        if ("error" in ticket) throw new Error(ticket.error);
        const { error: uploadError } = await createClient()
          .storage.from(PROOF_BUCKET)
          .uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type });
        if (uploadError) {
          throw new Error(`Could not upload the supporting document: ${uploadError.message}`);
        }
        proofRef = { batchId: ticket.batchId, path: ticket.path, filename: file.name };
      }

      const res = await createDtrBatch(
        {
          department_id: departmentId,
          employee_ids: [...selected],
          date_from: dateFrom,
          date_to: dateTo,
          reason: reason.trim(),
          items,
        },
        proofRef,
      );
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setResult(res);
      const created = res.results.filter((r) => r.status === "created").length;
      if (created === res.results.length) {
        toast.success(`DTR created for ${created} employee${created === 1 ? "" : "s"}.`);
      } else {
        toast.warning(
          `DTR created for ${created} of ${res.results.length} employees. See the results below.`,
        );
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the DTRs.");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Slot editor, shared by the fill row and every day row ────────────────
  const slotCells = (
    values: SlotValues,
    brk: boolean,
    disabled: boolean,
    onTime: (key: (typeof SLOTS)[number][1], v: string) => void,
    onReason: (slot: SlotName, v: string) => void,
    label: string,
  ) =>
    SLOTS.map(([slot, timeKey, reasonKey], idx) => {
      if ((idx === 1 || idx === 2) && !brk) {
        return (
          <td key={timeKey} className="py-3 pr-2">
            <div className="w-[110px] pt-2 text-center text-[11px] italic text-muted-foreground">
              no break
            </div>
          </td>
        );
      }
      return (
        <td key={timeKey} className="py-3 pr-2">
          <div className="space-y-1">
            {!brk && (
              <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {idx === 0 ? "In" : "Out"}
              </div>
            )}
            {values[reasonKey] === NO_REASON && (
              <Input
                type="time"
                className="w-[110px]"
                value={values[timeKey]}
                disabled={disabled}
                aria-label={`${slot} time, ${label}`}
                onChange={(e) => onTime(timeKey, e.target.value)}
              />
            )}
            <Select
              value={values[reasonKey]}
              items={REASON_ITEMS}
              onValueChange={(v) => onReason(slot, v as string)}
              disabled={disabled}
            >
              <SelectTrigger className="w-[110px] h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_ITEMS.map((r) => (
                  <SelectItem key={r.value} value={r.value}>
                    {r.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </td>
      );
    });

  const scheduleSelect = (value: string, onChange: (v: string) => void, disabled = false) => (
    <Select value={value} items={scheduleItems} onValueChange={(v) => onChange(v as string)} disabled={disabled}>
      <SelectTrigger className="w-[230px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {scheduleChoices.map((s) => (
          <SelectItem key={s.value} value={s.value}>
            {s.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const ready = !!departmentId && selected.size > 0 && !!dates && dates.length > 0;

  return (
    <div className="space-y-6">
      {/* 1. Department and employees */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">1. Department and employees</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label>Department</Label>
              <Select
                value={departmentId}
                items={departmentItems}
                disabled={!!lockedDepartmentId}
                onValueChange={(v) => {
                  setDepartmentId(v as string);
                  setEmployees(null);
                  setSelected(new Set());
                  setResult(null);
                }}
              >
                <SelectTrigger className="w-[320px]">
                  <SelectValue placeholder="Select a department" />
                </SelectTrigger>
                <SelectContent>
                  {departmentItems.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {d.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button
              size="sm"
              disabled={!departmentId || loadingEmployees}
              onClick={() => loadEmployees(departmentId)}
            >
              {loadingEmployees && <Loader2 className="h-4 w-4 animate-spin" />}
              Load employees
            </Button>
          </div>

          {employees && (
            <div className="space-y-3">
              {employees.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active employees are assigned or detailed to this department.
                </p>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      placeholder="Search name or biometric no."
                      className="w-[280px]"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <Button variant="outline" size="sm" onClick={() => selectFiltered(true)}>
                      Select {search ? "shown" : "all"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => selectFiltered(false)}>
                      Clear {search ? "shown" : "all"}
                    </Button>
                    <span className="ml-auto text-sm text-muted-foreground">
                      {selected.size} of {employees.length} selected
                    </span>
                  </div>
                  <div className="max-h-80 overflow-y-auto rounded-md border">
                    <ul className="divide-y">
                      {filteredEmployees.map((e) => (
                        <li key={e.id}>
                          <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50">
                            <Checkbox
                              checked={selected.has(e.id)}
                              onCheckedChange={(v) => toggleEmployee(e.id, !!v)}
                            />
                            <span className="flex-1">{e.name}</span>
                            {e.biometric_no != null && (
                              <span className="text-xs text-muted-foreground">#{e.biometric_no}</span>
                            )}
                          </label>
                        </li>
                      ))}
                      {filteredEmployees.length === 0 && (
                        <li className="px-3 py-4 text-center text-sm text-muted-foreground">
                          No employee matches.
                        </li>
                      )}
                    </ul>
                  </div>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 2. Period */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">2. Period</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {correctionWindow && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
              You can create DTRs for{" "}
              <span className="font-medium text-foreground">
                {describeCorrectionWindow(correctionWindow)}
              </span>
              , the same payroll months your attendance corrections cover.
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-2">
              <Label htmlFor="dtr_from">From</Label>
              <Input
                id="dtr_from"
                type="date"
                min={correctionWindow?.reopened?.[0]?.from ?? correctionWindow?.from}
                max={correctionWindow?.to}
                value={dateFrom}
                onChange={(e) => {
                  setDateFrom(e.target.value);
                  setDates(null);
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dtr_to">To</Label>
              <Input
                id="dtr_to"
                type="date"
                min={correctionWindow?.reopened?.[0]?.from ?? correctionWindow?.from}
                max={correctionWindow?.to}
                value={dateTo}
                onChange={(e) => {
                  setDateTo(e.target.value);
                  setDates(null);
                }}
              />
            </div>
            <Button size="sm" onClick={loadDays}>
              Load days
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Up to {MAX_DTR_BATCH_DAYS} days at a time.
          </p>
        </CardContent>
      </Card>

      {/* 3. Days */}
      {dates && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              3. Days
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {includedDates.length} of {dates.length} included
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => setIncluded(() => true)}>
                Include all
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIncluded((d) => !weekendReasonFor(d))}
              >
                Weekdays only
              </Button>
              <Button variant="outline" size="sm" onClick={() => setIncluded(() => false)}>
                Include none
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[1000px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="w-10 py-2" />
                    <th className="py-2 pr-3">Date</th>
                    <th className="py-2 pr-3">Will read as</th>
                    <th className="py-2 pr-3">Schedule</th>
                    <th className="py-2 pr-2">AM In</th>
                    <th className="py-2 pr-2">AM Out</th>
                    <th className="py-2 pr-2">PM In</th>
                    <th className="py-2 pr-2">PM Out</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Fill row: set once, copy onto every included day. */}
                  <tr className="border-b bg-sky-500/5 align-top">
                    <td className="py-3" />
                    <td className="py-3 pr-3 whitespace-nowrap">
                      <div className="font-medium">Fill all included</div>
                      <Button size="xs" variant="secondary" className="mt-1" onClick={applyFill}>
                        Apply
                      </Button>
                    </td>
                    <td className="py-3 pr-3 text-xs text-muted-foreground">
                      Copies this schedule and these slots onto every included day.
                    </td>
                    <td className="py-3 pr-3">
                      {scheduleSelect(fill.scheduleId, (v) =>
                        setFill((f) => fitToSchedule({ ...f, scheduleId: v })),
                      )}
                    </td>
                    {slotCells(
                      fill,
                      withBreak(fill.scheduleId),
                      false,
                      (key, v) => setFill((f) => ({ ...f, [key]: v })),
                      (slot, v) =>
                        setFill((f) => setSlotReason(f, slot, v, withBreak(f.scheduleId))),
                      "fill row",
                    )}
                  </tr>

                  {dates.map((date) => {
                    const d = drafts[date];
                    if (!d) return null;
                    const dow = dayOfWeekFor(date);
                    const isWeekend = dow === 0 || dow === 6;
                    return (
                      <tr
                        key={date}
                        className={cn("border-b align-top", !d.include && "opacity-75", isWeekend && "bg-muted/30")}
                      >
                        <td className="py-3">
                          <Checkbox
                            checked={d.include}
                            onCheckedChange={(v) => patch(date, { include: !!v })}
                            aria-label={`Include ${date}`}
                          />
                        </td>
                        <td className="py-3 pr-3 whitespace-nowrap">
                          <div className="font-medium">{formatManilaShortDate(date)}</div>
                          <div className="text-[11px] text-muted-foreground">{DAY_NAMES[dow]}</div>
                        </td>
                        <td className="py-3 pr-3 text-xs">
                          {d.include ? (
                            <span className="font-medium">→ {previewFor(date, d)}</span>
                          ) : (
                            <span className="text-muted-foreground">not included</span>
                          )}
                        </td>
                        <td className="py-3 pr-3">
                          {scheduleSelect(
                            d.scheduleId,
                            (v) =>
                              setDrafts((prev) => ({
                                ...prev,
                                [date]: fitToSchedule({ ...prev[date], scheduleId: v }),
                              })),
                            !d.include,
                          )}
                        </td>
                        {slotCells(
                          d,
                          withBreak(d.scheduleId),
                          !d.include,
                          (key, v) => patch(date, { [key]: v } as Partial<DayDraft>),
                          (slot, v) =>
                            setDrafts((prev) => ({
                              ...prev,
                              [date]: setSlotReason(prev[date], slot, v, withBreak(prev[date].scheduleId)),
                            })),
                          date,
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              The same days are written for every selected employee. Each slot
              takes either a time or a reason. Left on{" "}
              <strong>each employee&apos;s own schedule</strong>, a day is
              measured against that person&apos;s schedule, so late and undertime
              can differ between them. A day an employee already has a record for
              is skipped for that employee and never overwritten — change it in
              Attendance Corrections. Default hours:{" "}
              {scheduleHoursLabel(DEFAULT_SCHEDULE)}.
            </p>
          </CardContent>
        </Card>
      )}

      {/* 4. Justification */}
      {dates && dates.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">4. Justification</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="dtr_reason">Reason</Label>
              <Textarea
                id="dtr_reason"
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Field vaccination duty per Office Order 2026-120"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="dtr_proof">
                Supporting document
                <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="dtr_proof"
                type="file"
                accept={ALLOWED_PROOF_TYPES.join(",")}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">
                PDF, JPEG or PNG, up to 10 MB. One document is kept with every
                employee&apos;s record in this batch.
              </p>
            </div>
            <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-700">
              This applies as soon as you save — there is no approval step. The
              days are written, locked against biometric re-imports, and recorded
              against your name. To change one afterwards, file an attendance
              correction.
            </p>
            <div className="flex items-center justify-end gap-3">
              {ready && (
                <span className="text-sm text-muted-foreground">
                  {selected.size} employee{selected.size === 1 ? "" : "s"} ×{" "}
                  {includedDates.length} day{includedDates.length === 1 ? "" : "s"}
                </span>
              )}
              <Button onClick={handleSubmit} disabled={submitting || !ready}>
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? "Creating…" : "Create DTR"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Results */}
      {result && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Results</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {result.results.map((r) => (
                <li key={r.employeeId} className="flex items-start gap-3 py-2">
                  {r.status === "created" ? (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  ) : r.status === "skipped" ? (
                    <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  ) : (
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                  )}
                  <div className="flex-1">
                    <div className="font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.status === "created" ? (
                        <>
                          {r.days} day{r.days === 1 ? "" : "s"} created
                          {r.existing.length > 0 &&
                            ` · ${r.existing.length} already recorded, skipped (${r.existing.map(formatManilaShortDate).join(", ")})`}
                        </>
                      ) : (
                        r.reason
                      )}
                    </div>
                  </div>
                  {r.status === "created" && (
                    <Link
                      href={`/attendance-corrections/${r.requestId}`}
                      className="text-xs text-primary underline-offset-4 hover:underline"
                    >
                      View
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
