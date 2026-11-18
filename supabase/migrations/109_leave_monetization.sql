-- Migration 109: Monetization of leave credits (CSC MC No. 41, s. 1998,
-- Rule XVI §22–23; CS Form 6 §6.B "Other purpose: Monetization of Leave
-- Credits").
--
-- A monetization is filed as an ordinary leave application on the Vacation
-- Leave type, so it reuses the two-step approval workflow, the audit trail and
-- the balance view. It has no leave dates: start_date = end_date = the date of
-- filing (that sets the credit year), and leave_dates is empty. Every reader
-- that turns approved leave into days off (DTR, attendance, external
-- undertime) must skip rows with a monetization_type.
--
--   monetization_type      'regular' (§22: at least 15 VL, 10–30 days a year,
--                          at least 5 VL kept) or 'special' (§23: 50% or more
--                          of accumulated VL + SL, for justifiable reasons).
--                          NULL for every ordinary leave application.
--   sl_days_with_pay       Sick Leave days charged by a special monetization
--                          once VL is used up. days_with_pay stays the VL
--                          portion, so the VL row of the view is unchanged.
--   monetization_monthly_salary
--                          Monthly salary on the date of filing, snapshotted so
--                          the printed amount does not move with later NOSI/NOSA.
--
-- No existing row is changed: all three columns are NULL / 0 for current data.

SET search_path TO hris, public, auth, extensions;

ALTER TABLE hris.leave_applications
  ADD COLUMN IF NOT EXISTS monetization_type TEXT
    CHECK (monetization_type IN ('regular', 'special')),
  ADD COLUMN IF NOT EXISTS sl_days_with_pay NUMERIC(8,3) NOT NULL DEFAULT 0
    CHECK (sl_days_with_pay >= 0),
  ADD COLUMN IF NOT EXISTS monetization_monthly_salary NUMERIC(12,2);

COMMENT ON COLUMN hris.leave_applications.monetization_type IS
  'NULL for ordinary leave. regular = CSC MC 41 s.1998 §22, special = §23 (50% or more). Filed on the VL type with no leave dates.';
COMMENT ON COLUMN hris.leave_applications.sl_days_with_pay IS
  'Sick Leave days charged by a special monetization after VL. Counted against SL by leave_credit_balances.';
COMMENT ON COLUMN hris.leave_applications.monetization_monthly_salary IS
  'Monthly salary on the date of filing; amount = salary x days x 0.0481927.';

CREATE INDEX IF NOT EXISTS idx_leave_applications_monetization
  ON hris.leave_applications (employee_id, start_date)
  WHERE monetization_type IS NOT NULL;

-- ── Balance view: SL also counts the SL portion of approved monetizations ──
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
  SELECT SUM(
    CASE
      WHEN la.leave_type_id = lc.leave_type_id
        -- CSC: Mandatory/Forced Leave is taken out of Vacation Leave.
        OR (lct.code = 'VL' AND lat.code = 'FL')
      THEN la.days_with_pay
      ELSE 0
    END
    -- Special monetization charges SL once VL is exhausted (migration 109).
    + CASE WHEN lct.code = 'SL' THEN la.sl_days_with_pay ELSE 0 END
  ) AS used_credits
  FROM hris.leave_applications la
  JOIN hris.leave_types lat ON lat.id = la.leave_type_id
  WHERE la.employee_id = lc.employee_id
    AND la.status = 'approved'::hris.approval_status
    AND EXTRACT(YEAR FROM la.start_date)::INT = lc.year
    AND (
      la.leave_type_id = lc.leave_type_id
      OR (lct.code = 'VL' AND lat.code = 'FL')
      OR (lct.code = 'SL' AND la.sl_days_with_pay > 0)
    )
) used ON true;

COMMENT ON VIEW hris.leave_credit_balances IS
  'Derived balance per (employee, leave_type, year): total credits minus approved leave_applications.days_with_pay (excludes LWOP days). VL also counts approved Forced Leave (migration 107); SL also counts sl_days_with_pay of approved special monetizations (migration 109). 3-decimal precision.';

ALTER VIEW hris.leave_credit_balances SET (security_barrier = true);
GRANT SELECT ON hris.leave_credit_balances TO authenticated, anon, service_role;
