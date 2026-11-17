"use client";

import Link from "next/link";
import { ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";

import { DataTableColumnHeader } from "@/components/tables/data-table-column-header";
import { cn } from "@/lib/utils";
import type { VlResyncLeave, VlResyncRow } from "@/lib/actions/leave-actions";
import type { XlsxColumn } from "@/lib/xlsx";

const fmt3 = (n: number) => parseFloat(n.toFixed(3)).toString();

function leaveLabel(l: VlResyncLeave) {
  const start = format(new Date(l.start_date), "MMM d");
  const end = format(new Date(l.end_date), "MMM d");
  return `${l.code} ${start === end ? start : `${start}–${end}`}`;
}

export const VL_RESYNC_EXPORT_COLUMNS: XlsxColumn<VlResyncRow>[] = [
  { header: "Employee ID", value: (r) => r.id_number },
  { header: "Name", value: (r) => r.full_name },
  { header: "Department", value: (r) => r.department },
  { header: "Employee Status", value: (r) => r.employee_status },
  { header: "VL Overstated By (days)", value: (r) => r.overstated_by },
  { header: "Deductions Posted Since Fix", value: (r) => r.posted_since_fix },
  { header: "VL Balance Now", value: (r) => r.vl_balance_now },
  { header: "Leaves Filed Before Fix", value: (r) => r.leaves_before_fix.length },
  {
    header: "Leaves to Review",
    value: (r) =>
      r.leaves_before_fix
        .map((l) => `${leaveLabel(l)} (${l.status})`)
        .join("; "),
  },
];

export const vlResyncColumns: ColumnDef<VlResyncRow>[] = [
  {
    accessorKey: "full_name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Employee" />,
    cell: ({ row }) => (
      <Link
        href={`/employees/${row.original.employee_id}`}
        className="block hover:underline"
      >
        <p className="font-medium">{row.original.full_name}</p>
        <p className="text-xs text-muted-foreground">
          {row.original.id_number ?? "—"}
          {row.original.employee_status !== "active" &&
            ` · ${row.original.employee_status}`}
        </p>
      </Link>
    ),
  },
  {
    accessorKey: "department",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Department" />,
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">{row.original.department || "—"}</span>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: "overstated_by",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Overstated By" />,
    cell: ({ row }) => (
      <span className="font-semibold tabular-nums text-red-600 dark:text-red-500">
        {fmt3(row.original.overstated_by)}
      </span>
    ),
  },
  {
    accessorKey: "posted_since_fix",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Posted Since Fix" />,
    cell: ({ row }) => {
      const v = row.original.posted_since_fix;
      return (
        <span className={cn("tabular-nums", v === 0 && "text-muted-foreground")}>
          {v > 0 ? "+" : ""}
          {fmt3(v)}
        </span>
      );
    },
  },
  {
    accessorKey: "vl_balance_now",
    header: ({ column }) => <DataTableColumnHeader column={column} title="VL Now" />,
    cell: ({ row }) => {
      const v = row.original.vl_balance_now;
      return (
        <span
          className={cn(
            "font-semibold tabular-nums",
            v < 0 && "text-red-600 dark:text-red-500",
          )}
        >
          {fmt3(v)}
        </span>
      );
    },
  },
  {
    id: "leaves",
    accessorFn: (r) => r.leaves_before_fix.length,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Leaves Filed Before Fix" />
    ),
    cell: ({ row }) => {
      const list = row.original.leaves_before_fix;
      if (list.length === 0) return <span className="text-muted-foreground">—</span>;
      return (
        <div className="flex flex-col gap-0.5 text-xs">
          {list.map((l) => (
            <Link key={l.id} href={`/leaves/${l.id}`} className="hover:underline">
              {leaveLabel(l)}
              <span className="text-muted-foreground"> · {l.status}</span>
            </Link>
          ))}
        </div>
      );
    },
  },
];
