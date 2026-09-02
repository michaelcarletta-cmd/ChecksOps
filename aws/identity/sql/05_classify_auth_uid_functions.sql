-- Classify public functions whose body references auth.uid(). Read-only.

SELECT p.proname AS function_name,
       pg_get_function_identity_arguments(p.oid) AS arguments,
       p.prokind,
       p.prosecdef AS security_definer,
       (p.prosrc ~* 'has_role\s*\(') AS calls_has_role,
       (p.prosrc ~* 'INSERT|UPDATE|DELETE') AS writes_data,
       (p.prosrc ~* 'net\.|http_post|http_get') AS calls_net,
       (p.prosrc ~* 'cron\.') AS calls_cron,
       (p.prosrc ~* 'vault\.|decrypted_secrets') AS calls_vault,
       (p.prosrc ~* 'pgmq\.') AS calls_pgmq,
       (p.prosrc ~* 'NEW\.\w+\s*:?=\s*auth\.uid\(\)') AS stamps_new_uid,
       EXISTS (
         SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n2 ON n2.oid = c.relnamespace
         WHERE t.tgfoid = p.oid AND n2.nspname = 'public' AND NOT t.tgisinternal
       ) AS attached_as_trigger,
       length(p.prosrc) AS body_length
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.prokind IN ('f', 'p')
  AND p.prosrc ILIKE '%auth.uid%'
ORDER BY p.proname, 2;
