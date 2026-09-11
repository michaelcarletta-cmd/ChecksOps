# M6.3Q — Restore production identity link only

**STOP FOR REVIEW.** One-row `identity_accounts.cognito_sub` restore is done.
Do not consume another EMAIL_OTP from this agent. Michael may retry one fresh
production EMAIL_OTP login.

This phase did **not**:
- create or delete users
- change email
- change Freedom membership
- change TOTP enrollment
- change Cognito MFA / password / passkeys
- touch Moov / CheckAlt
- enable money flags
- apply SQL72
- overlay prep API or repo `auth-cognito.mjs`

`linked_at` was **not** updated. Schema `identity_accounts_sub_when_linked`
already holds with `status=active` and a non-null `cognito_sub`. Normal link
writers (`onboard.mjs` pending-only, tenant-admin `COALESCE(linked_at, now())`)
do not overwrite an existing `linked_at`.

---

## Return card

```
PRECHECK: PASS
  1. application user 7dbb3009-f059-4767-b5dc-1c5c72379330 exists
     profiles.approval_status=approved  email=mcarletta@freedomadj.com
  2. production sub a45884b8-d051-70b3-b19d-ca704964c6e8 was unmapped (0 rows)
  3. exactly one identity_accounts row for that app user had
     cognito_sub=c4386408-60e1-70e2-abb6-e6194e8e635f  status=active
  4. Freedom admin membership active (tenant 2eff5f1a… role=admin, slug=freedom,
     subscription_status=active, user_roles.admin)

ROWS UPDATED: 1
  UPDATE public.identity_accounts
     SET cognito_sub = 'a45884b8-d051-70b3-b19d-ca704964c6e8'
   WHERE application_user_id = '7dbb3009-f059-4767-b5dc-1c5c72379330'
     AND cognito_sub = 'c4386408-60e1-70e2-abb6-e6194e8e635f'
  RETURNING …   → rowCount=1
  Fields written: cognito_sub only (email/status/created_at/linked_at untouched)

PRODUCTION SUB RESTORED: YES
  a45884b8-d051-70b3-b19d-ca704964c6e8 → 7dbb3009-f059-4767-b5dc-1c5c72379330
  LOOKUP_MAPPING_SQL now matches 1 active row

STAGING SUB REMOVED: YES
  c4386408-60e1-70e2-abb6-e6194e8e635f no longer maps to any identity_accounts row

DUPLICATE MAPPING: NO
  prod_sub_mapping_count=1

APPLICATION USER: UNCHANGED
  profiles.id 7dbb3009… email mcarletta@freedomadj.com approval_status=approved
  identity_accounts.email/status/created_at/linked_at unchanged
  linked_at remains 2026-09-11T16:33:20.421Z
  created_at remains 2026-09-02T10:49:52.986Z

FREEDOM MEMBERSHIP: UNCHANGED
  tenant 2eff5f1a-929d-4ce3-9a8b-cd96b98df42a slug freedom
  tenant_users.role=admin  user_roles.admin  subscription_status=active

TOTP CHANGED: NO
  verified_at 2026-09-11T14:43:13.231Z  enrolled_at 2026-09-11T14:42:38.412Z
  key_id financial-totp-v1  last_used_timestep null

COGNITO CHANGED: NO
  pool us-east-1_h00WorYMT  username/sub a45884b8…
  UserLastModifiedDate 2026-09-10T18:56:10.659Z (before = after)
  UserMFASettingList null  PreferredMfaSetting null
  AWS_COGNITO_MFA_PREFERRED=false

MONEY FLAGS: UNCHANGED (all false)
  AWS_MOOV_ENABLED=false
  AWS_PROVIDER_EXECUTION_ENABLED=false
  AWS_FINANCIAL_PERMISSIONS_ACTIVATED=false
  AWS_PROVIDER_SANDBOX_EXECUTION_ENABLED=false
  AWS_CHECKALT_ENABLED=false
  AWS_PROVIDER_LIVE_READS_ENABLED=true
  AWS_PROVIDER_WEBHOOK_DRY_RUN=true
  CHECKSOPS_ENV=production-prep

MONEY MOVED: NO

SAFE TO RETRY EMAIL_OTP LOGIN: YES
  Production EMAIL_OTP JWTs carry sub a45884b8… which now maps to Michael’s
  application user. Do not consume an OTP from this agent.

GO/NO-GO: GO for one human production EMAIL_OTP retry as mcarletta@freedomadj.com
  NO-GO for M6.3O TOTP authorization-only test until that login succeeds
  GET /prep/identity/me should return 200 (not 401 identity_not_linked)

STOP FOR REVIEW.
```

---

## Mutation

Confirm-gated rehearsal overlay `checksops-staging-rehearsal-oneshot` (handler
`index.handler`), database `checksops` as `checksops_admin`.

1. Preflight invoke `{ confirm: "M63Q_RESTORE_IDENTITY_LINK", write: false }` → PASS
2. Write invoke `{ confirm: "M63Q_RESTORE_IDENTITY_LINK", write: true }`
   - `BEGIN`
   - `SELECT … FOR UPDATE` on Michael’s row; require current sub = staging sub
   - `SELECT … FOR UPDATE` on production sub; require 0 rows
   - `UPDATE … SET cognito_sub = $3 WHERE application_user_id = $1 AND cognito_sub = $2`
   - require `rowCount === 1` else `ROLLBACK`
   - `COMMIT` then re-read
3. Restore original rehearsal zip immediately
   CodeSha256 `Uuqs/fRkCulPrdKUj72FJTlHdTkfhVXc+mttZljUzwk=` handler `index.handler`

Prep API CodeSha256 unchanged:
`l9nHBQHn+cwwroKO9+czOXi2WMjoeChOpgVFtR0Tj7A=` (LastModified 2026-09-11T14:09:54Z).

---

## After mapping

| Field | Value |
| --- | --- |
| `application_user_id` | `7dbb3009-f059-4767-b5dc-1c5c72379330` |
| `cognito_sub` | `a45884b8-d051-70b3-b19d-ca704964c6e8` (production pool `us-east-1_h00WorYMT`) |
| `email` | `mcarletta@freedomadj.com` |
| `status` | `active` |
| `linked_at` | `2026-09-11T16:33:20.421Z` (unchanged) |
| `created_at` | `2026-09-02T10:49:52.986Z` (unchanged) |

Next human step: one fresh EMAIL_OTP login. If `GET /prep/identity/me` is 200,
login mapping is restored. Then stop again before any TOTP authorization test.
