-- Migration 104: rank the "jo_viewer" role and give it read-only RLS.
--
-- 1. hris.user_role_rank gains jo_viewer, ranked just below the two module
--    managers: it reaches the same module as jo_manager but can change
--    nothing, so it never outranks a role that can. Mirrored by
--    ROLE_PRECEDENCE in src/lib/auth-helpers.ts — change both together.
--
-- 2. Every Job Orders table gets a SELECT-only policy for jo_viewer. The app
--    reads these tables through the admin client and gates in TypeScript, so
--    this is defence in depth: a jo_viewer session talking to PostgREST
--    directly can read the module and write nothing. The existing
--    admin_all_* (FOR ALL) policies are untouched.
SET search_path TO hris, public, auth, extensions;

CREATE OR REPLACE FUNCTION hris.user_role_rank(r hris.user_role)
RETURNS integer
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE r
    WHEN 'super_admin' THEN 1
    WHEN 'hr_admin' THEN 2
    WHEN 'ocm_admin' THEN 3
    WHEN 'dtr_manager' THEN 4
    WHEN 'hr_record_manager' THEN 5
    WHEN 'department_admin_and_department_head' THEN 6
    WHEN 'department_head' THEN 7
    WHEN 'department_admin' THEN 8
    WHEN 'jo_manager' THEN 9
    WHEN 'cos_manager' THEN 10
    WHEN 'jo_viewer' THEN 11
    WHEN 'event_attendance_officer' THEN 12
    WHEN 'employee' THEN 13
    ELSE 99
  END;
$$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'job_order_areas',
    'job_order_employees',
    'job_order_payrolls',
    'job_order_payroll_members',
    'job_order_memos',
    'job_order_memo_members',
    'job_order_special_orders',
    'job_order_special_order_members',
    'job_order_signatories'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON hris.%I', 'viewer_select_' || t, t);
    EXECUTE format(
      'CREATE POLICY %I ON hris.%I FOR SELECT USING (hris.get_user_role() = %L::hris.user_role)',
      'viewer_select_' || t, t, 'jo_viewer'
    );
  END LOOP;
END;
$$;
