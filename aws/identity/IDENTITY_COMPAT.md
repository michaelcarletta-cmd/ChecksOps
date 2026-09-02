# Staging Cognito / Auth compatibility (this phase)

Cognito authenticates. ChecksOps authorization keeps the existing application UUID.

```
Cognito sub -> public.identity_accounts -> application_user_id -> profiles.id
                                         -> tenant_users.user_id
                                         -> user_roles.user_id
                                         -> auth.uid() via request.app_user_id
```

Do not replace `profiles.id`, `tenant_users.user_id`, `user_roles.user_id`, or audit UUIDs with Cognito `sub`. Do not put application roles in Cognito groups.

## This phase (staging only)

- Create `identity_accounts`
- Replace `auth.uid()` stub with a session GUC that returns the ChecksOps UUID
- Inventory the 9 existing identities and seed pending mapping rows (no `cognito_sub` yet)
- Isolated test Cognito user mapped to one existing UUID for `GET /identity/me` only
- Classify the 40 `auth.uid()` functions
- Document FK retarget to `identity_accounts.application_user_id` (not applied)

## Not in this phase

- Invite/import of the 9 existing users
- Production RLS
- Production Lovable/Supabase, `main`, Storage, Moov, CheckAlt, webhooks, DNS, frontend
- Attaching the 47 skipped `auth.users` FKs

## Live results

Filled after staging inventory, DDL, and isolated `GET /identity/me` validation.
