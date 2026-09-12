# NOT SAFE TO APPLY / NOT A MIGRATION PATH

This directory is **not** discovered by `supabase db push`, GitHub Supabase
integration, Lovable merge deploys, oneshots, or `aws/db-copy` inventory.

Do not copy, symlink, or glob these files into `supabase/migrations/`.

The revoke script here remains unapplied until an authorized operator runs
that **exact file** with `psql` after the fail-closed preflight gate succeeds.
There is no `supabase db push` application method.
