# Staging Cognito onboarding results

Temporary Lambda `checksops-staging-cognito-onboard-c48b` was deleted with its admin-secret IAM role. API Policy4 still has only the `checksops` secret. RLS remains **165** select / **127** write policies, **165** tables enabled, no FORCE.

No invitation or password-reset emails were sent (`AdminCreateUser` `MessageAction=SUPPRESS`; later `AdminSetUserPassword` without `--permanent` and without `AdminResetUserPassword`). No Moov/CheckAlt/Plaid/Resend calls. API `default_transaction_read_only` remains `on`. Ninth UUID was not modified.

## Isolated test mapping

Cleared. Tester `abd3c2a0-6dc0-4680-92dd-a013e1141c91` is still that UUID with email `checksops-tester@freedomadj.com`. Probe sub `2418c458-c011-70b7-07ac-6b9da2d9415d` no longer appears in `identity_accounts`. Probe Cognito user is **disabled**. Unauthenticated `/identity/me` is 401.

## Eight mappings

Original application UUIDs are unchanged. No `cognito_sub` equals `application_user_id`.

| Email | Application UUID | Cognito sub | App role | Tenant | Cognito status |
| --- | --- | --- | --- | --- | --- |
| asukanick@condition1commercial.com | `3af0234c-de1b-4819-938d-fa4f9390811b` | `84185468-a041-70e7-6f61-c6c63f4aff19` | admin | C1C admin | FORCE_CHANGE_PASSWORD, enabled |
| barzziniconstructiongroup@gmail.com | `e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd` | `34a8e428-6071-70b2-92de-fc7e3fd74f14` | admin | Barzzini admin | FORCE_CHANGE_PASSWORD, enabled |
| checksops-tester@freedomadj.com | `abd3c2a0-6dc0-4680-92dd-a013e1141c91` | `c4386408-60e1-70e2-abb6-e6194e8e635f` | staff | Freedom operator | FORCE_CHANGE_PASSWORD, enabled |
| claims@freedomadj.com | `b100f05d-9e81-4a7b-b9cc-9baf173131d9` | `2498c4b8-f0a1-701b-da4b-a1f5c79f675a` | mortgage_agent | none | FORCE_CHANGE_PASSWORD, enabled |
| lhogan@condition1commercial.com | `0160a5f3-30a4-4aba-8e54-6529f1ceb0d4` | `5458c4f8-1081-701d-10cf-02a993311263` | admin | C1C admin | FORCE_CHANGE_PASSWORD, enabled |
| mcarletta@freedomadj.com | `7dbb3009-f059-4767-b5dc-1c5c72379330` | `54a8b4c8-60d1-7028-cfbb-0eb2baee5592` | admin | Freedom admin (master owner) | FORCE_CHANGE_PASSWORD, enabled |
| payments@condition1commercial.com | `fd857564-9534-4b0f-95ac-624ed1273725` | `e418f488-4011-7046-5a09-3f8b51140899` | admin | C1C admin | FORCE_CHANGE_PASSWORD, enabled |
| support@homeheropros.com | `30d0505c-bcfa-4732-81fd-869dc46da5dd` | `14187428-90d1-70f2-95f3-10844b186461` | admin | Home Hero admin | FORCE_CHANGE_PASSWORD, enabled |

`identity_accounts`: 8 `active` (unique subs), 1 `pending` (ninth).

## `/identity/me`

Each of the eight ID tokens returned HTTP 200, `authUid` = existing application UUID, not the Cognito sub, with the restored `tenant_users` and `user_roles`. Spoofed master/C1C query and header IDs were ignored.

## RLS isolation

| User | Claims (n / Freedom / NULL) | Freedom checks | C1C tenant | Freedom tenant |
| --- | --- | ---: | ---: | ---: |
| Freedom staff Tester | 83 / 83 / **0** | 182 | 0 | 1 |
| Master `mcarletta@freedomadj.com` | 180 / 83 / **97** | 182 | 1 | 1 |
| C1C admins (3) | 0 / 0 / **0** | 0 | 1 | 0 |
| Barzzini admin | 0 / 0 / **0** | 0 | 0 | 0 |
| Home Hero admin | 0 / 0 / **0** | 0 | 0 | 0 |
| Mortgage agent (no tenant) | 0 / 0 / **0** | 0 | 0 | 0 |
| Ninth UUID | 0 / — / — | 0 | 0 tenants | |
| Unauthenticated | 0 | 0 | | |

All restored `check_intake_items` are Freedom-tenant; C1C has no restored checks. Ordinary users cannot see the 97 NULL-org claims.

## Ninth UUID

`dd24eea5-5d12-47d1-999e-d5930c278b7d`: still `identity_accounts` pending, no email, no Cognito, no profile, no `tenant_users`, `admin`+`staff` roles unchanged, RLS fail-closed.

## Emails sent

**None.**

## Ready for next phase?

**Yes — controlled login/password activation** (invite or set passwords for these eight only). Do not invite the ninth UUID. Do not enable production writes, Storage, DNS, frontend, or provider endpoints yet.
