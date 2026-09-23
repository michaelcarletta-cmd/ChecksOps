# Supabase runtime contract retirement

Scope: remove hosted-Supabase SDK, credentials, and the `integrations/supabase` application client from the AWS ChecksOps SPA. The accepted AWS production architecture is unchanged. This is a staging-tested candidate. **Do not deploy to production from this document.**

## Replacement boundary

Smallest safe change:

```
React application
  → src/integrations/aws/client.ts  (ChecksOps client; still exposes from/invoke)
  → AWS /data /storage /functions/v1 /auth /identity /public
```

Call sites keep `supabase.from` / `supabase.functions.invoke` method names so hundreds of screens are not rewritten. The export `supabase` is an alias of `api`. There is no hosted `createClient` fallback.

## A–Q report lives in the PR description and agent final report.

### supabase/ directory classification (Phase 8)

| Path | Classification | Why |
|---|---|---|
| `supabase/functions/**` (163 functions) | **3. STILL USED BY TESTS/DEVELOPMENT** / **2. MUST MIGRATE/ARCHIVE FIRST** | Historical Edge source and AWS Class A name inventory. Tests import `_shared`. Do not delete. |
| `supabase/migrations/**` (~800 files) | **2. MUST MIGRATE/ARCHIVE FIRST** | Documents the PostgreSQL schema history that RDS inherited. Archive, do not destroy. |
| `supabase/config.toml` | **3. DEVELOPMENT/HISTORICAL ONLY** | Hosted project config. Not loaded by `build:aws`. |
| `supabase/security/**` | **3. STILL USED BY TESTS/DEVELOPMENT** | Tax-profile containment tests and unapplied SQL. |
| `supabase/unapplied/**` | **3. DEVELOPMENT/HISTORICAL ONLY** | Ledger backfill notes. Not auto-applied. |
| `supabase/m6.2n-deploy-*.md` | **3. DEVELOPMENT/HISTORICAL ONLY** | Historical deploy notes. |
| `supabase/.temp/**` | **3. DEVELOPMENT/HISTORICAL ONLY** | CLI cache. |

No `UNKNOWN` items were deleted.
