# Staging Cognito / Auth compatibility

Cognito authenticates. ChecksOps authorization keeps the existing application UUID.

```
Cognito ID token sub
  -> public.identity_accounts.cognito_sub
  -> application_user_id
  -> profiles.id / tenant_users.user_id / user_roles.user_id
  -> SET LOCAL request.app_user_id
  -> auth.uid()
```

No `profiles.id`, `tenant_users.user_id`, `user_roles.user_id`, or audit UUID was rewritten to a Cognito `sub`. Application roles stay in `user_roles`. Cognito groups are not used.

## Database changes (staging `checksops` only)

Applied as `checksops_admin` via a temporary in-VPC Lambda, then that Lambda and IAM role were deleted. The API role never received the admin secret.

| Change | Detail |
| --- | --- |
| `public.identity_accounts` | PK `application_user_id` (existing ChecksOps UUID). Unique `cognito_sub` (NULL while `pending`). Unique `lower(email)` where not null. Status `pending` / `active` / `isolated_test`. No FK to `profiles(id)` because one of 9 users has no profile. |
| `auth.uid()` | Returns `current_setting('request.app_user_id')::uuid`, not NULL and not Cognito `sub`. |
| `auth.role()` / `auth.email()` / `auth.jwt()` | Session GUC compatible. `auth.jwt()->>'sub'` is the **application** UUID. |
| Grants | `USAGE` on schema `auth`; `EXECUTE` on those four `auth.*` functions; `SELECT` on `identity_accounts`. No INSERT/UPDATE/DELETE for role `checksops`. No `SELECT` on `auth.users`. |
| Seed | 9 pending rows from `profiles ∪ tenant_users ∪ user_roles`. No duplicate UUIDs. |

Not applied: the 47 skipped `auth.users` FKs (`aws/identity/sql/06_retarget_auth_users_fks.sql`). Planned target is `identity_accounts(application_user_id)`, same UUID values, original ON DELETE.

## API changes (staging `checksops-staging-api`)

- Env: `DATABASE_NAME=checksops` unchanged; added `COGNITO_USER_POOL_ID=us-east-1_vPmQ7cL1F`, `COGNITO_CLIENT_ID=71bb7a192cbl6o6s8m259tl589`.
- `GET /identity/me` (and `/identity/session`): verify Cognito ID token, look up `identity_accounts` by `sub`, `SET LOCAL request.app_user_id` to the existing UUID, `SELECT auth.uid()`, then `tenant_users` / `user_roles` **by that UUID**.
- HTTP API JWT authorizer on `GET /identity/me` only. Unauthenticated call returns API Gateway 401.
- Staging Cognito client gained `ALLOW_ADMIN_USER_PASSWORD_AUTH` for the isolated probe only. SRP remains.

## Identity inventory (exact; no guessed UUIDs)

9 distinct application UUIDs. 8 have `profiles` + email. 1 has `user_roles` only and **no email**.

| application_user_id | email | profile | `user_roles` | tenant |
| --- | --- | --- | --- | --- |
| `3af0234c-de1b-4819-938d-fa4f9390811b` | asukanick@condition1commercial.com | yes (Austin Sukanick) | admin | C1C admin |
| `e2ad0849-c6b6-4f4a-a68a-8c52f563c6fd` | barzziniconstructiongroup@gmail.com | yes (Stosh Rogers) | admin | Barzzini admin |
| `abd3c2a0-6dc0-4680-92dd-a013e1141c91` | checksops-tester@freedomadj.com | yes (ChecksOps Tester) | staff | Freedom operator |
| `b100f05d-9e81-4a7b-b9cc-9baf173131d9` | claims@freedomadj.com | yes (Morgan Carletta) | mortgage_agent | none |
| `0160a5f3-30a4-4aba-8e54-6529f1ceb0d4` | lhogan@condition1commercial.com | yes (Lani Hogan) | admin | C1C admin |
| `7dbb3009-f059-4767-b5dc-1c5c72379330` | mcarletta@freedomadj.com | yes (M. Carletta) | admin | Freedom admin |
| `fd857564-9534-4b0f-95ac-624ed1273725` | payments@condition1commercial.com | yes (Michael Carletta) | admin | C1C admin |
| `30d0505c-bcfa-4732-81fd-869dc46da5dd` | support@homeheropros.com | yes (AJ Kolesa) | admin | Home Hero admin |
| `dd24eea5-5d12-47d1-999e-d5930c278b7d` | **unknown** | **no** | admin, staff | none |

Later Cognito invites must use these emails as the match key and write the new `sub` onto the **same** `application_user_id`. Do not mint a new UUID for the 9th user; optionally add a `profiles` row with id `dd24eea5-5d12-47d1-999e-d5930c278b7d` after an operator supplies the email.

`identity_accounts` now has those 9 rows. Eight remain `pending` with `cognito_sub` NULL. None of the 8 real emails were invited.

## Isolated test (not an invite of the 9)

| Field | Value |
| --- | --- |
| Cognito user | `staging-identity-probe-c48b@checksops.invalid` (messages suppressed) |
| Cognito `sub` | `2418c458-c011-70b7-07ac-6b9da2d9415d` |
| Mapped application UUID | `abd3c2a0-6dc0-4680-92dd-a013e1141c91` (existing ChecksOps Tester) |
| `identity_accounts.status` | `isolated_test` |

`GET /identity/me` with that ID token returned:

- `authUid` = `abd3c2a0-6dc0-4680-92dd-a013e1141c91` (not the Cognito sub)
- tenant Freedom Adjustment / `operator` from `tenant_users`
- app role `staff` from `user_roles`
- `cognitoGroupsUsed: false`

Unauthenticated `GET /identity/me` → 401. `/db-health` still `currentDatabase=checksops`, `currentUser=checksops`.

**Clear this `isolated_test` row (`cognito_sub` NULL, `status=pending`) before inviting `checksops-tester@freedomadj.com`.** Until then the probe user can read as that application UUID.

## `auth.uid()` function classification (40 signatures / 39 names)

All 40 are `SECURITY DEFINER` and call `auth.uid()`. None of these 40 call `net` / `cron` / `vault` / `pgmq`. Bodies do **not** need to be rewritten to take Cognito `sub` if every request sets `request.app_user_id` to the application UUID (done for `/identity/me`).

Before RLS can be enabled, still required:

1. Set the GUC on **every** request path that hits RLS (not only `/identity/me`).
2. `GRANT EXECUTE` on helpers used by policies (`has_role` is not in this 40 because it takes `_user_id`; policies call `has_role(auth.uid(), …)`). Also grant `is_master_owner`, `is_platform_owner`, `current_tenant_is_check_funds_recipient`, and other policy helpers.
3. Restore/apply RLS policies only after (1) and (2). Do not enable them now.
4. Do not `GRANT EXECUTE` on write RPCs until write cutover.

| Class | Functions | Before RLS |
| --- | --- | --- |
| RLS / session helpers (read) | `is_master_owner`, `is_platform_owner`, `current_tenant_is_check_funds_recipient`, `get_my_tenant_partner_codes`, `get_tenant_funds_received`, `get_check_stage_totals` | GUC + EXECUTE |
| Read RPCs that call `has_role(auth.uid())` | `get_check_claim_settlement`, `get_check_dashboard_counts`, `get_check_dashboard_counts_for_tenant`, `get_deposit_*`, `get_loss_draft_dashboard_counts*`, `get_portfolio_carrier_analytics`, `get_tenant_check_usage`, `get_tenant_users_with_profiles` | GUC + EXECUTE; still SELECT-only from API |
| Write RPCs | `accept_mortgage_handling_request`, `add_partner_stakeholder_to_check`, `admin_set_contractor_pro`, `backfill_check_billing_events`, `create_claim_for_staff` (2 overloads), `decide_stakeholder_limit_request`, `ensure_partner_stakeholders`, `loss_draft_set_lender`, `record_check_return`, `resolve_check_return`, `update_mortgage_handling_request_status`, `log_audit`, `list_partner_payout_options`, `get_all_checks_safety_net`, `get_check_unread_counts`, `get_stuck_checks` | GUC + EXECUTE later; no write grant now |
| Supabase session table | `register_session`, `invalidate_session`, `invalidate_all_sessions` | Likely **body/design change**: they talk to `user_sessions`, not Cognito. Do not enable as-is for AWS login. |
| Trigger | `tg_set_deposited_metadata` | GUC must be set on the writing session; trigger owner executes it |
| Trigger-called write | `enforce_check_status_transition` | Same as trigger path |

## Unresolved before inviting the 9 users

- Email for `dd24eea5-5d12-47d1-999e-d5930c278b7d` (admin+staff, no profile). Do not guess.
- Remove `isolated_test` mapping for ChecksOps Tester.
- Delete or disable the probe Cognito user if it should not remain.
- Invite the 9 by email; store each new `sub`; set `status=active`.
- Retarget 47 FKs to `identity_accounts(application_user_id)` without rewriting UUID values.
- Optionally add a `profiles` row for the 9th UUID (same id).
- Wire GUC on all future authenticated routes; GRANT EXECUTE on RLS helpers; then consider RLS.
- Replace `user_sessions` RPCs with Cognito token revocation, or stop calling them.
- Do not enable production RLS, Storage, Moov, CheckAlt, webhooks, DNS, or frontend cutover.

## STOP

This phase is complete at the staging identity compatibility layer. Do not invite/migrate the 9 existing users until the unresolved items above are reviewed.
