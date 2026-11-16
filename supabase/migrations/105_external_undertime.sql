-- Migration 105: undertime from an external DTR system feeds the VL deduction.
--
-- Some offices clock in on another biometric system, so HRIS has no
-- attendance_logs for them and the tardy/undertime → VL deduction (032) never
-- charged them. HR gets a monthly summary from that system instead: one total
-- of tardy + undertime minutes per employee per month, no dates.
--
-- 1. hris.external_undertime holds those monthly totals, one editable row per
--    (employee, year, month). `status` decides whether it counts:
--      apply    — charged to VL
--      hold     — imported but waiting for HR review (a day or more, overlaps
--                 approved leave, separation month); charges nothing
--      excluded — HR decided not to charge it
--    status_locked is set when HR changes the status by hand, so a re-import
--    of the same month refreshes the minutes but keeps HR's decision.
--
-- 2. hris.attendance_deduction_month_minutes picks the month's minutes:
--      HRIS has attendance_logs that month  -> the DTR computation (unchanged)
--      else an 'apply' external_undertime row -> its minutes
--      else                                  -> 0
--    HRIS biometrics win whenever they exist: the external file misses punches
--    HRIS has and counts whole absent days as undertime.
--
-- 3. hris.attendance_deduction_candidates decides who is recomputed for a
--    month. Two changes from 032:
--      * separated plantilla employees count for months that start on or
--        before their status_effective_date (they worked those months; their
--        VL feeds terminal leave). Separated with no effective date: skipped.
--      * an employee is also recomputed when the month already has posted
--        attendance_deduction rows, so removing the source (an external row
--        deleted or put on hold) posts the reversing delta instead of leaving
--        a stale deduction behind.
--
-- The ledger mechanics are unchanged: post_attendance_vl_deduction_for_employee
-- still posts only the difference between what the month requires and what is
-- already posted, so every edit is self-correcting and the history is kept.
--
-- 4. BUG FIX — deductions now reach the VL balance. Since 032 the posting
--    function inserted ledger rows but never touched leave_credits.total_credits,
--    which every balance (the leave_credit_balances view, the Leave Balances
--    report, leave applications) is computed from. In production that left 311
--    employees' 2026 VL about 1,003 days too high in total. Posting now resets
--    total_credits = SUM(ledger) for that (employee, VL, year), the same rule
--    recomputeLeaveCreditTotal() applies in the app, and section 5 resyncs
--    every key that already has attendance deductions.

SET search_path TO hris, public, auth, extensions;

-- ── 1. Table ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hris.external_undertime (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   UUID NOT NULL REFERENCES hris.employees(id) ON DELETE CASCADE,
  year          INT  NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  month         INT  NOT NULL CHECK (month BETWEEN 1 AND 12),
  minutes       INT  NOT NULL CHECK (minutes >= 0),
  status        TEXT NOT NULL DEFAULT 'apply'
                CHECK (status IN ('apply', 'hold', 'excluded')),
  status_locked BOOLEAN NOT NULL DEFAULT false,
  review_reason TEXT,
  ext_id        TEXT,
  ext_name      TEXT,
  ext_office    TEXT,
  source_file   TEXT,
  notes         TEXT,
  created_by    UUID REFERENCES hris.user_profiles(id),
  updated_by    UUID REFERENCES hris.user_profiles(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (employee_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_external_undertime_period
  ON hris.external_undertime(year, month);

DROP TRIGGER IF EXISTS trg_external_undertime_updated_at ON hris.external_undertime;
CREATE TRIGGER trg_external_undertime_updated_at
  BEFORE UPDATE ON hris.external_undertime
  FOR EACH ROW EXECUTE FUNCTION hris.update_updated_at();

-- Read and written only by server actions on the admin client.
ALTER TABLE hris.external_undertime ENABLE ROW LEVEL SECURITY;

-- ── 2. Which minutes a month is charged ──────────────────────────────────
CREATE OR REPLACE FUNCTION hris.attendance_deduction_month_minutes(
  p_employee_id UUID,
  p_year INT,
  p_month INT,
  OUT minutes INT,
  OUT source TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
DECLARE
  v_start DATE := make_date(p_year, p_month, 1);
  v_end   DATE := (make_date(p_year, p_month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::DATE;
BEGIN
  IF EXISTS (
    SELECT 1 FROM hris.attendance_logs al
     WHERE al.employee_id = p_employee_id
       AND al.date BETWEEN v_start AND v_end
  ) THEN
    minutes := hris.compute_attendance_deduction_minutes(p_employee_id, p_year, p_month);
    source  := 'dtr';
    RETURN;
  END IF;

  SELECT x.minutes INTO minutes
    FROM hris.external_undertime x
   WHERE x.employee_id = p_employee_id
     AND x.year = p_year
     AND x.month = p_month
     AND x.status = 'apply';
  IF FOUND THEN
    source := 'external';
    RETURN;
  END IF;

  minutes := 0;
  source  := 'none';
END;
$$;

-- Distinct (employee, year, month) pairs that have HRIS biometric logs in a
-- date range. The external-undertime import preview uses it to show which
-- rows HRIS overrides, without pulling every attendance row to the app.
CREATE OR REPLACE FUNCTION hris.employee_months_with_logs(p_from DATE, p_to DATE)
RETURNS TABLE (employee_id UUID, year INT, month INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
  SELECT DISTINCT al.employee_id,
         EXTRACT(YEAR FROM al.date)::INT,
         EXTRACT(MONTH FROM al.date)::INT
    FROM hris.attendance_logs al
   WHERE al.date BETWEEN p_from AND p_to;
$$;

-- ── 3. Who is recomputed for a month ─────────────────────────────────────
CREATE OR REPLACE FUNCTION hris.attendance_deduction_candidates(
  p_year INT,
  p_month INT,
  p_employee_id UUID DEFAULT NULL
)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
  SELECT e.id
    FROM hris.employees e
   WHERE e.employment_type = 'plantilla'
     AND (p_employee_id IS NULL OR e.id = p_employee_id)
     AND (
       e.status = 'active'
       OR (e.status_effective_date IS NOT NULL
           AND make_date(p_year, p_month, 1) <= e.status_effective_date)
     )
     AND (
       EXISTS (
         SELECT 1 FROM hris.attendance_logs al
          WHERE al.employee_id = e.id
            AND al.date BETWEEN make_date(p_year, p_month, 1)
                            AND (make_date(p_year, p_month, 1) + INTERVAL '1 month' - INTERVAL '1 day')::DATE
       )
       OR EXISTS (
         SELECT 1 FROM hris.external_undertime x
          WHERE x.employee_id = e.id AND x.year = p_year AND x.month = p_month
       )
       OR EXISTS (
         SELECT 1 FROM hris.leave_credit_accruals a
          WHERE a.employee_id = e.id AND a.year = p_year AND a.month = p_month
            AND a.source = 'attendance_deduction'
       )
     );
$$;

-- ── 4. Posting, now through the month-minutes picker ─────────────────────
CREATE OR REPLACE FUNCTION hris.post_attendance_vl_deduction_for_employee(
  p_employee_id UUID,
  p_year INT,
  p_month INT
)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
DECLARE
  v_vl_id        UUID;
  v_mins         RECORD;
  v_required     NUMERIC(8,3);   -- days, negative (a deduction)
  v_already      NUMERIC(8,3);
  v_delta        NUMERIC(8,3);
BEGIN
  SELECT id INTO v_vl_id FROM hris.leave_types WHERE code = 'VL' LIMIT 1;
  IF v_vl_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT * INTO v_mins
    FROM hris.attendance_deduction_month_minutes(p_employee_id, p_year, p_month);
  -- 0.125 days per hour = mins / 480, rounded to 3 decimals, NEGATIVE
  v_required := ROUND(-1.0 * v_mins.minutes / 480.0, 3);

  SELECT COALESCE(SUM(amount), 0) INTO v_already
    FROM hris.leave_credit_accruals
    WHERE employee_id = p_employee_id
      AND leave_type_id = v_vl_id
      AND year = p_year
      AND month = p_month
      AND source = 'attendance_deduction';

  v_delta := ROUND(v_required - v_already, 3);
  IF v_delta = 0 THEN
    RETURN 0;
  END IF;

  INSERT INTO hris.leave_credit_accruals
    (employee_id, leave_type_id, year, month, amount, source, notes)
  VALUES (
    p_employee_id,
    v_vl_id,
    p_year,
    p_month,
    v_delta,
    'attendance_deduction',
    format(
      '%s for %s-%s (total %s min, delta %s d)',
      CASE v_mins.source
        WHEN 'external' THEN 'External DTR undertime deduction'
        ELSE 'Tardy/undertime auto-deduction'
      END,
      p_year, lpad(p_month::text, 2, '0'), v_mins.minutes, v_delta
    )
  );

  -- Keep the balance in step with the ledger (section 4 of the header).
  INSERT INTO hris.leave_credits (employee_id, leave_type_id, year, total_credits)
  SELECT p_employee_id, v_vl_id, p_year, COALESCE(SUM(a.amount), 0)
    FROM hris.leave_credit_accruals a
   WHERE a.employee_id = p_employee_id
     AND a.leave_type_id = v_vl_id
     AND a.year = p_year
  ON CONFLICT (employee_id, leave_type_id, year)
  DO UPDATE SET total_credits = EXCLUDED.total_credits;

  RETURN v_delta;
END;
$$;

CREATE OR REPLACE FUNCTION hris.apply_attendance_vl_deduction(
  p_year INT,
  p_month INT,
  p_employee_id UUID DEFAULT NULL
)
RETURNS TABLE (
  year_v      INT,
  month_v     INT,
  employees_v INT,
  posts_v     INT,
  total_days  NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
DECLARE
  v_id   UUID;
  v_d    NUMERIC(8,3);
  v_emp  INT := 0;
  v_pst  INT := 0;
  v_td   NUMERIC(10,3) := 0;
BEGIN
  FOR v_id IN
    SELECT c FROM hris.attendance_deduction_candidates(p_year, p_month, p_employee_id) c
  LOOP
    v_emp := v_emp + 1;
    v_d := hris.post_attendance_vl_deduction_for_employee(v_id, p_year, p_month);
    IF v_d <> 0 THEN
      v_pst := v_pst + 1;
      v_td := v_td + v_d;
    END IF;
  END LOOP;

  RETURN QUERY SELECT p_year, p_month, v_emp, v_pst, v_td;
END;
$$;

-- The preview gains a `source` column ('dtr' | 'external' | 'none'), which
-- changes its result type, so it is dropped and recreated.
DROP FUNCTION IF EXISTS hris.preview_attendance_vl_deduction(INT, INT, UUID);

CREATE FUNCTION hris.preview_attendance_vl_deduction(
  p_year INT,
  p_month INT,
  p_employee_id UUID DEFAULT NULL
)
RETURNS TABLE (
  employee_id         UUID,
  total_minutes       INT,
  required_days       NUMERIC,
  already_posted_days NUMERIC,
  delta_days          NUMERIC,
  source              TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
DECLARE
  v_vl_id UUID;
BEGIN
  SELECT id INTO v_vl_id FROM hris.leave_types WHERE code = 'VL' LIMIT 1;
  IF v_vl_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH candidates AS (
    SELECT c.id, m.minutes AS mins, m.source AS src
      FROM hris.attendance_deduction_candidates(p_year, p_month, p_employee_id) AS c(id)
      CROSS JOIN LATERAL hris.attendance_deduction_month_minutes(c.id, p_year, p_month) m
  ),
  posted AS (
    SELECT lca.employee_id,
           COALESCE(SUM(lca.amount), 0)::NUMERIC AS days
      FROM hris.leave_credit_accruals lca
      WHERE lca.leave_type_id = v_vl_id
        AND lca.year  = p_year
        AND lca.month = p_month
        AND lca.source = 'attendance_deduction'
      GROUP BY lca.employee_id
  )
  SELECT
    c.id,
    c.mins,
    ROUND(-1.0 * c.mins / 480.0, 3),
    COALESCE(p.days, 0),
    ROUND(ROUND(-1.0 * c.mins / 480.0, 3) - COALESCE(p.days, 0), 3),
    c.src
  FROM candidates c
  LEFT JOIN posted p ON p.employee_id = c.id;
END;
$$;

-- ── 5. One-time resync of balances that missed their deductions ──────────
-- Every (employee, leave type, year) that has attendance_deduction rows gets
-- total_credits = SUM(ledger). Keys without such rows are not touched. In
-- production on 2026-11-16 this lowers 311 employees' 2026 VL by 1,003.232
-- days in total (largest single drop 32.935); 3 balances end slightly
-- negative (lowest -0.775). Re-running is a no-op.
INSERT INTO hris.leave_credits (employee_id, leave_type_id, year, total_credits)
SELECT a.employee_id, a.leave_type_id, a.year, SUM(a.amount)
  FROM hris.leave_credit_accruals a
 WHERE (a.employee_id, a.leave_type_id, a.year) IN (
         SELECT d.employee_id, d.leave_type_id, d.year
           FROM hris.leave_credit_accruals d
          WHERE d.source = 'attendance_deduction'
       )
 GROUP BY a.employee_id, a.leave_type_id, a.year
ON CONFLICT (employee_id, leave_type_id, year)
DO UPDATE SET total_credits = EXCLUDED.total_credits
WHERE hris.leave_credits.total_credits IS DISTINCT FROM EXCLUDED.total_credits;
