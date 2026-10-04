# Final cleanup safety review — DO NOT EXECUTE

Date: 2026-10-04T21:40Z
Question: can the synthetic staging A47/A48 family be excluded while preserving audit history **without** permanently weakening `paid → anything`?

## Answer

Yes. Recommended mechanism is option 2.

SQL 50 should be **unnecessary as a permanent capability** and **staging-only as a oneshot transaction**. Do not leave a general `paid → excluded|voided` trigger carve-out in the catalog.

## Why option 1 is rejected

A permanent `paid → excluded|voided` rule lets any future admin unpay any paid compensation row. That is a new product capability, not required for this demo cleanup. SQL 47/48/49 already moved to production; a general SQL 50 would be the next accidental production apply.

## Why option 3 is insufficient

No existing supported writer sets `excluded`/`voided`. The exclusions table alone does not drop paid rows from monthly totals. Changing monthly to join exclusions would change the compensation formula and break `Paid = sum(status='paid')`.

## Why option 2 is sufficient

- Staging oneshot only; production host/secret/function names refused.
- Hard-bound to the identified synthetic tenant/request/check/agent IDs, plus inspect-locked entry IDs and fingerprint CAS.
- Temporary allowlisted trigger is installed and restored in the same transaction. ROLLBACK restores SQL 47 automatically.
- After COMMIT, `paid → anything` is forbidden again, including for these demo rows.
- Rows, amounts, payment references, and `paid_at` remain. Audit records `exclude` as bookkeeping-only.
- Roots and children become `excluded`, so current monthly totals drop them.
- Exclusions rows prevent later earn/adjust/recon flags.
- Freedom / GATE4 / production fixtures / other tenants are refused.
- No Moov/ACH. No tenant billing writes.

## Payment-reference confirmation

Excluding a paid synthetic row does **not** reverse, refund, or rewrite `MACOMP-STAGING-15` or `MACOMP48`. Those marks stay as historical evidence of the demo `mark_paid`. This is bookkeeping exclusion of staging test data only.

## Adjustments UI

Retain `Gross Owed = Initial + Additional + Adjustments`. Do not deploy that UI change in this review.
