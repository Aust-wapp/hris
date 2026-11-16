"use client";

import { ColumnDef } from "@tanstack/react-table";
import { Ban, CheckCircle2, MoreHorizontal, PauseCircle, PencilLine, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DataTableColumnHeader } from "@/components/tables/data-table-column-header";
import {
  CATEGORY_LABELS,
  HOLD_REASON_LABELS,
  type ExternalCategory,
  type HoldReason,
} from "@/lib/external-undertime";
import type {
  ExternalPlanRow,
  ExternalUndertimeRecord,
} from "@/lib/actions/external-undertime-actions";

export const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const fmtDays = (d: number) => parseFloat(d.toFixed(3)).toString();

const inList = (row: { getValue: (id: string) => unknown }, id: string, value: string[]) =>
  value.includes(String(row.getValue(id)));

const CATEGORY_VARIANT: Record<ExternalCategory, "default" | "secondary" | "outline" | "destructive"> = {
  apply: "default",
  hold: "secondary",
  skip_unmatched: "destructive",
  skip_not_plantilla: "outline",
  skip_hris_has_logs: "outline",
  skip_after_separation: "outline",
};

function reasonsText(reasons: string | HoldReason[] | null): string | null {
  const list = Array.isArray(reasons) ? reasons : (reasons ?? "").split(",").filter(Boolean);
  if (list.length === 0) return null;
  return list.map((r) => HOLD_REASON_LABELS[r as HoldReason] ?? r).join("; ");
}

/* -------------------------------------------------------------------------- */
/* Import preview                                                              */
/* -------------------------------------------------------------------------- */

export const externalPlanColumns: ColumnDef<ExternalPlanRow>[] = [
  {
    id: "period",
    accessorFn: (r) => MONTH_LABELS[r.month - 1],
    header: ({ column }) => <DataTableColumnHeader column={column} title="Month" />,
    cell: ({ row }) => `${MONTH_LABELS[row.original.month - 1]} ${row.original.year}`,
    filterFn: inList,
  },
  {
    accessorKey: "extName",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name in file" />,
    cell: ({ row }) => (
      <div className="min-w-[180px]">
        <p className="font-medium">{row.original.extName}</p>
        <p className="text-muted-foreground text-xs">{row.original.extId}</p>
      </div>
    ),
  },
  {
    id: "hris",
    accessorFn: (r) => r.hrisName ?? "",
    header: ({ column }) => <DataTableColumnHeader column={column} title="HRIS employee" />,
    cell: ({ row }) => {
      const r = row.original;
      if (r.hrisName) {
        return (
          <div className="min-w-[160px]">
            <p>{r.hrisName}</p>
            <p className="text-muted-foreground text-xs">
              {r.hrisIdNumber}
              {r.employeeStatus && r.employeeStatus !== "active" ? ` · ${r.employeeStatus}` : ""}
            </p>
          </div>
        );
      }
      return (
        <span className="text-muted-foreground text-xs">
          {r.idHolders ? `ID belongs to ${r.idHolders}` : "No employee with this ID"}
        </span>
      );
    },
  },
  {
    accessorKey: "minutes",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Minutes" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.minutes.toLocaleString()}</span>,
  },
  {
    accessorKey: "days",
    header: ({ column }) => <DataTableColumnHeader column={column} title="VL days" />,
    cell: ({ row }) => <span className="tabular-nums">{fmtDays(row.original.days)}</span>,
  },
  {
    accessorKey: "category",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Result" />,
    cell: ({ row }) => {
      const r = row.original;
      const reasons = reasonsText(r.holdReasons);
      return (
        <div className="space-y-1 min-w-[150px]">
          <Badge variant={CATEGORY_VARIANT[r.category]}>{CATEGORY_LABELS[r.category]}</Badge>
          {reasons && <p className="text-muted-foreground text-xs">{reasons}</p>}
          {r.lockedStatus && (
            <p className="text-muted-foreground text-xs">
              Keeps HR&apos;s earlier decision: {r.lockedStatus}
            </p>
          )}
        </div>
      );
    },
    filterFn: inList,
  },
];

/* -------------------------------------------------------------------------- */
/* Saved records                                                               */
/* -------------------------------------------------------------------------- */

export const RECORD_STATUS_LABELS: Record<ExternalUndertimeRecord["status"], string> = {
  apply: "Charged to VL",
  hold: "On hold",
  excluded: "Excluded",
};

export function externalRecordColumns(handlers: {
  onStatus: (r: ExternalUndertimeRecord, status: ExternalUndertimeRecord["status"]) => void;
  onEdit: (r: ExternalUndertimeRecord) => void;
  onDelete: (r: ExternalUndertimeRecord) => void;
}): ColumnDef<ExternalUndertimeRecord>[] {
  return [
    {
      id: "period",
      accessorFn: (r) => MONTH_LABELS[r.month - 1],
      header: ({ column }) => <DataTableColumnHeader column={column} title="Month" />,
      cell: ({ row }) => `${MONTH_LABELS[row.original.month - 1]} ${row.original.year}`,
      filterFn: inList,
    },
    {
      accessorKey: "employeeName",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Employee" />,
      cell: ({ row }) => {
        const r = row.original;
        return (
          <div className="min-w-[180px]">
            <p className="font-medium">{r.employeeName}</p>
            <p className="text-muted-foreground text-xs">
              {r.idNumber ?? r.extId}
              {r.employeeStatus !== "active" ? ` · ${r.employeeStatus}` : ""}
            </p>
          </div>
        );
      },
    },
    {
      accessorKey: "department",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Department" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm">{row.original.department ?? "—"}</span>
      ),
    },
    {
      accessorKey: "minutes",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Minutes" />,
      cell: ({ row }) => <span className="tabular-nums">{row.original.minutes.toLocaleString()}</span>,
    },
    {
      accessorKey: "days",
      header: ({ column }) => <DataTableColumnHeader column={column} title="VL days" />,
      cell: ({ row }) => <span className="tabular-nums">{fmtDays(row.original.days)}</span>,
    },
    {
      id: "status",
      accessorFn: (r) => r.status,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => {
        const r = row.original;
        const reasons = reasonsText(r.reviewReason);
        return (
          <div className="space-y-1 min-w-[140px]">
            <Badge
              variant={r.status === "apply" ? "default" : r.status === "hold" ? "secondary" : "outline"}
            >
              {RECORD_STATUS_LABELS[r.status]}
            </Badge>
            {r.status === "hold" && reasons && (
              <p className="text-muted-foreground text-xs">{reasons}</p>
            )}
            {r.hrisHasLogs && (
              <p className="text-muted-foreground text-xs">HRIS biometrics exist — HRIS DTR is used</p>
            )}
          </div>
        );
      },
      filterFn: inList,
    },
    {
      accessorKey: "postedDays",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="VL deducted (month)" />
      ),
      cell: ({ row }) => {
        const d = row.original.postedDays;
        return (
          <span className={d < 0 ? "text-destructive tabular-nums" : "text-muted-foreground tabular-nums"}>
            {d < 0 ? `−${fmtDays(-d)}` : "0"}
          </span>
        );
      },
    },
    {
      id: "actions",
      cell: ({ row }) => {
        const r = row.original;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" />}>
              <MoreHorizontal className="h-4 w-4" />
              <span className="sr-only">Open menu</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {r.status !== "apply" && (
                <DropdownMenuItem onClick={() => handlers.onStatus(r, "apply")}>
                  <CheckCircle2 className="h-4 w-4" />
                  Charge to VL
                </DropdownMenuItem>
              )}
              {r.status !== "hold" && (
                <DropdownMenuItem onClick={() => handlers.onStatus(r, "hold")}>
                  <PauseCircle className="h-4 w-4" />
                  Put on hold
                </DropdownMenuItem>
              )}
              {r.status !== "excluded" && (
                <DropdownMenuItem onClick={() => handlers.onStatus(r, "excluded")}>
                  <Ban className="h-4 w-4" />
                  Exclude
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => handlers.onEdit(r)}>
                <PencilLine className="h-4 w-4" />
                Edit minutes / notes
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-destructive" onClick={() => handlers.onDelete(r)}>
                <Trash2 className="h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      enableSorting: false,
      enableHiding: false,
    },
  ];
}
