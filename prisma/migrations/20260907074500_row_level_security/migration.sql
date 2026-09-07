-- Row-level security.
--
-- The application connects as bailey_app, which owns nothing. Postgres applies
-- row-level security to any role that is neither the table owner nor a
-- superuser, so a query issued by the application is filtered by the database
-- itself. Migrations and administrative jobs continue to run as the owner and
-- are deliberately not subject to these policies.
--
-- Two session variables carry the request context:
--   app.current_user_id      set once the session cookie is validated
--   app.current_organisation set once an organisation has been selected
--
-- Both are read with missing_ok = true and passed through NULLIF, so an unset
-- or empty value yields NULL. A comparison against NULL is never true, which
-- means the failure mode of forgetting to set the context is "no rows", not
-- "every row".

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bailey_app') THEN
    CREATE ROLE bailey_app LOGIN PASSWORD 'bailey_local_dev';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO bailey_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO bailey_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bailey_app;

-- Helper expressions, defined once so a policy cannot drift from the others.
CREATE OR REPLACE FUNCTION app_current_organisation() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_organisation', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid $$;

-- An organisation row is visible only when it is the selected organisation.
-- Listing the organisations a user belongs to goes through memberships, which
-- has its own escape hatch below; doing it here instead would require a
-- subquery against memberships and risk recursive policy evaluation.
ALTER TABLE "organisations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "organisations"
  FOR ALL
  USING (id = app_current_organisation())
  WITH CHECK (id = app_current_organisation());

-- Memberships are readable either within the selected organisation, or by the
-- user they belong to. The second case is what lets a freshly authenticated
-- session discover which organisations it can select.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "memberships"
  FOR ALL
  USING (
    "organisationId" = app_current_organisation()
    OR "userId" = app_current_user_id()
  )
  WITH CHECK ("organisationId" = app_current_organisation());

-- Everything else is scoped strictly to the selected organisation.
ALTER TABLE "invitations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "invitations"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

ALTER TABLE "sites" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "sites"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

ALTER TABLE "scan_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "scan_runs"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

ALTER TABLE "findings" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "findings"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

ALTER TABLE "issues" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "issues"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

ALTER TABLE "issue_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "issue_events"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

-- Audit events with a NULL organisation are platform-level and are
-- intentionally invisible to tenants.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "audit_events"
  FOR ALL
  USING ("organisationId" = app_current_organisation())
  WITH CHECK ("organisationId" = app_current_organisation());

-- Deliberately NOT under row-level security:
--
--   users     a user is not owned by an organisation; the same person may
--             belong to several. Scoping is by identity and is enforced in
--             the application, which only ever loads the authenticated user.
--   sessions  reachable only by the hash of a token the caller already holds.
--
-- This is recorded rather than left implicit because "which tables are not
-- protected, and why" is the first question worth asking of a design like this.
