import type { ReactNode } from "react";
import { requireSuperAdmin } from "@/lib/auth";

export default async function UserManagementLayout({
  children,
}: {
  children: ReactNode;
}) {
  await requireSuperAdmin();
  return children;
}
