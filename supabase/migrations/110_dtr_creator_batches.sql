-- Migration 110: DTR Creator batches.
--
-- The DTR Creator (/dtr-creator) writes attendance for several employees of one
-- department at once, for days that have no record yet. It does NOT get its own
-- write path: for each employee it files an ordinary direct-apply correction
-- request (migration 068) holding only CREATE items (migration 067), applied
-- through apply_attendance_correction. The days it writes are therefore
-- source 'manual' + correction_locked like every other correction, survive a
-- biometric re-import, and are changed afterwards only through Attendance
-- Corrections.
--
-- What this adds is the thread back to the batch: every request one submission
-- filed carries the same dtr_batch_id, so "what did this run create" is one
-- query, and a reader of the corrections list can tell a batch-created day from
-- a hand-filed correction. NULL for every request filed any other way.

SET search_path TO hris, public, auth, extensions;

ALTER TABLE hris.attendance_correction_requests
  ADD COLUMN IF NOT EXISTS dtr_batch_id UUID;

COMMENT ON COLUMN hris.attendance_correction_requests.dtr_batch_id IS
  'Set when the DTR Creator filed this request; shared by every request one '
  'submission filed. NULL for corrections filed through the correction wizard.';

CREATE INDEX IF NOT EXISTS idx_acr_dtr_batch
  ON hris.attendance_correction_requests(dtr_batch_id)
  WHERE dtr_batch_id IS NOT NULL;
