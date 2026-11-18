"use client";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { MonetizationContext } from "@/lib/actions/leave-actions";
import {
  MONETIZATION_TYPE_LABELS,
  REGULAR_MAX_DAYS_PER_YEAR,
  REGULAR_MIN_DAYS,
  REGULAR_MIN_VL_BALANCE,
  REGULAR_MIN_VL_RETAINED,
  SPECIAL_MONETIZATION_REASONS,
  formatPeso,
  monetizationAmount,
  monetizationCharge,
  monetizationError,
  monetizationShare,
  type MonetizationType,
} from "@/lib/leave-monetization";

export interface MonetizationDraft {
  type: MonetizationType;
  days: string;
  /** One of SPECIAL_MONETIZATION_REASONS, special only. */
  specialReason: string;
  /** Free-text explanation, required for special. */
  explanation: string;
}

export const EMPTY_MONETIZATION_DRAFT: MonetizationDraft = {
  type: "regular",
  days: "",
  specialReason: "",
  explanation: "",
};

/** The reason text stored on the application. */
export function monetizationReasonText(d: MonetizationDraft): string | null {
  const parts = [d.type === "special" ? d.specialReason : "", d.explanation.trim()].filter(Boolean);
  return parts.length ? parts.join(" — ") : null;
}

/** Why the draft cannot be submitted yet, or null. */
export function monetizationDraftError(
  d: MonetizationDraft,
  ctx: MonetizationContext | null,
): string | null {
  if (!ctx) return "Loading leave credits…";
  const days = Number(d.days);
  const rule = monetizationError({ type: d.type, days, ...ctx });
  if (rule) return rule;
  if (d.type === "special") {
    if (!d.specialReason) return "Choose the justifiable reason for special monetization.";
    if (!d.explanation.trim()) return "Explain the reason for special monetization.";
  }
  return null;
}

const fmt = (n: number) => parseFloat(n.toFixed(3)).toString();

/** CS Form 6 §6.A–6.D for a monetization of leave credits. */
export function LeaveMonetizationSection({
  draft,
  onChange,
  context,
  contextError,
}: {
  draft: MonetizationDraft;
  onChange: (d: MonetizationDraft) => void;
  context: MonetizationContext | null;
  contextError: string | null;
}) {
  const set = (patch: Partial<MonetizationDraft>) => onChange({ ...draft, ...patch });
  const days = Number(draft.days);
  const hasDays = draft.days !== "" && Number.isFinite(days) && days > 0;
  const error = hasDays ? monetizationDraftError(draft, context) : null;
  const charge = context && hasDays ? monetizationCharge(draft.type, days, context.vlBalance) : null;
  const regularLeft = context ? Math.max(0, REGULAR_MAX_DAYS_PER_YEAR - context.regularDaysThisYear) : 0;

  return (
    <>
      {/* 6.A */}
      <div className="px-4 py-3 border-b">
        <Label className="text-xs text-muted-foreground mb-2 block">6.A TYPE OF LEAVE TO BE AVAILED OF</Label>
        {contextError ? (
          <p className="text-xs text-destructive">{contextError}</p>
        ) : !context ? (
          <p className="text-xs text-muted-foreground italic">Loading leave credits…</p>
        ) : (
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
            <p>
              Vacation Leave: <span className="font-semibold">{fmt(context.vlBalance)}</span> day(s)
            </p>
            <p>
              Sick Leave: <span className="font-semibold">{fmt(context.slBalance)}</span> day(s)
            </p>
            <p className="col-span-2 text-xs text-muted-foreground">
              Credits are charged to Vacation Leave first. Only a special monetization uses Sick Leave,
              and only for the days Vacation Leave cannot cover.
            </p>
          </div>
        )}
      </div>

      {/* 6.B */}
      <div className="px-4 py-3 border-b space-y-3">
        <Label className="text-xs text-muted-foreground block">6.B DETAILS OF LEAVE</Label>
        <p className="text-sm">
          Other purpose: <span className="font-medium">☑ Monetization of Leave Credits</span>
        </p>
        <div className="flex flex-col gap-1.5">
          {(["regular", "special"] as const).map((t) => (
            <label
              key={t}
              className={cn(
                "flex items-start gap-2 cursor-pointer rounded-md px-2 py-1.5 -mx-2 text-sm",
                draft.type === t ? "bg-primary/10" : "hover:bg-muted",
              )}
            >
              <input
                type="radio"
                name="monetization_type"
                checked={draft.type === t}
                onChange={() => set({ type: t })}
                className="accent-primary mt-1"
              />
              <span>
                <span className="font-medium">{MONETIZATION_TYPE_LABELS[t]}</span>
                <span className="block text-xs text-muted-foreground">
                  {t === "regular"
                    ? `Needs at least ${REGULAR_MIN_VL_BALANCE} days of VL. Minimum ${REGULAR_MIN_DAYS} days, up to ${REGULAR_MAX_DAYS_PER_YEAR} days a year, keeping at least ${REGULAR_MIN_VL_RETAINED} days of VL.` +
                      (context ? ` ${fmt(regularLeft)} day(s) left this year.` : "")
                    : "50% or more of the accumulated VL and SL, for a valid and justifiable reason. At the discretion of the head of agency and subject to available funds."}
                </span>
              </span>
            </label>
          ))}
        </div>

        {draft.type === "special" && (
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground block">Justifiable reason</Label>
            <div className="flex flex-col gap-1">
              {SPECIAL_MONETIZATION_REASONS.map((r) => (
                <label key={r} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="special_reason"
                    checked={draft.specialReason === r}
                    onChange={() => set({ specialReason: r })}
                    className="accent-primary mt-1"
                  />
                  {r}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 6.C */}
      <div className="px-4 py-3 border-b">
        <Label className="text-xs text-muted-foreground mb-2 block">6.C NUMBER OF WORKING DAYS APPLIED FOR</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.5"
            value={draft.days}
            onChange={(e) => set({ days: e.target.value })}
            placeholder={draft.type === "regular" ? `${REGULAR_MIN_DAYS}–${REGULAR_MAX_DAYS_PER_YEAR}` : "Days"}
            className="w-32"
          />
          <span className="text-sm text-muted-foreground">day(s) to monetize</span>
        </div>
        {error && <p className="text-xs text-destructive mt-2">{error}</p>}
        {charge && context && !error && (
          <div className="mt-3 rounded-md border bg-muted/30 p-3 text-sm space-y-1">
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">VL {fmt(charge.vlDays)}</Badge>
              {charge.slDays > 0 && <Badge variant="secondary">SL {fmt(charge.slDays)}</Badge>}
              <Badge variant="outline">
                {monetizationShare(days, context.vlBalance, context.slBalance)}% of VL + SL
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Left after approval: VL {fmt(context.vlBalance - charge.vlDays)}, SL{" "}
              {fmt(context.slBalance - charge.slDays)}
            </p>
            <p>
              Estimated amount:{" "}
              {context.monthlySalary != null ? (
                <>
                  <span className="font-semibold">{formatPeso(monetizationAmount(context.monthlySalary, days))}</span>
                  <span className="text-xs text-muted-foreground">
                    {" "}({formatPeso(context.monthlySalary)} monthly salary × {fmt(days)} × 0.0481927)
                  </span>
                </>
              ) : (
                <span className="text-muted-foreground">no salary on record</span>
              )}
            </p>
          </div>
        )}
      </div>

      {/* 6.D */}
      <div className="px-4 py-3 border-b">
        <Label className="text-xs text-muted-foreground mb-2 block">6.D COMMUTATION</Label>
        <p className="text-sm">☑ Requested</p>
      </div>

      {/* Reason */}
      <div className="px-4 py-3">
        <Label className="text-xs text-muted-foreground mb-2 block">
          {draft.type === "special" ? "EXPLANATION (Required)" : "REASON / REMARKS (Optional)"}
        </Label>
        <Textarea
          value={draft.explanation}
          onChange={(e) => set({ explanation: e.target.value })}
          placeholder={
            draft.type === "special"
              ? "e.g. hospitalization of spouse, with attached medical certificate"
              : "Additional remarks..."
          }
          rows={2}
        />
      </div>
    </>
  );
}
