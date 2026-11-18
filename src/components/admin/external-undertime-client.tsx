"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { DataTable } from "@/components/tables/data-table";
import {
  MONTH_LABELS,
  RECORD_STATUS_LABELS,
  externalPlanColumns,
  externalRecordColumns,
} from "@/components/tables/columns/external-undertime-columns";
import { CATEGORY_LABELS, type ExternalCategory } from "@/lib/external-undertime";
import {
  deleteExternalUndertime,
  importExternalUndertime,
  previewExternalUndertime,
  updateExternalUndertime,
  type ExternalPlan,
  type ExternalUndertimeRecord,
} from "@/lib/actions/external-undertime-actions";

const fmtDays = (d: number) => parseFloat(d.toFixed(3)).toString();

const CATEGORY_ORDER: ExternalCategory[] = [
  "apply",
  "hold",
  "skip_hris_has_logs",
  "skip_after_separation",
  "skip_not_plantilla",
  "skip_unmatched",
];

const CATEGORY_HELP: Record<ExternalCategory, string> = {
  apply: "Charged to VL on import.",
  hold: "Saved, charges nothing until HR reviews it in Records.",
  skip_hris_has_logs: "HRIS has biometrics that month; its own DTR is used.",
  skip_after_separation: "Months after the employee's separation date.",
  skip_not_plantilla: "Job order / COS staff have no leave credits.",
  skip_unmatched: "No unique employee by ID or full name. Fix the name or ID in HRIS, then re-import.",
};

export function ExternalUndertimeClient({
  year,
  records,
}: {
  year: number;
  records: ExternalUndertimeRecord[];
}) {
  const router = useRouter();
  // Controlled: the initial pick depends on `records`, which changes after an
  // import refresh, and an uncontrolled Tabs may not change its default later.
  const [tab, setTab] = useState(records.length > 0 ? "records" : "import");

  /* ---------------------------- Import tab ---------------------------- */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<ExternalPlan | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);

  const runPreview = useCallback(async (f: File) => {
    setPreviewing(true);
    setPlan(null);
    setFile(f);
    try {
      const fd = new FormData();
      fd.set("file", f);
      const res = await previewExternalUndertime(fd);
      if ("error" in res) {
        toast.error(res.error);
        setFile(null);
        return;
      }
      setPlan(res.plan);
      if (res.plan.rows.length === 0) toast.error("No undertime rows found in the file.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed.");
      setFile(null);
    } finally {
      setPreviewing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, []);

  const runImport = async () => {
    if (!file) return;
    setImporting(true);
    try {
      const fd = new FormData();
      fd.set("file", file);
      const res = await importExternalUndertime(fd);
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Saved ${res.applied} charged and ${res.held} on hold; ${res.skipped} skipped. ` +
          `VL change: ${fmtDays(res.vlDaysPosted)} day(s) across ${res.months.join(", ")}.`,
      );
      setPlan(null);
      setFile(null);
      setConfirmImport(false);
      setTab("records");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setImporting(false);
    }
  };

  const planFilters = useMemo(
    () =>
      plan
        ? [
            {
              id: "category",
              title: "Result",
              options: CATEGORY_ORDER.filter((c) => plan.summary[c].rows > 0).map((c) => ({
                label: CATEGORY_LABELS[c],
                value: c,
              })),
            },
            {
              id: "period",
              title: "Month",
              options: [...new Set(plan.rows.map((r) => r.month))]
                .sort((a, b) => a - b)
                .map((m) => ({ label: MONTH_LABELS[m - 1], value: MONTH_LABELS[m - 1] })),
            },
          ]
        : [],
    [plan],
  );

  /* ---------------------------- Records tab --------------------------- */
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<ExternalUndertimeRecord | null>(null);
  const [editMinutes, setEditMinutes] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<ExternalUndertimeRecord | null>(null);
  const [statusTarget, setStatusTarget] = useState<{
    record: ExternalUndertimeRecord;
    status: ExternalUndertimeRecord["status"];
  } | null>(null);

  const handleStatus = useCallback(
    async (r: ExternalUndertimeRecord, status: ExternalUndertimeRecord["status"]) => {
      setBusyId(r.id);
      const res = await updateExternalUndertime({ id: r.id, status });
      setBusyId(null);
      if ("error" in res) toast.error(res.error);
      else {
        toast.success(`${r.employeeName}, ${MONTH_LABELS[r.month - 1]}: ${RECORD_STATUS_LABELS[status]}`);
        router.refresh();
      }
    },
    [router],
  );

  // Rows on hold are awaiting HR review, so resolving one (charge or exclude)
  // asks first; other status changes apply straight from the menu.
  const requestStatus = useCallback(
    (r: ExternalUndertimeRecord, status: ExternalUndertimeRecord["status"]) => {
      if (r.status === "hold") setStatusTarget({ record: r, status });
      else void handleStatus(r, status);
    },
    [handleStatus],
  );

  const confirmStatus = async () => {
    if (!statusTarget) return;
    await handleStatus(statusTarget.record, statusTarget.status);
    setStatusTarget(null);
  };

  const openEdit = useCallback((r: ExternalUndertimeRecord) => {
    setEditTarget(r);
    setEditMinutes(String(r.minutes));
    setEditNotes(r.notes ?? "");
  }, []);

  const saveEdit = async () => {
    if (!editTarget) return;
    const minutes = Number(editMinutes);
    if (!Number.isInteger(minutes) || minutes < 0) {
      toast.error("Minutes must be a whole number, 0 or more.");
      return;
    }
    setBusyId(editTarget.id);
    const res = await updateExternalUndertime({ id: editTarget.id, minutes, notes: editNotes });
    setBusyId(null);
    if ("error" in res) toast.error(res.error);
    else {
      toast.success("Saved. The VL deduction was recomputed.");
      setEditTarget(null);
      router.refresh();
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.id);
    const res = await deleteExternalUndertime(deleteTarget.id);
    setBusyId(null);
    if ("error" in res) toast.error(res.error);
    else {
      toast.success("Deleted. Any VL it deducted was given back.");
      setDeleteTarget(null);
      router.refresh();
    }
  };

  const recordColumns = useMemo(
    () =>
      externalRecordColumns({
        onStatus: requestStatus,
        onEdit: openEdit,
        onDelete: setDeleteTarget,
      }),
    [requestStatus, openEdit],
  );

  const recordFilters = useMemo(
    () => [
      {
        id: "status",
        title: "Status",
        options: (["apply", "hold", "excluded"] as const).map((s) => ({
          label: RECORD_STATUS_LABELS[s],
          value: s,
        })),
      },
      {
        id: "period",
        title: "Month",
        options: [...new Set(records.map((r) => r.month))]
          .sort((a, b) => a - b)
          .map((m) => ({ label: MONTH_LABELS[m - 1], value: MONTH_LABELS[m - 1] })),
      },
    ],
    [records],
  );

  const recordTotals = useMemo(() => {
    const t = { apply: 0, hold: 0, excluded: 0, postedDays: 0 };
    for (const r of records) {
      t[r.status] += 1;
      t.postedDays += r.postedDays;
    }
    return t;
  }, [records]);

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 4 }, (_, i) => currentYear - i);

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
      <TabsList>
        <TabsTrigger value="import">Import</TabsTrigger>
        <TabsTrigger value="records">Records ({records.length})</TabsTrigger>
      </TabsList>

      {/* ------------------------------ Import ------------------------------ */}
      <TabsContent value="import" className="space-y-6 pt-4">
        <Card>
          <CardHeader>
            <CardTitle>Upload the external undertime summary</CardTitle>
            <CardDescription>
              The other DTR system&apos;s monthly summary (.xlsx or .csv) with the columns{" "}
              <strong>Month</strong>, <strong>Name</strong>, <strong>I.D.</strong> and{" "}
              <strong>Tot. Minutes</strong>. Employees are matched by ID number and surname.
              Months where HRIS has its own biometric logs are skipped; HRIS wins. Nothing is
              saved until you review the preview and click Import.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void runPreview(f);
              }}
            />
            <Button
              type="button"
              variant="outline"
              disabled={previewing || importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {previewing ? "Reading…" : "Choose file"}
            </Button>
          </CardContent>
        </Card>

        {plan && plan.rows.length > 0 && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-sm">
                <FileSpreadsheet className="h-4 w-4" />
                <span className="font-medium">{plan.fileName}</span>
                <span className="text-muted-foreground">· {plan.rows.length} employee-months</span>
              </p>
              <Button
                onClick={() => setConfirmImport(true)}
                disabled={importing || plan.summary.apply.rows + plan.summary.hold.rows === 0}
              >
                Import {plan.summary.apply.rows + plan.summary.hold.rows} rows
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {CATEGORY_ORDER.map((c) => {
                const s = plan.summary[c];
                return (
                  <div key={c} className="rounded-lg border p-3">
                    <p className="text-sm font-medium">{CATEGORY_LABELS[c]}</p>
                    <p className="text-2xl font-semibold tabular-nums">{s.rows}</p>
                    <p className="text-muted-foreground text-xs">
                      {fmtDays(s.days)} VL days · {CATEGORY_HELP[c]}
                    </p>
                  </div>
                );
              })}
            </div>

            {plan.parseErrors.length > 0 && (
              <div className="rounded-md border bg-muted/40 p-3">
                <p className="mb-2 text-xs font-semibold">
                  {plan.parseErrors.length} row(s) could not be read
                </p>
                <ul className="max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-xs text-muted-foreground">
                  {plan.parseErrors.slice(0, 50).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <DataTable
              columns={externalPlanColumns}
              data={plan.rows}
              searchableColumns={[{ id: "extName", title: "name" }]}
              filterableColumns={planFilters}
            />
          </>
        )}
      </TabsContent>

      {/* ------------------------------ Records ----------------------------- */}
      <TabsContent value="records" className="space-y-4 pt-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Year</Label>
            <Select
              value={String(year)}
              onValueChange={(v) => router.push(`/admin/external-undertime?year=${v}`)}
            >
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-sm text-muted-foreground">
            {recordTotals.apply} charged · {recordTotals.hold} on hold · {recordTotals.excluded} excluded
            {" · "}VL deducted for these months:{" "}
            <span className="font-medium text-foreground">{fmtDays(-recordTotals.postedDays)} days</span>
          </p>
        </div>

        <DataTable
          columns={recordColumns}
          data={records}
          searchableColumns={[{ id: "employeeName", title: "name" }]}
          filterableColumns={recordFilters}
        />
      </TabsContent>

      {/* Confirm import */}
      <AlertDialog open={confirmImport} onOpenChange={(o) => !importing && setConfirmImport(o)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Import this undertime?</AlertDialogTitle>
            <AlertDialogDescription>
              {plan && (
                <>
                  {plan.summary.apply.rows} employee-months ({fmtDays(plan.summary.apply.days)} VL days)
                  will be charged to VL now. {plan.summary.hold.rows} will be saved on hold and
                  charge nothing until reviewed. Anything charged can be edited, held or deleted
                  later in Records, and the VL balance follows.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={importing}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={runImport} disabled={importing}>
              {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Edit minutes / notes */}
      <Dialog open={editTarget !== null} onOpenChange={(o) => !o && setEditTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit external undertime</DialogTitle>
            <DialogDescription>
              {editTarget &&
                `${editTarget.employeeName} · ${MONTH_LABELS[editTarget.month - 1]} ${editTarget.year}`}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ext-minutes">Total minutes for the month</Label>
              <Input
                id="ext-minutes"
                inputMode="numeric"
                value={editMinutes}
                onChange={(e) => setEditMinutes(e.target.value.replace(/[^0-9]/g, ""))}
              />
              <p className="text-muted-foreground text-xs">
                = {fmtDays(Number(editMinutes || 0) / 480)} VL days (480 minutes = 1 day)
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="ext-notes">Notes</Label>
              <Textarea
                id="ext-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="e.g. corrected per office memo"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button onClick={saveEdit} disabled={busyId !== null}>
              {busyId !== null && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this record?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget &&
                `${deleteTarget.employeeName}, ${MONTH_LABELS[deleteTarget.month - 1]} ${deleteTarget.year}: ` +
                  `${deleteTarget.minutes.toLocaleString()} minutes. Any VL it deducted is given back. ` +
                  `A later re-import of the same file will add it again; use Exclude to keep it out for good.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDelete} disabled={busyId !== null}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Status change on an on-hold record */}
      <AlertDialog open={statusTarget !== null} onOpenChange={(o) => !o && busyId === null && setStatusTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {statusTarget?.status === "apply"
                ? "Charge this record to VL?"
                : statusTarget?.status === "excluded"
                  ? "Exclude this record?"
                  : "Change this record's status?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {statusTarget &&
                `${statusTarget.record.employeeName}, ${MONTH_LABELS[statusTarget.record.month - 1]} ${statusTarget.record.year}: ` +
                  `${statusTarget.record.minutes.toLocaleString()} minutes (${fmtDays(statusTarget.record.days)} VL days). ` +
                  (statusTarget.status === "apply"
                    ? "It will be deducted from the employee's VL now."
                    : statusTarget.status === "excluded"
                      ? "It will charge nothing and stay out of future re-imports."
                      : `It will be set to ${RECORD_STATUS_LABELS[statusTarget.status]}.`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyId !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={confirmStatus} disabled={busyId !== null}>
              {statusTarget?.status === "apply"
                ? "Charge to VL"
                : statusTarget?.status === "excluded"
                  ? "Exclude"
                  : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Tabs>
  );
}
