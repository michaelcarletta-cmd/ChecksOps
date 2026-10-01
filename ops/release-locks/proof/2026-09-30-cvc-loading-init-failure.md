# PRODUCTION ACCEPTANCE FAILURE — CvCKsSsX init hang

Read-only diagnosis against the exact live artifact. No rollback, restore,
rebuild, SPA upload, Lambda, DB, IAM, Cognito, env, Moov, or data write
was performed in this task.

Recovery of `index-CvCKsSsX.js` is **not fully accepted** even though
compiled-marker tests passed.

## Live pin (still current)

| Field | Value |
|---|---|
| HTTPS entry | `/assets/index-CvCKsSsX.js` |
| Entry SHA256 | `cd55efcde625c03ab8bba60decec3c4d6b3bb53e3a8e45dd6a4c2b9991065007` |
| index.html SHA256 | `0dac8cbceba15a086567511c447279c6a439c9c120079ebebb19309a8bf24e89` |
| S3 version | `rLJElCrQEl1AqJJuW4YuKC.xuo06gfiV` |
| After ETag | `b2d4400446f1ef8b6a84896b5c11bcd2` |

Live HTTPS `index.html` still references this entry and still contains the
static `#initial-loader` text `Loading…`.

## First runtime failure

Not a missing composed chunk, not a `/prep` 4xx, and not a never-settling
React Query. The main module dies before React mounts.

1. `src/main.tsx` imports `App`.
2. `src/App.tsx` imports `src/integrations/supabase/client.ts`.
3. Compiled client init in live `index-CvCKsSsX.js`:

```
const RO="",AO="",OO=TO({hostname:PO(),authProvider:""}),L=OO?jO():aO(RO,AO,{auth:…})
```

4. `TO` is `shouldUseAwsChecksOpsBackendFor`. Baked `authProvider` is `""`.
5. Gate returns `false` on `checksops.com` / `www.checksops.com`.
6. `aO` is `createClient` from `@supabase/supabase-js` with empty URL/key
   (`--mode aws` does not load `.env.production`; `.env.aws` was absent).
7. `createClient("", "")` throws `supabaseUrl is required.`
8. `createRoot(…).render(…)` never runs. `AppErrorBoundary` never mounts.
9. The static HTML `#initial-loader` (`Loading…`) stays forever.

Node reproduction of that exact branch:

| Bake | Host | Gate | Client path | Throw |
|---|---|---|---|---|
| CvCKsSsX | checksops.com | false | `createClient("", "")` | `supabaseUrl is required.` |
| DSb / QDJi | checksops.com | true | `createAwsStagingClient()` | none |

Headless dump of `https://checksops.com/` after the entry script executed
still has `#initial-loader` and no React tree.

Compiled AWS helpers on CvCKsSsX confirm the same empty bake:

```
function hr(){return"".toLowerCase()==="cognito"}   // isAwsStaging → always false
function kn(){const e="", … return l_(e,t)}         // awsApiBaseUrl → ""
```

## Ruled out

| Hypothesis | Why not first failure |
|---|---|
| Failed dynamic chunk import | Entry and mapped chunks return 200; React never starts to lazy-load them |
| Cognito session restore hang | AWS adapter is not selected; `checksops.aws.staging.auth` is never read |
| Tenant / `tenants_public` query hang | `TenantProvider` never mounts |
| AWS adapter init | `createAwsStagingClient()` is not called |
| Missing #575 / #581 / #584 module | Compose files are in the graph; they are not reached |
| `/prep` API 4xx | Logo `/prep/branding/logo/…` still 200; app dies before API clients run |
| WhiteLabel `loading \|\| authLoading` spinner | That gate is downstream of a successful `supabase` export |

## Init compare

| Baked symbol | QDJiUFF1 (worked) | DSbVZXu8 (pre-recovery) | CvCKsSsX (live) |
|---|---|---|---|
| Client `authProvider` | `"cognito"` | `"cognito"` | `""` |
| `isAwsStaging()` | `"cognito"==="cognito"` | same | `""==="cognito"` → false |
| `createClient` URL/key | unused empty strings | unused empty strings | **used** empty strings |
| API base | `https://psr19uhop4.execute-api.us-east-1.amazonaws.com/staging` | same | `""` |
| `VITE_APP_URL` | `https://staging.checksops.com` | same | default / empty |
| Supabase project id present | yes (unused) | yes (unused) | yes (unused) |

Working builds also baked empty Supabase URL/key. They stay healthy because
the Cognito gate takes the AWS adapter and never calls `createClient`.

## Why composed files are not the first loss

Overlays from #575 / #581 / #584 (WalletOps, insured branding / WhiteLabel
settings, billing / Moov) import `supabase` the same way DSb already did.
They expect the AWS adapter at runtime. They did not introduce a missing
TSX file. The new hang is the empty `VITE_AUTH_PROVIDER` bake from
`npm run build:aws` without `.env.aws` / production AWS env.

Logo GETs still work because `tenantLogoUrl` falls back empty API URL to
same-origin `/prep`. That is a separate helper, not the `supabase` export.

## Smallest additive correction (not applied)

Do **not** restore DSb or QDJi. Do **not** change Lambda / DB / IAM /
Cognito / env / Moov / data. Do **not** upload from this diagnosis.

Rebuild the **same compose source** with a production AWS Vite env (copy
privately from `.env.production.aws.example`; do not commit secrets):

```
VITE_AUTH_PROVIDER=cognito
VITE_APP_URL=https://checksops.com
VITE_CHECKSOPS_API_URL=/prep
VITE_AWS_REGION=us-east-1
VITE_COGNITO_USER_POOL_ID=us-east-1_h00WorYMT
VITE_COGNITO_USER_POOL_CLIENT_ID=3ja9fqaq2fjkv3i6up2varcqpe
```

Then, only after a later explicit apply approval, upload the **new** hashed
entry. Setting only `VITE_AUTH_PROVIDER=cognito` is not enough: CvCKsSsX
also baked `awsApiBaseUrl` as `""`, so API calls would miss `/prep`.

Optional later fail-closed (still needs a rebuild): refuse `vite build
--mode aws` when `VITE_AUTH_PROVIDER !== "cognito"`. Do not hostname-only
force AWS on an empty provider; `tests/tenant-branding.test.mjs` currently
requires empty provider → no AWS backend.

## Stop

No production write. Live artifact left unchanged. Wait for a separate
approved rebuild + upload of a new hash.
