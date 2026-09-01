-- Post-restore READ-ONLY inspection of Supabase-specific public objects.
-- PREPARATION ONLY. Do not DROP or ALTER from this file until classified.
-- Live inventory: 40 auth.uid, 4 net.*, 2 cron.*, 5 vault, 5 pgmq.

SELECT n.nspname AS schema, p.proname AS function_name, 'auth.uid' AS dependency
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ILIKE '%auth.uid%'
UNION ALL
SELECT n.nspname, p.proname, 'net.*'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~* 'net\.'
UNION ALL
SELECT n.nspname, p.proname, 'cron.*'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~* 'cron\.'
UNION ALL
SELECT n.nspname, p.proname, 'vault/decrypted_secrets'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~* 'vault\.|decrypted_secrets'
UNION ALL
SELECT n.nspname, p.proname, 'pgmq.*'
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prokind = 'f' AND pg_get_functiondef(p.oid) ~* 'pgmq\.'
ORDER BY 3, 2;

SELECT tgname AS trigger_name, relname AS table_name, pg_get_triggerdef(t.oid) AS definition
FROM pg_trigger t
JOIN pg_class c ON c.oid = t.tgrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND NOT t.tgisinternal
  AND pg_get_triggerdef(t.oid) ~* 'net\.|cron\.|vault\.|pgmq\.|auth\.uid'
ORDER BY 1;

SELECT polname, tablename, cmd
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, polname;
