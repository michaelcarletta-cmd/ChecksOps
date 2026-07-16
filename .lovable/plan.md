# Fix: mortgage-ops "Send tracking link" 403

## Root cause
Morgan clicked **Send tracking link to homeowner** in `MortgageOpsRequestDetail`. The button calls the `homeowner-ledger-send` edge function, which requires the caller to have a row in `tenant_users` for the claim's tenant:

```ts
const { data: membership } = await svc.from('tenant_users')
  .select('user_id').eq('user_id', userId).eq('tenant_id', tenantId).maybeSingle()
if (!membership) return json({ error: 'forbidden' }, 403)
```

Mortgage-ops agents are cross-tenant — Morgan has `user_roles.role = 'mortgage_agent'` and **no** `tenant_users` row for Freedom's tenant, so every send from the mortgage-ops portal returns 403 (the "non-2xx" the user saw). Same problem will hit any admin/mortgage_agent working a request for a tenant they're not a member of.

## Fix
Widen the membership check in `supabase/functions/homeowner-ledger-send/index.ts`: accept the caller if **either**
1. they belong to the tenant via `tenant_users` (existing path), **or**
2. they hold a cross-tenant ops role in `user_roles` — specifically `mortgage_agent` or `admin` — **and** the `claim_id` is tied to an active `mortgage_handling_requests` row (so mortgage agents can only send links for claims that were actually routed to the mortgage desk, not arbitrary tenants).

If neither passes, keep returning 403.

Everything else in the function stays the same: token creation, partner-code resolution, and the `homeowner-ledger-invite` email all continue to work once the auth gate opens.

## Verify
- Re-send the link from `/mortgage-ops/requests/:id` as Morgan → expect 200 + email queued.
- Send from the tenant's own UI as a normal tenant user → still works (unchanged path).
- Send as a signed-in user with neither membership nor `mortgage_agent`/`admin` role → still 403.

No schema changes, no frontend changes.
