-- Migration 111: per-user switch for a Department Admin's DTR Creator access.
--
-- The DTR Creator (migration 110) was first open to one office by rule: a
-- Department Admin assigned to the department coded CHO. That made access a
-- property of the department rather than of the account, so granting it to a
-- second office meant a code change. This turns it into a per-ACCOUNT switch
-- edited from /admin/users, beside the Attendance Corrections switch
-- (migration 076).
--
-- Default FALSE, unlike 076: the DTR Creator writes attendance with no HR
-- approval step, so no Department Admin should gain it without someone ticking
-- the box. The backfill below keeps exactly the accounts that hold it today —
-- active Department Admins of CHO — so nobody loses access by this change.
--
-- Scope: the dept-admin roles ONLY (department_admin and the composite
-- department_admin_and_department_head — see isDeptAdmin in
-- src/lib/auth-helpers.ts). Super Admins and DTR Managers reach every
-- department by role and nothing reads the column for them.

SET search_path TO hris, public, auth, extensions;

ALTER TABLE hris.user_profiles
  ADD COLUMN IF NOT EXISTS can_access_dtr_creator boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN hris.user_profiles.can_access_dtr_creator IS
  'Department Admin only: may this account open the DTR Creator for its own department. Ignored for every other role.';

UPDATE hris.user_profiles up
SET can_access_dtr_creator = true
FROM hris.departments d
WHERE up.department_id = d.id
  AND upper(trim(d.code)) = 'CHO'
  AND up.roles && ARRAY['department_admin', 'department_admin_and_department_head']::hris.user_role[]
  AND up.can_access_dtr_creator = false;
