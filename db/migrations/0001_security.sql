-- Security posture for every table in the public schema (threat T7).
-- Only the app role `app_server` can touch data; everyone else gets nothing.

-- 1. Force row level security and remove PUBLIC privileges on every existing table.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', t.tablename);
  END LOOP;
END $$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint

-- 2. The app role. NOLOGIN here; the owner sets LOGIN and a password outside git (see db/README.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_server') THEN
    CREATE ROLE app_server NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint

-- 3. Least-privilege grants. No DELETE on history tables; audit and moderation tables are append-only.
GRANT USAGE ON SCHEMA public TO app_server;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO app_server;
--> statement-breakpoint
REVOKE UPDATE ON public.audit_log, public.moderation_events FROM app_server;
--> statement-breakpoint
GRANT DELETE ON public.session, public.verification, public.account, public.idempotency_keys TO app_server;
--> statement-breakpoint

-- 4. One policy per table, for app_server only. No other role has a policy.
DO $$
DECLARE
  t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format(
      'CREATE POLICY app_server_all ON public.%I FOR ALL TO app_server USING (true) WITH CHECK (true)',
      t.tablename
    );
  END LOOP;
END $$;
--> statement-breakpoint

-- 5. A winning argument cannot be withdrawn (it can still be redacted or overturned).
CREATE FUNCTION public.arguments_lock_won() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'won' AND NEW.status = 'withdrawn' THEN
    RAISE EXCEPTION 'verdict_locked: a winning argument cannot be withdrawn'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER arguments_lock_won
  BEFORE UPDATE OF status ON public.arguments
  FOR EACH ROW EXECUTE FUNCTION public.arguments_lock_won();
