-- Migration 103: Add "jo_viewer" role.
--
-- JO Viewer is a read-only Job Orders role: it opens every Job Orders page —
-- JO employees, Area Assignments, Payroll, Memorandum, Special Orders and
-- Signatories — and can print, but cannot create, edit, lock, duplicate or
-- delete anything. It carries NO other access — no plantilla employees,
-- attendance/DTR, leave, CTO/COC, RSP, regular or COS payroll, reports or
-- administration tools. App-side authorization treats it via
-- canViewJobOrders() (src/lib/auth-helpers.ts); every write stays behind
-- canManageJobOrders / canManageJobOrderPayroll, which do not admit it.
--
-- Note: ALTER TYPE ... ADD VALUE cannot run inside a transaction block, and a
-- newly added enum value cannot be referenced in the same transaction in which
-- it is added. That is why the rank and RLS changes live in migration 104.
SET search_path TO hris, public, auth, extensions;

ALTER TYPE hris.user_role
  ADD VALUE IF NOT EXISTS 'jo_viewer';
