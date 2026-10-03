# Production Mortgage Ops SQL transition — applied and verified

Authorized SQL-only production write. Lambda, SPA, CloudFront, Cognito,
and provider/environment flags were not changed.

## Mechanism

Dedicated oneshot `checksops-prod-mops-sql-transition-ad99` (not the
staging SQL executor). Embeds Step A and pinned SQL 39. Refuses caller
SQL. Fresh lease `mops-prod-sql-transition-20261003-ad99-1`. TOCTOU
expected-before hash `9b428140630157a29f7f96f1f368d8eeb264aceaa764c0a214b5a3aa58538ee0`.
One transaction: Step A, verify, pinned SQL 39, verify, COMMIT.

SQL 39 file was not modified. SHA256 remains
`c59845e439cfdfd48be955d8ab78128de4ba39211b136616fc23799215145e3f`.

Inspect-only function `checksops-prod-mops-sql39-inspect-ad99` was not
modified (`JxL7z/ybetJExC0fUiOfJA5Xq+VjkfV3ov6ACrQQWmk=`).

## Pre-write TOCTOU

Independent inspect, #601 inspect, and Claim Ledger inspect all matched
the accepted investigation. Historical
`aws_update_mortgage_handling_requests` USING/WITH CHECK were byte-identical.
SQL 39 policies were absent. Production Lambda and SPA index were unchanged.

## Before → after

| Check | Before | After |
| --- | --- | --- |
| Catalog hash | `9b428140…` | `0d959621…` (not staging `4adc182c…`) |
| checksops MHR table UPDATE | present | gone |
| checksops MHR table DML | DELETE/INSERT/SELECT/UPDATE | DELETE/INSERT/SELECT |
| checksops MHR column UPDATE | all 54 via table UPDATE | exactly the authorized 17 |
| authenticated MHR table DML | none | none |
| authenticated MHR column UPDATE | none | assigned_employee_id, accepted_at, completed_at |
| checksops_admin MHR grants | owner set | unchanged |
| historical UPDATE policy | present | dropped |
| SQL 39 helper/policies | absent | `aws_is_mortgage_ops_agent`, queue SELECT, accept/complete UPDATE, usage INSERT |
| FORCE RLS | false | false |
| #601 | `010a4501…` / `74a234df…` | exact |
| Claim Ledger SQL43/44 | exact | exact |
| CBE checksops DELETE | present | unchanged |
| payment_transfers grants | present | unchanged |

## Contract tests

`mortgage-ops-isolation`, `mortgage-ops-sql39-executor`, and
`mortgage-ops-library-parity`: 38/38 pass.

## STOP

SQL verification is complete. No Lambda overlay, SPA overlay, CloudFront
invalidation, Cognito change, or provider/environment change was made.
