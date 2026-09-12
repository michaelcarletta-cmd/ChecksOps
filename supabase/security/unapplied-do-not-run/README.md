# NOT SAFE TO APPLY / NOT A MIGRATION PATH

This directory is **not** discovered by `supabase db push`, GitHub Supabase
integration, Lovable merge deploys, oneshots, or `aws/db-copy` inventory.

Do not copy, symlink, or glob these files into `supabase/migrations/`.
Direct psql is forbidden.

The only authorized execution method is
`scripts/run-hosted-tax-profile-containment.mjs` after reviewing that
wrapper and the SHA-256 pins at a specific commit, with a separate
hosted-apply authorization. Remote execution is not performed by merging
this PR.
