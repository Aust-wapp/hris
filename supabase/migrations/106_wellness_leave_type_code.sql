-- Migration 106: add the Wellness Leave code to hris.leave_type_code.
--
-- On its own because Postgres refuses to use an enum value in the same
-- transaction that added it ("unsafe use of new value"). Migration 107 creates
-- the leave type and grants the credits.

SET search_path TO hris, public, auth, extensions;

ALTER TYPE hris.leave_type_code ADD VALUE IF NOT EXISTS 'WL';
