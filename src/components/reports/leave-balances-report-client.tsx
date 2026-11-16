"use client";

import { useRouter } from "next/navigation";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { LeaveBalanceReport } from "@/lib/actions/leave-actions";
import { cn } from "@/lib/utils";

function fmt(n: number) {
  return parseFloat(Number(n).toFixed(3)).toString();
}

function csvCell(value: string | number) {
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

type Row = LeaveBalanceReport["rows"][number];

interface DisplayColumn {
  key: string;
  header: string;
  title: string;
  value: (row: Row) => number;
  emphasis?: boolean;
}

/**
 * VL is shown as three columns — before UT, UT deducted, balance — so the
 * tardiness/undertime charge is visible. The balance already has it taken off;
 * "before UT" adds it back. Every other leave type is its balance.
 */
function displayColumns(columns: LeaveBalanceReport["columns"]): DisplayColumn[] {
  return columns.flatMap((c): DisplayColumn[] => {
    const balance = (row: Row) => row.balances[c.code] ?? 0;
    if (c.code !== "VL") {
      return [{ key: c.code, header: c.code, title: c.name, value: balance }];
    }
    return [
      {
        key: "VL_BEFORE_UT",
        header: "VL before UT",
        title: "Vacation leave balance before tardiness/undertime deductions",
        value: (row) => balance(row) + row.vl_ut_deducted,
      },
      {
        key: "VL_UT",
        header: "UT deducted",
        title: "Tardiness/undertime charged to VL this year (HRIS and external DTR)",
        value: (row) => row.vl_ut_deducted,
      },
      {
        key: "VL",
        header: "VL balance",
        title: "Vacation leave balance after tardiness/undertime deductions",
        value: balance,
        emphasis: true,
      },
    ];
  });
}

export function LeaveBalancesReportClient({
  report,
}: {
  report: LeaveBalanceReport;
}) {
  const router = useRouter();
  const { year, columns, rows } = report;
  const cols = displayColumns(columns);

  const currentYear = new Date().getFullYear();
  const yearOptions = Array.from({ length: 6 }, (_, i) => currentYear - i);

  const handleDownload = () => {
    const header = ["#", "Full Name", "Department", ...cols.map((c) => c.header)];
    const lines = rows.map((row, i) =>
      [
        i + 1,
        row.full_name,
        row.department,
        ...cols.map((c) => fmt(c.value(row))),
      ]
        .map(csvCell)
        .join(","),
    );
    // Prepend a UTF-8 BOM so Excel renders accented names correctly.
    const csv = "﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leave-balances-${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Year</label>
          <Select
            value={String(year)}
            onValueChange={(v) => router.push(`/reports/leave-balances?year=${v}`)}
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

        <Button
          variant="outline"
          size="sm"
          onClick={handleDownload}
          disabled={rows.length === 0}
        >
          <Download className="h-4 w-4" />
          Download Excel
        </Button>
      </div>

      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12 text-right">#</TableHead>
                <TableHead className="min-w-[220px]">Full Name</TableHead>
                <TableHead className="min-w-[160px]">Department</TableHead>
                {cols.map((c) => (
                  <TableHead key={c.key} className="text-right whitespace-nowrap" title={c.title}>
                    {c.header}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3 + cols.length}
                    className="py-10 text-center text-muted-foreground"
                  >
                    No active plantilla employees found for {year}.
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row, i) => (
                  <TableRow key={row.employee_id}>
                    <TableCell className="text-right text-muted-foreground">
                      {i + 1}
                    </TableCell>
                    <TableCell className="font-medium">{row.full_name}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.department}
                    </TableCell>
                    {cols.map((c) => (
                      <TableCell
                        key={c.key}
                        className={cn(
                          "text-right tabular-nums",
                          c.emphasis && "font-semibold",
                          c.key === "VL_UT" && c.value(row) > 0 && "text-destructive",
                        )}
                      >
                        {c.key === "VL_UT" && c.value(row) > 0 ? "−" : ""}
                        {fmt(c.value(row))}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
