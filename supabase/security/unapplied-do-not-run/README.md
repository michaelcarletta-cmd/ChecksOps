# NOT SAFE TO APPLY / NOT A MIGRATION PATH

This directory is **not** discovered by `supabase db push`, GitHub Supabase
integration, Lovable merge deploys, oneshots, or `aws/db-copy` inventory.

Do not copy, symlink, or glob these files into `supabase/migrations/`.
Direct psql is forbidden.

The only authorized execution method is
`scripts/run-hosted-tax-profile-containment.mjs` after reviewing that
wrapper, the SHA-256 pins, the execution-environment `psql` binary, and
system CA `verify-full` trust (`/etc/ssl/certs/ca-certificates.crt`) at a
specific commit, with a separate hosted-apply authorization. This wrapper
has not been executed against hosted Supabase. Direct psql is forbidden.
Remote execution is not performed by merging this PR. Plaintext-at-rest
remains unresolved. The Tax/1099 error-banner PR must ship before apply.
