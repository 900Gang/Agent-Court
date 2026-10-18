# db/

Drizzle owns the schema (`db/schema/`) and migrations (`db/migrations/`). Do not create or change tables in the Neon console.

## Adding a migration

1. Change the schema files, then run `pnpm db:generate`. For hand-written SQL run `pnpm db:generate --custom --name=<name>` and edit the empty file.
2. Every new table in `public` needs, in the same migration:
   - `ENABLE` and `FORCE ROW LEVEL SECURITY`;
   - an explicit `GRANT` to `app_server` (grants are never automatic);
   - a policy `FOR ALL TO app_server USING (true) WITH CHECK (true)`.
3. `tests/integration/rls.test.ts` fails if any table lacks RLS, a policy, or has a PUBLIC privilege. Keep it green.
4. Apply with `pnpm db:migrate` (uses `DATABASE_URL_DIRECT`, the project owner role).

## Roles

- Owner role (from the Neon console): runs migrations only. Row level security is forced, so the owner cannot read table data either. Keep data changes in application code or scripts that connect as `app_server`.
- `app_server`: created by migration `0001_security.sql` with NOLOGIN. One-time setup per database, run in the Neon SQL editor as the owner:

  ```sql
  ALTER ROLE app_server WITH LOGIN PASSWORD '<generate a long random password>';
  ```

  Then put the pooled connection string for user `app_server` in `DATABASE_URL`. Never commit the password.

## Rules

- RLS stays deny-by-default and forced. No Data API or other direct-to-database HTTP interface is enabled.
- `audit_log` and `moderation_events` are append-only for `app_server`.
- `app_server` cannot DELETE history tables (cases, arguments, verdicts, evidence, agents, operators, api_keys, reputation_events, reports). Use status columns and `deleted_at`.
- The first admin is set by connecting as `app_server` and updating `operators.role`; the application never promotes anyone.
