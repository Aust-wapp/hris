-- Migration 107: Mandatory/Forced Leave is charged to Vacation Leave (CSC
-- rule), and a new Wellness Leave type with 5 days for 2026.
--
-- 1. FORCED LEAVE → VL. Under the CSC leave rules the 5-day mandatory/forced
--    leave is part of the employee's VL credits, not a separate pool. Until
--    now an approved FL application only reduced the FL row. From here:
--      * the VL row's used_credits also counts approved FL applications, so
--        the VL balance drops by the FL days taken;
--      * the FL row keeps its annual 5-day seed and still counts FL
--        applications against it, so it now reads as "forced-leave days still
--        to take this year" rather than a separate credit pool.
--    Paid days for an FL application are capped by both the FL row and the
--    VL balance (app side: src/lib/leave-charging.ts). Existing approved FL
--    applications are charged to VL by this view change alone — no data is
--    rewritten. In production on 2026-11-17 that is one approved application
--    (5 days) whose employee has 49 days of VL.
--
-- 2. WELLNESS LEAVE (WL). 5 days a year, non-cumulative, non-commutable —
--    max_credits = 5 with no annual accrual, so provision_year() seeds it every
--    year exactly like SPL. For 2026, which is already provisioned, every
--    active employee gets the 5-day seed now. Idempotent: a key that already
--    has a WL seed row for 2026 is skipped.

SET search_path TO hris, public, auth, extensions;

-- ── 1. Balance view: VL also counts approved Forced Leave ────────────────
CREATE OR REPLACE VIEW hris.leave_credit_balances AS
SELECT
  lc.id,
  lc.employee_id,
  lc.leave_type_id,
  lc.year,
  lc.total_credits,
  COALESCE(used.used_credits, 0::numeric)::numeric(8,3) AS used_credits,
  (lc.total_credits - COALESCE(used.used_credits, 0::numeric))::numeric(8,3) AS balance
FROM hris.leave_credits lc
JOIN hris.leave_types lct ON lct.id = lc.leave_type_id
LEFT JOIN LATERAL (
  SELECT SUM(la.days_with_pay) AS used_credits
  FROM hris.leave_applications la
  JOIN hris.leave_types lat ON lat.id = la.leave_type_id
  WHERE la.employee_id = lc.employee_id
    AND la.status = 'approved'::hris.approval_status
    AND EXTRACT(YEAR FROM la.start_date)::INT = lc.year
    AND (
      la.leave_type_id = lc.leave_type_id
      -- CSC: Mandatory/Forced Leave is taken out of Vacation Leave.
      OR (lct.code = 'VL' AND lat.code = 'FL')
    )
) used ON true;

COMMENT ON VIEW hris.leave_credit_balances IS
  'Derived balance per (employee, leave_type, year): total credits minus approved leave_applications.days_with_pay (excludes LWOP days). VL also counts approved Forced Leave (CSC rule, migration 107). 3-decimal precision.';

ALTER VIEW hris.leave_credit_balances SET (security_barrier = true);
GRANT SELECT ON hris.leave_credit_balances TO authenticated, anon, service_role;

-- ── 2. Wellness Leave type ───────────────────────────────────────────────
INSERT INTO hris.leave_types
  (code, name, max_credits, annual_credits, is_cumulative, is_convertible, applicable_to)
SELECT 'WL', 'Wellness Leave', 5, NULL, false, false, 'all'
WHERE NOT EXISTS (SELECT 1 FROM hris.leave_types WHERE code = 'WL');

-- 2026 grant: 5 days for every active employee (the same population
-- provision_year() seeds each year).
INSERT INTO hris.leave_credit_accruals
  (employee_id, leave_type_id, year, amount, source, notes)
SELECT e.id, lt.id, 2026, 5, 'seed', 'Annual seed for 2026 (Wellness Leave introduced)'
  FROM hris.employees e
  JOIN hris.leave_types lt ON lt.code = 'WL'
 WHERE e.status = 'active'
   AND NOT EXISTS (
     SELECT 1 FROM hris.leave_credit_accruals a
      WHERE a.employee_id = e.id
        AND a.leave_type_id = lt.id
        AND a.year = 2026
        AND a.source = 'seed'
   );

-- leave_credits.total_credits = SUM(ledger), the rule every balance reads.
INSERT INTO hris.leave_credits (employee_id, leave_type_id, year, total_credits)
SELECT a.employee_id, a.leave_type_id, a.year, SUM(a.amount)
  FROM hris.leave_credit_accruals a
  JOIN hris.leave_types lt ON lt.id = a.leave_type_id AND lt.code = 'WL'
 WHERE a.year = 2026
 GROUP BY a.employee_id, a.leave_type_id, a.year
ON CONFLICT (employee_id, leave_type_id, year)
DO UPDATE SET total_credits = EXCLUDED.total_credits
WHERE hris.leave_credits.total_credits IS DISTINCT FROM EXCLUDED.total_credits;
