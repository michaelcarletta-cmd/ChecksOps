# Staging global RLS activation results

Live oneshot `checksops-staging-rls-enable-c48b` returned `ok: true` after a first-run assertion false alarm that **disabled** the 165 tables, then a re-run that left RLS **enabled**. The Lambda and its admin-secret IAM role were deleted. API `Policy4` still has only the `checksops` secret.

Production users were not invited. Ninth UUID was not given Cognito, email, or tenant membership. Moov/CheckAlt/Plaid/Resend were not called. API `default_transaction_read_only` remains `on`. No FORCE. No permissive fallback policies.

Identity unchanged:

`Cognito sub -> identity_accounts.application_user_id -> existing ChecksOps UUID -> request.app_user_id -> auth.uid()`

## Pre-enable snapshot

Matched and did not abort.

| Check | Live |
| --- | ---: |
| Restored application tables | **166** |
| Restored tables with RLS before enable | **0** |
| `aws_select_*` | **165** |
| `aws_write_*` | **127** |
| Dump leftover policies | **0** |
| Identity FKs | **47** |
| Server-side write policies | **0** |
| Obsolete write policies | **0** |
| Platform-owner write policies | **7** |
| Claims / Freedom / NULL-org | **180 / 83 / 97** |
| Financial aggregates vs approved restore | **match** |
| `checksops` owner / superuser / `BYPASSRLS` | **false / false / false** |
| Real users with Cognito | **0** |
| Ninth UUID Cognito/email | **none** |

## Enablement

`ALTER TABLE … ENABLE ROW LEVEL SECURITY` on the 165 inventory tables. `spatial_ref_sys` and `identity_accounts` were not enabled. `relforcerowsecurity` is false on all 165.

First invoke failed the assertion helper (`expectOk` required a SELECT `ok` flag) even though Freedom staff saw 83 claims / 182 Freedom checks and C1C saw its own tenant and 0 Freedom rows. Rollback disabled all 165 tables, then the assertion was fixed and enablement was repeated.

## Authorization matrix (live, RLS already committed)

| Actor | Claims | NULL-org | Freedom checks | Other |
| --- | ---: | ---: | ---: | --- |
| Freedom staff | **83** | **0** | **182** (all restored checks are Freedom) | C1C tenant hidden |
| C1C tenant admin | **0** | **0** | **0** | own tenant 1; Freedom tenant/files/endorsements/disbursements/deposits **0** |
| Master owner | **180** | **97** | — | 7 folders on a NULL-org claim |
| Ninth UUID | **0** | **0** | **0** | tenants 0, deposits 0 |
| Unauthenticated | **0** | **0** | **0** | |
| Cognito sub as app UUID | **0** | **0** | — | |

C1C UUID-guess of a known Freedom check id: **0** rows.

Documented funds-recipient overlap on Freedom deposits for C1C: **0**.

## Write validation (rolled back)

Temporary DML GRANT + `SET LOCAL default_transaction_read_only=off` inside one transaction, then `ROLLBACK`. No persisted financial writes. API brake left `on`.

| Case | Result |
| --- | --- |
| Freedom staff UPDATE assigned claim / Freedom check | allow (n=1), rolled back |
| C1C UPDATE Freedom claim / check / deposit | 0 rows |
| Staff UPDATE NULL-org claim | 0 rows |
| Staff INSERT webhook / CheckAlt deposit / idempotency | RLS deny |
| Staff/master UPDATE `checkalt_config` | 0 rows |
| Staff UPDATE branding | 0 rows |
| Master UPDATE branding | allow (n=1), rolled back |
| Ninth / C1C Freedom write-probe INSERT | RLS deny |
| Staff Freedom write-probe INSERT | allow (n=1), rolled back |

`checksops` has no lasting INSERT/UPDATE/DELETE on restored tables. Cannot ALTER RLS or CREATE POLICY.

## API regression

| Endpoint | Result |
| --- | --- |
| `GET /db-health` | 200; `currentUser=checksops`; `currentDatabase=checksops`; `transactionReadOnly=on`; `defaultTransactionReadOnly=on` |
| `GET /db-readonly-validate` | 200; `rlsMode=on`; fail-closed **0** rows on all 16 core tables; no write privileges; no FORCE |
| `GET /identity/me` without token | **401** |
| `GET /authorization/isolation` without token | **401** (spoof headers ignored) |
| Probe JWT `/identity/me` | mapped Tester UUID, not Cognito sub; Freedom membership |
| Probe JWT `/authorization/isolation` + spoofed master/C1C ids | still Tester; claims 83/0 NULL; Freedom checks 182; C1C checks 0; C1C probe hidden |
| `GET /authorization/jwks-check` | 200 |
| API IAM Policy4 | **checksops** secret only |

## Financial reconciliation (owner/admin, bypasses RLS)

Unchanged vs approved restore (`1317000.53` intake, `963972.98` deposit items, `380333.17` CheckAlt deposits, `2977337.23` ledger, and the rest of the 15 metrics). Core table counts unchanged. Claims 180/83/97 unchanged.

## Ready for next phase?

**Yes, for controlled Cognito onboarding of the 8 known users only** — after clearing the isolated probe mapping. This phase does **not** invite them.

Still out of scope: ninth UUID decision, Storage, frontend cutover, DNS, production writes, provider endpoint changes.

Rollback SQL remains `aws/rls/sql/27_disable_rls.sql` if a later phase finds unexpected cross-tenant access.
