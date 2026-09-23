# Supabase runtime contract retirement

Scope: remove hosted-Supabase SDK, credentials, and `src/integrations/supabase` from the AWS ChecksOps SPA. Accepted AWS production architecture is unchanged. **Do not deploy this candidate to production from this document.**

## Replacement boundary

Smallest safe change — import path only, no screen rewrites:

```
React application
  → src/integrations/aws/client.ts  (`api`, deprecated alias `supabase`)
  → AWS /data /storage /functions/v1 /auth /identity /public
```

Call sites keep `.from()` / `.functions.invoke()` so behavioral parity is mechanical.

## A. Supabase dependency map (Phase 1)

| Surface | Count | Location |
|---|---|---|
| `from(` tables | 711 calls / 172 files / 134 tables | `src/**/*.ts{,x}` via AWS client |
| `select` / `insert` / `update` / `delete` / `upsert` | 410 / 101 / 137 / 59 / 4 | same |
| `rpc(` | 89 calls / 64 names | AWS `/data/rpc` |
| `functions.invoke(` | 118 calls / 68 names / 62 files | AWS `/functions/v1/:name` |
| `storage.from(` | 18 calls / 5 buckets / 9 files | AWS `/storage` |
| `auth.*` | 42 files | Cognito via AWS client |
| realtime `channel(` | 10 hits | no-op + 15s polling fallback |
| `@supabase/supabase-js` in `src/` | **0** | removed |
| `src/integrations/supabase/**` | **0** | deleted |

Generated `src/types/database.ts` is TypeScript-only schema typing. It is not imported at runtime.

## B. AWS compatibility contract

| Supabase-shaped operation | Current AWS implementation | Callers | Replacement required? |
|---|---|---|---|
| `from().select/insert/update/delete` | `/data/query` + `/data/write` | 711 | Keep as ChecksOps query builder |
| `rpc(name)` | `/data/rpc` (+ review-decision / admin-delete specials) | 89 | Keep |
| `functions.invoke(name)` | `/functions/v1/:name` (+ CheckAlt money-path gate) | 118 | Keep |
| `storage.from().upload/download/createSignedUrl` | AWS storage adapter → S3 | 18 | Keep |
| `auth.getSession/signIn/signOut` | Cognito + `/identity/me` | 42 files | Keep |
| `channel()` | no-op | 10 | Keep no-op |
| Public sign/endorse | `/public/signature-*` `/public/endorsement` | Sign.tsx, Endorse.tsx | Hosted fallback **removed** |
| Verification XHR / unsubscribe GET | `awsFunctionsUrl()` → `/functions/v1/...` | 2 files | Hosted URL **removed** |

## C. Internal client

`src/integrations/aws/client.ts` is the ChecksOps client. Exports: `api`, `supabase` (alias), `mortgageApi`, `mortgageSupabase` (alias). Auth types live in `auth-types.ts`. Function errors live in `errors.ts`.

## D. `@supabase/supabase-js`

Removed from `package.json`, `package-lock.json`, and `bun.lock`. No `src/` import remains. AWS `npm run build` succeeds without the package.

## E. Application call-site migration

218+ files now import `@/integrations/aws/client`. Zero `src/` imports from `integrations/supabase`.

## F. Generated types

Moved `src/integrations/supabase/types.ts` → `src/types/database.ts`. TypeScript-only. db-copy inventory paths updated.

## G. Legacy build

`npm run build`, `npm run dev`, and `npm run preview` are `--mode aws`. `build:aws` remains an alias.

## H. `.env.production` / `VITE_SUPABASE_*`

Repo `.env.production` has no hosted credentials. Vite always blanks those `import.meta.env` keys. `scripts/check-publish-keys.mjs` is a CI no-op.

## I. `supabase/` directory

| Path | Classification |
|---|---|
| `functions/**` (163) | STILL USED BY TESTS / MUST ARCHIVE FIRST |
| `migrations/**` (~800) | MUST ARCHIVE FIRST (schema history) |
| `security/**` | STILL USED BY TESTS |
| `config.toml`, `unapplied/**`, deploy notes | DEVELOPMENT/HISTORICAL |
| `.temp/**` | DEVELOPMENT/HISTORICAL |

Nothing UNKNOWN was deleted.

## J. Lovable remnants

Removed: `lovable-tagger`, CSP `*.lovable.app`, `previewAuthStorage`, Sign-link `freedomclaims.lovable.app`.

Kept: `.lovable/plan/**` (historical notes); `*.lovable.app` in `useTenantFilter` / `useCustomDomainTenant` so leftover preview hosts are not treated as custom tenant domains; R2 OG image object name that happens to contain `.lovable.app`.

## K–L. Search results

See `/opt/cursor/artifacts/supabase-search.txt` and `lovable-search.txt`. Remaining `supabase` hits in `src/` are the ChecksOps client export name and comments. Remaining `lovable` hits in `src/` are host-classification allowlists and comments.

## M. AWS regression

- Targeted retirement / portal / cutover / financial-TOTP / CloudFront: **37/37 pass**
- Write-path + CheckAlt shutdown: **39/39 pass**
- `npm run test:aws-api`: **1107 pass / 9 fail / 3 skip**. The 9 failures are disposable local PostgreSQL 16 `initdb` matrices (same as before this PR; +3 pass from new retirement tests).
- `npm run build` (`--mode aws`): success. Dist JS has no `supabase.co`, `@supabase/supabase-js`, or `VITE_SUPABASE_`.

## N. Behavioral differences from frozen production baseline

Expected: none for Cognito `/prep` traffic. Legacy hosted-Supabase fallback URLs are gone (intentional; that path is retired).

## O. Production changes

None. No deploy, no money movement, no production data edits.

## P. Remaining blockers to ZERO-SUPABASE (non-runtime)

- Optional mechanical rename of the `supabase` export alias to `api` at remaining call sites
- Archive (do not destroy) `supabase/migrations` and `supabase/functions`
- Historical docs / cutover notes still mention Supabase
- Known-app-domain allowlists still list `*.lovable.app`

## Q. Status

**SUPABASE RUNTIME REMOVAL COMPLETE — STAGING ACCEPTANCE REQUIRED**
