-- Migration 108: tardy/undertime is charged to VL only once the month is over.
--
-- Until now every biometric import posted the month-to-date deduction, so a
-- month still in progress (November 2026 when this was written) was already
-- lowering VL balances. HR wants a month charged only after it closes.
--
-- 1. hris.attendance_deduction_month_minutes returns 0 minutes (source
--    'open_month') for the current Asia/Manila month and any later one. The
--    posting function and the preview both read it, so:
--      * imports during the month no longer post anything for it;
--      * a month that already has postings gets a reversing delta the next
--        time it is recomputed — the history is kept, nothing is deleted.
--    The DTR and Attendance Report still show the month's tardiness and
--    undertime; they use compute_attendance_deduction_minutes directly.
--
-- 2. A daily pg_cron job (00:20 Manila, after the 00:05 accrual) recomputes
--    the previous month for every employee. On the 1st that charges the month
--    that just closed; on later days it is a no-op unless something changed.
--
-- 3. The current month is recomputed now, which reverses whatever was already
--    posted for it. Applied on 2026-11-17 that reverses November's
--    month-to-date deductions (about 450 VL days across 301 employees); on
--    Dec 1 the cron charges November in full.

SET search_path TO hris, public, auth, extensions;

-- ── 1. Open months charge nothing ────────────────────────────────────────
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
  -- The month is still in progress (or in the future): charge nothing yet.
  IF v_start >= date_trunc('month', (now() AT TIME ZONE 'Asia/Manila'))::DATE THEN
    minutes := 0;
    source  := 'open_month';
    RETURN;
  END IF;

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

-- Same body as 105 except the note, which says why an open month's postings
-- were reversed.
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
    CASE v_mins.source
      WHEN 'open_month' THEN format(
        'Month not yet closed: deduction deferred for %s-%s (total 0 min, delta %s d)',
        p_year, lpad(p_month::text, 2, '0'), v_delta
      )
      ELSE format(
        '%s for %s-%s (total %s min, delta %s d)',
        CASE v_mins.source
          WHEN 'external' THEN 'External DTR undertime deduction'
          ELSE 'Tardy/undertime auto-deduction'
        END,
        p_year, lpad(p_month::text, 2, '0'), v_mins.minutes, v_delta
      )
    END
  );

  -- Keep the balance in step with the ledger (migration 105, section 4).
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

-- ── 2. Charge the month that just closed ─────────────────────────────────
CREATE OR REPLACE FUNCTION hris.cron_run_closed_month_vl_deduction()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = hris, public, auth, extensions
AS $$
DECLARE
  v_prev DATE := (date_trunc('month', (now() AT TIME ZONE 'Asia/Manila'))
                  - INTERVAL '1 day')::DATE;
  r      RECORD;
BEGIN
  SELECT * INTO r
    FROM hris.apply_attendance_vl_deduction(
      EXTRACT(YEAR FROM v_prev)::INT,
      EXTRACT(MONTH FROM v_prev)::INT,
      NULL
    );
  RETURN format(
    'VL deduction for %s-%s: employees=%s posts=%s days=%s',
    r.year_v, lpad(r.month_v::text, 2, '0'), r.employees_v, r.posts_v, r.total_days
  );
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'attendance-vl-deduction-closed-month') THEN
    PERFORM cron.unschedule('attendance-vl-deduction-closed-month');
  END IF;
END $$;

-- 16:20 UTC = 00:20 Asia/Manila, after the 00:05 VL/SL accrual.
SELECT cron.schedule(
  'attendance-vl-deduction-closed-month',
  '20 16 * * *',
  $$ SELECT hris.cron_run_closed_month_vl_deduction(); $$
);

-- ── 3. Reverse what is already posted for the open month ─────────────────
SELECT *
  FROM hris.apply_attendance_vl_deduction(
    EXTRACT(YEAR  FROM (now() AT TIME ZONE 'Asia/Manila'))::INT,
    EXTRACT(MONTH FROM (now() AT TIME ZONE 'Asia/Manila'))::INT,
    NULL
  );
