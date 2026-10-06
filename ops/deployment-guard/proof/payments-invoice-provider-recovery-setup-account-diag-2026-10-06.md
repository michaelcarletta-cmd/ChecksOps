# Invoice Recovery diagnose — “Set up your payment account first.”

**STOP.** Read-only. No deploy, restore, remapping, onboard, flag flip, SQL,
RLS, Cognito, identity, merchant, or Security Hardening change. Tests 1–6
were **not** executed. Invoice Recovery is **not** STAGING ACCEPTED.
The repair below was **not** applied.

Inspected `2026-10-06T19:15Z`. Adapter `writesAuthorized=false`. Write
calls: **none**. Historical `3JRN…` / `0tBb…` / `HFJ8…` / `DR9wRQUG` were
not restored.

## Precise failing condition

The toast is **not** KYB copy from `VerificationDocumentsPanel`. It is the
Invoice Recovery create/send preflight.

```
UI InvoicesTab.submit
  → useMoovInvoices.createInvoice
  → supabase.functions.invoke("moov-invoice")
  → POST /functions/v1/moov-invoice  { action: "create" | "create_and_send" }
  → wrap() in moov-functions.mjs
      withIdentityWrite → request.app_user_id
      moovParityContext:
        requireParityEnabled('moov')
          master AWS_PROVIDER_EXECUTION_ENABLED=false → skip production_execution_blocked
          AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true → continue
        loadTenantMoovEnv(tenants.moov_environment)
        effectiveMoovEnvironment() → always 'sandbox' while master is off
        bind sandbox credentials only
        ctx.environment hardcoded 'sandbox'
  → invoice handler (moov-onboard.mjs) dynamic-imports runProviderInvoiceAction
  → requireMoovProviderEnvironment(ctx) → environment='sandbox'
  → loadMoovAccount(client, tenantId, 'sandbox')
       SELECT * FROM payment_provider_accounts
       WHERE tenant_id = $1 AND provider = 'moov' AND environment = $2
       ORDER BY updated_at DESC NULLS LAST LIMIT 1
  → failClosedMissingAccount(account, 'sandbox')
       if account?.provider_account_id → continue
       if environment === 'production' → HTTP 503
            "Production payment account could not be resolved."
       else → HTTP 409 { error: "Set up your payment account first." }
  → useMoovInvoices.onError toast
       title: "Invoice error"
       description: data.error
```

`loadMoovAccount` does **not** filter `onboarding_status`,
`connection_status`, `disabled`, or capabilities. The only eligibility
gate is a non-empty `provider_account_id` on the **sandbox** row.

Invoice Recovery never reads `tenants.moov_account_id`. The Payments UI
`readTenantPaymentAccount` does: it uses `tenants.moov_account_id` plus
`payment_provider_accounts` filtered by `tenant_id` + `provider` only
(**no** `environment`). The UI can therefore look connected while invoice
create fail-closes.

This 409 is the designed missing-sandbox-merchant contract, not the
obsolete 5480 local persist path.

## Fresh live fingerprints

| Target | Current | vs 19:09Z / 15:17Z |
|---|---|---|
| `origin/main` | `309d6d84f38dc8bab0374b55f8fa7315f52be6d7` (PR #734) | unchanged this inspect |
| Lambda CodeSha256 | `YEYAGPRlupCVeMQZ2hLZ5V2VknnKDo+22g4TaGvWTQI=` | unchanged |
| RevisionId | `aadb9f6f-979b-49a6-a6b7-d14c41bdd0c9` | unchanged |
| LastModified | `2026-10-06T01:08:51Z` | unchanged |
| Members | **6488** | unchanged |
| ZIP origin | `fresh-live-download` (19:09Z; CodeSha256 reconfirmed 19:15Z) | unchanged |
| SPA entry | `/assets/index-Dq1xEBa5.js` | unchanged |
| `index.html` SHA-256 | `ea92cb1ae60bc1411b190ccfbfa51fb9af0f41f61f7a1cfca317821c2f2843b6` | unchanged |
| Last-Modified | `2026-10-06T01:15:47Z` | unchanged |

Flags unchanged: `AWS_PROVIDER_EXECUTION_ENABLED=false`,
`AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=true`, `AWS_MOOV_ENABLED=false`,
`AWS_EMAIL_MODE=sink`, `AWS_PROVIDER_WEBHOOK_DRY_RUN=true`,
`AWS_PROVIDER_LIVE_READS_ENABLED=false`, `CHECKSOPS_ENV=staging`.

## Invoice Recovery member hashes — unchanged

| Member | SHA-256 | Match |
|---|---|---|
| `invoice-provider.mjs` | `1b219a8a24ef8faf4b5db888dd6f772a9f04b3eb0ec2b869b76cd3b0b7d54e24` | yes |
| `invoice-actions.mjs` | `1786e2d84219379396311450532aa5963ff1ea52d4514c8d4766acc4c7f9c141` | yes |
| `providers/parity/moov-functions.mjs` | `a8e94a696a25ab0404f4763b21b53a2d7ffb1e21beedefb25da0e12646bd4a99` | yes |
| `providers/parity/db.mjs` | `f5947d9e19ca8bead3f5712b98c67f196eee3ab496afca028fd05fefbebe5f3e` | yes |

Protected (not owned; recorded only):

| Member | SHA-256 |
|---|---|
| `providers/parity/caller.mjs` | `1958eaa287ad2623d8cff9885c56cbb1948d069d2dd34093a56ac08e669c0470` |
| `sandbox-flags.mjs` | `28e98700e3875b2400440bf3e664e5b2197093c16ec5e01bc4ea34f1be29bcf7` |
| `provider-flags.mjs` | `29f5a7487fb6b911e6ca46780a3a991293efd19b1d1ee8b6199af8915196f622` |
| `public-invoice.mjs` | `e2d5ea84d231608775e34660051a5a5a6f119d331f4b3ae5fcd60e24fceff389` |

Collection V2 members remain present (`tenant-collection-v2.mjs`
`dfa85b88…`). They were not overwritten.

## Concurrent origin/main (not reverted)

Fetched `2026-10-06T19:15Z`. `origin/main` is still
`309d6d84f38dc8bab0374b55f8fa7315f52be6d7`
(`Merge pull request #734 … security/lambda-overlay-apply-flag`,
2026-10-06 14:59:24 -0400). No new main commits since the previous
Invoice Recovery inspect. Security Hardening movement earlier today
(#722 / #733 / #734) did not change the Invoice Recovery Lambda/SPA
runtime (LastModified 01:08–01:15Z, before those merges). Main was
**not** rolled back.

## Freedom `2eff5f1a-929d-4ce3-9a8b-cd96b98df42a`

### Live-proven this run

| Check | Result |
|---|---|
| `tenants_public` | HTTP 200. `id=2eff5f1a-…`, name `Freedom Adjustment`, slug `freedom`, `subscription_status=active` |
| View columns | branding only (`id,name,slug,logo_url,colors,domain,subscription,plan,partner_code`). **No** `payment_provider` / `moov_*` / `moov_environment` |
| Unauthenticated `payment_provider_accounts` `/data/query` | HTTP **401** `missing_cognito_token` (API gate; not a public table) |
| `GET /db-readonly-validate` (no identity) | HTTP 503 / `ok:false`; `currentUser=checksops`; `rlsMode=on`; `failClosedWithoutIdentity=true` |
| `payment_provider_accounts` catalog | present; RLS enabled; `tenantSensitive=true`; application-role `rowCount=0`; `expectedCount=3` (restore inventory); `countMatchesRestore=false`; `failClosedWithoutIdentity=true` |
| Catalog privileges (app role) | SELECT true, INSERT false, UPDATE true (under RLS), DELETE false. No write was issued. |
| Operator UAT | Authenticated as `mcarletta@freedomadj.com` in Freedom; UI returned this exact 409 string |
| This Cloud Agent session | No Freedom JWT. `/identity/me` and Freedom-member `payment_provider_accounts` were **not** called |

### Not live-proven as table owner this run

Freedom `payment_provider_accounts` columns (provider, environment,
`provider_account_id`, onboarding/status, disabled) were **not** SELECTed
as table owner. `checksops_admin` was not used. No merchant id is printed.

### Official historical evidence (not restore authority)

- `aws/financial/PROVIDER_SANDBOX_VALIDATION.md` and `SANDBOX_RESULTS.md`:
  RDS Freedom/C1C `payment_provider_accounts` are labeled
  **`environment=production`**. Those IDs must not be overwritten with
  sandbox IDs and must not be used for a “sandbox” transfer.
- Restore inventory (`EXPECTED_ROW_COUNTS` / first-copy status):
  **3** `payment_provider_accounts` rows table-owner.
- `caller.mjs` isolation: unique `(tenant_id, provider, environment)`.
  Staging always binds `environment='sandbox'` so restored production
  rows are not overwritten and are not selected.

### Answers to the required Freedom questions

| Question | Determination |
|---|---|
| Does a row currently exist? | **Table-owner live columns unproven.** Restore inventory expects 3 rows. Official financial docs treat Freedom as having a **production** Moov mapping. Isolation tenants have 0 rows (previously live-proven). Freedom-member 409 means Invoice Recovery did **not** see a sandbox row with `provider_account_id`. |
| Provider | Expected **`moov`**. Invoice Recovery queries `provider='moov'` only. |
| Environment | Official: **`production`**. Invoice Recovery query: **`sandbox`**. |
| Merchant / status | Not printed. `loadMoovAccount` ignores status/disabled; only `provider_account_id` presence matters. |
| Sandbox vs production | Official Freedom mapping is **production**. Staging Invoice Recovery is **sandbox-only**. |
| Can Invoice Recovery see it? | **No**, if the only Freedom row is `environment=production` or missing / `provider_account_id` null. The query cannot see a production row. |
| Is RLS hiding it? | Unauthenticated: API 401, then app-role 0 rows (expected fail-closed). A Freedom member should pass `aws_can_access_tenant(tenant_id)`. Operator 409 as `mcarletta` therefore makes RLS-hide of a **sandbox** row less likely than a missing sandbox row / null `provider_account_id`. RLS would also hide a production row from isolation tenants (previously proven). |
| Eligibility/status fail? | **No status filter.** A connected-but-restricted sandbox row would still pass this 409 gate. |
| Schema mismatch? | **Yes, lookup mismatch — not a broken table.** Code expects `(tenant_id, provider='moov', environment='sandbox', provider_account_id)`. Unique key is `(tenant_id, provider, environment)`. UI/tenant columns (`tenants.moov_account_id`, unscoped provider row) are a different record. |
| Code regression vs data/config? | **Data / configuration / intentional staging isolation. Not an Invoice Recovery hash regression.** Owned hashes are exact. The 409 string is the current recovered contract. |

## Classification

**Not an Invoice Recovery code regression.**

The live owned members still implement INV3/INV6 provider-backed create.
They fail closed when the **sandbox** merchant mapping is absent. Freedom’s
restored merchant, per official financial isolation, is **production**.
Staging `moovParityContext` refuses production credentials and never
falls back production → sandbox.

Enabling `AWS_PROVIDER_EXECUTION_ENABLED` would **not** fix this: 
`requireParityEnabled` would then return `production_execution_blocked`
before account lookup. Pointing Invoice Recovery at the production
`provider_account_id` would violate the documented isolation contract.

## Smallest forward-compatible repair (NOT APPLIED)

Do **not**:

- enable `AWS_PROVIDER_EXECUTION_ENABLED` or `AWS_MOOV_ENABLED`
- overwrite Freedom’s production `payment_provider_accounts` with sandbox IDs
- restore historical Lambda/SPA packages
- change RLS / grants
- remap `mcarletta` or create a new identity
- use production Moov credentials on staging

After a Freedom-authenticated read (this operator session, or a later
authorized inspect) confirms production-only vs missing vs null
`provider_account_id`, the smallest compatible fix is:

1. **Preferred:** create a **separate** `environment='sandbox'`
   `payment_provider_accounts` row for Freedom via the existing sandbox
   onboard path (new sandbox merchant). Do not remap or overwrite the
   production row. Unique `(tenant_id, provider, environment)` already
   allows both to coexist.
2. **Out of this chat’s authority:** a later authorized compose that can
   resolve sandbox eligibility without using production IDs, without
   weakening isolation.

This diagnose does **not** authorize that onboard or compose.

## STAGING ACCEPTED?

**No.** Tests 1–6 remain blocked on a sandbox merchant mapping that
Invoice Recovery can see.
