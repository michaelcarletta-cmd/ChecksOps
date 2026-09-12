# NOT SAFE TO APPLY / DESIGN ONLY

This directory is **not** a migration path.

Do not copy, symlink, or glob these files into `supabase/migrations`,
`aws/write-path/sql`, `aws/workflows/sql`, `aws/financial/sql`, `aws/rls/sql`,
or any oneshot Lambda. Production PostgREST GRANT/RLS work belongs in a
separately reviewed database-security PR.
