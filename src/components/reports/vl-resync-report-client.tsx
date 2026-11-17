"use client";

import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/tables/data-table";
import { ExportExcelButton } from "@/components/tables/export-excel-button";
import {
  VL_RESYNC_EXPORT_COLUMNS,
  vlResyncColumns,
} from "@/components/tables/columns/vl-resync-columns";
import type { VlResyncReport } from "@/lib/actions/leave-actions";

export function VlResyncReportClient({ report }: { report: VlResyncReport }) {
  const { rows } = report;
  const totalDays = rows.reduce((sum, r) => sum + r.overstated_by, 0);
  const withLeaves = rows.filter((r) => r.leaves_before_fix.length > 0).length;
  const negative = rows.filter((r) => r.vl_balance_now < 0).length;

  const departments = [...new Set(rows.map((r) => r.department).filter(Boolean))]
    .sort()
    .map((d) => ({ label: d, value: d }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Employees: {rows.length}</Badge>
        <Badge variant="outline">
          VL overstated: {parseFloat(totalDays.toFixed(3))} days
        </Badge>
        <Badge variant="secondary">With leaves filed before fix: {withLeaves}</Badge>
        {negative > 0 && (
          <Badge variant="destructive">Negative VL now: {negative}</Badge>
        )}
      </div>

      <DataTable
        columns={vlResyncColumns}
        data={rows}
        searchableColumns={[{ id: "full_name", title: "employee" }]}
        filterableColumns={[
          { id: "department", title: "Department", options: departments },
        ]}
        toolbar={(table) => (
          <ExportExcelButton
            rows={table.getFilteredRowModel().rows.map((r) => r.original)}
            columns={VL_RESYNC_EXPORT_COLUMNS}
            filename="vl-overstated-before-nov16-fix"
            sheetName="VL Overstated"
          />
        )}
      />
    </div>
  );
}
