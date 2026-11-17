import { redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/actions/auth-actions";
import { getVlResyncReport } from "@/lib/actions/leave-actions";
import { VlResyncReportClient } from "@/components/reports/vl-resync-report-client";
import { hasAnyRole } from "@/lib/auth-helpers";

export default async function VlResyncReportPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasAnyRole(user.roles, "super_admin", "hr_admin")) redirect("/dashboard");

  const report = await getVlResyncReport();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/reports">
          <Button variant="ghost" size="icon-sm">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            VL Overstated Before Nov 16 Fix
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-3xl">
            Until November 16, {report.year}, tardiness/undertime deductions were
            recorded but not subtracted from the VL balance. Every VL figure shown
            before then — including CSC Form 6 §7.A &ldquo;Total Earned&rdquo; —
            was too high by the amount below. Leaves filed before the fix are
            listed so their printed forms can be reviewed and reprinted.
          </p>
        </div>
      </div>
      <VlResyncReportClient report={report} />
    </div>
  );
}
