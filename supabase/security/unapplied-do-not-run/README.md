# NOT SAFE TO APPLY / NOT A MIGRATION PATH

This directory is **not** discovered by `supabase db push`, GitHub Supabase
integration, Lovable merge deploys, oneshots, or `aws/db-copy` inventory.

Do not copy, symlink, or glob these files into `supabase/migrations/`.
Direct psql is forbidden.

The only authorized execution method is
`scripts/run-hosted-tax-profile-containment.mjs` after reviewing that
wrapper, the SHA-256 pins, a root-owned distro `psql` with root-owned
parents, system CA `verify-full` trust (`/etc/ssl/certs/ca-certificates.crt`),
and the exact authorized git commit SHA at a named-branch checkout.
This wrapper has not been executed against hosted Supabase. Hosted
execution is still unauthorized. Direct psql is forbidden. Remote
execution is not performed by merging this PR. Plaintext-at-rest remains
unresolved. The Tax/1099 error-banner PR must ship before apply.
SIGKILL/crash cleanup of temp credentials is not guaranteed.
