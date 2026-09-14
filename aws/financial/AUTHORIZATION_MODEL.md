# Financial authorization model

Application authentication is not financial execution authority.

Being all of the following is **not** enough to move money:

- authenticated Cognito user
- mapped ChecksOps UUID
- tenant member
- `user_roles.admin` or `staff`
- tenant `owner` / `admin` / `manager`

## What exists today in ChecksOps

`has_permission(_user_id, _permission)` is CRUD only:

`read`, `create`, `update`, `delete`, `export`, `reveal_pii`, `manage_users`, `view_audit_logs`.

It does **not** include deposit, disbursement, ACH, RTP, or wallet permissions.

Frontend money actions use `useFinancialGuard` → step-up 2FA:

| Action key | UI |
| --- | --- |
| `deposit.submit` | Check command center, deposit ops console |
| `deposit.approve` | CheckAlt settings |
| `disbursement.send` | Disbursement console |
| `payroll.run` | Payroll dialog |

Production Moov `moov-transfer-create` additionally requires platform admin **or** tenant role in `{owner, admin, manager}`.

## AWS financial gate

Implemented in `aws/functions/api/financial-authz.mjs`.

Evaluates, in order:

1. Cognito → `identity_accounts.application_user_id` (never Cognito `sub`)
2. Tenant membership for the **resource** tenant (from the check/payment row)
3. Documented financial role (`owner` / `admin` / `manager`)
4. Explicit financial permission key
5. `AWS_FINANCIAL_PERMISSIONS_ACTIVATED` — **must stay false**
6. `AWS_PROVIDER_EXECUTION_ENABLED` — **must stay false**

Results:

| Flag | Meaning |
| --- | --- |
| `canExecuteProduction` | always `false` in `evaluateFinancialAuthorization`. CheckAlt production uses a **separate** gate (`evaluateCheckAltProductionAuthorization` / `canExecuteProductionCheckAlt`) that still requires money holds to be lifted. |

## CheckAlt production (dark path)

Server-side only. React step-up is not authority.

1. Cognito → `identity_accounts.application_user_id`
2. Membership of the **check** tenant (browser `tenant_id` / `user_id` ignored)
3. Tenant role in `{owner, admin, manager}` — `operator` is denied
4. Cognito TOTP step-up recorded in `financial_stepup_log` (`deposit.submit`) **or** dual-control from a **distinct** owner/admin/manager (`POST /financial/checkalt-dual-control`)
5. Both TOTP and dual-control are bound to the authenticated application user, the **server-derived check tenant**, `check_intake_item_id`, current server-derived `amount_cents`, and `operation = deposit.submit`. Browser `tenant_id` / `amount` are ignored. Changing the check or amount invalidates the step-up. There is **no tenant-wide TOTP fallback**.
6. `productionCheckAltExecutionAllowed()` — all of `AWS_PROVIDER_EXECUTION_ENABLED`, `AWS_CHECKALT_ENABLED`, `AWS_FINANCIAL_PERMISSIONS_ACTIVATED`, and sandbox flag **false**

The unenrolled Freedom operator tester cannot be the sole authority. Dual-control recording is not money movement and stays available with flags off. Requester and approver must be distinct owner/admin/manager principals.
| `canSimulate` | true when sandbox simulation is on and the caller is an authenticated member of the **resource** tenant. A financial role is recorded (`roleOk`) but is not required for simulation, because simulation is not money movement. Staging testers are `staff` / tenant members, not automatically `owner`/`admin`/`manager`. |
| `activated` | always `false` |

## Tenant Management

`checksopsadmin@gmail.com` is Tenant Management. Mapped application email (not JWT, not UUID) may:

- Pull monthly and usage fees from other tenants (`platform.fee_collect`)
- Send Moov on a tenant's behalf after CheckAlt clears

Tenant users stay limited to `tenant_users` membership. Platform-owner access is never granted by `MASTER_OWNER_APPLICATION_USER_ID`.

## Who can do what (when later activated — not now)

| Operation | Permission | Who | Activated |
| --- | --- | --- | --- |
| Submit CheckAlt deposit | `deposit.submit` | tenant owner/admin/manager + step-up | no |
| Approve CheckAlt deposit | `deposit.approve` | same + step-up | no |
| Fund wallet | `wallet.fund` | tenant owner/admin/manager or Tenant Management | no |
| Initiate disbursement | `disbursement.send` | same + step-up, after CheckAlt clear, to an already-verified partner/sub/vendor/homeowner | no |
| Platform fee pull | `platform.fee_collect` | Tenant Management (`checksopsadmin@gmail.com`) only + step-up | no |
| Initiate ACH | `payments.ach` | disbursement + `send-funds.ach` | no |
| Initiate RTP | `payments.rtp` | ACH + RTP capability + explicit instant | no |
| Initiate wire | `payments.wire` | documented; not a current primary rail | no |
| Pay homeowner | `stakeholder.pay` | tenant owner/admin/manager or Tenant Management | no |
| Pay contractor/vendor | `contractor.pay` | tenant owner/admin/manager or Tenant Management | no |
| Retry failed transaction | same as original | same as original | no |
| Cancel (where supported) | same as original | wallet funding cancel only in production | no |

Permissions are **not activated**. Simulation testers exercise the gate without granting production money movement.

## Resource ownership

Before any simulated or future live call, the server verifies:

`user → application UUID → tenant membership → financial role → check → deposit/payment → payee → provider account → wallet/bank`

Browser-supplied values are ignored or rejected:

`tenant_id`, `user_id`, `amount`, `provider_account_id`, `wallet_id`, `bank_account_id`, `transfer_id`, payee ownership.

Cross-tenant IDs return `403`.
