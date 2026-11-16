import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/actions/auth-actions";
import { listExternalUndertime } from "@/lib/actions/external-undertime-actions";
import { ExternalUndertimeClient } from "@/components/admin/external-undertime-client";
import { hasAnyRole } from "@/lib/auth-helpers";

export default async function ExternalUndertimePage({
  searchParams,
}: {
  searchParams: Promise<{ year?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (!hasAnyRole(user.roles, "super_admin", "hr_admin")) redirect("/dashboard");

  const { year: yearParam } = await searchParams;
  const parsed = Number(yearParam);
  const year = Number.isInteger(parsed) && parsed >= 2000 && parsed <= 2100
    ? parsed
    : new Date().getFullYear();

  const records = await listExternalUndertime(year);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">External Undertime</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Tardiness and undertime from the other DTR system, for employees HRIS has no
          biometrics for. Charged rows are deducted from VL like HRIS&apos;s own DTR, and
          the deduction follows any edit, hold or deletion made here.
        </p>
      </div>
      <ExternalUndertimeClient year={year} records={records} />
    </div>
  );
}
