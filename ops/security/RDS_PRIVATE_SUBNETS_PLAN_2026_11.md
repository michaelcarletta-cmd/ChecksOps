# Plan: move both databases to private subnets (Security Hub RDS.46)

Owner, 2026-11-03: "Proceed with Item 6, the database subnet move ... staging first" (runbook
`ops/security/AWS_ACCOUNT_HARDENING_2026_11.md`, item 6).

This plan changes nothing by itself. Each step below runs only on the owner's go phrase for that
step. The repository rules allow no direct AWS change outside the guarded workflows, and no guarded
workflow covers RDS networking, so each phrase is an explicit exception for that one step.

## Why

Security Hub RDS.46 fails for both `checksops-production` and `checksops-staging`: their DB subnet
groups include subnets whose route table sends `0.0.0.0/0` to the internet gateway.

There is **no open path today**:
- `PubliclyAccessible` is false on both instances.
- No database ENI has a public IP.
- The security groups admit 5432 only from the application's own groups.

The control guards the case where `PubliclyAccessible` is ever switched on. An instance in an
internet-routed subnet would then be reachable at once.

## Live state (read-only, 2026-11-03 ~00:50 UTC)

| | production `checksops-production` | staging `checksops-staging` |
|---|---|---|
| Class, storage | db.t4g.small, gp3 50 GB, encrypted | db.t4g.micro, gp2 20 GB, encrypted |
| Placement | Multi-AZ: primary `us-east-1f`, standby `us-east-1b` | Single-AZ `us-east-1f` |
| DB subnet group | `checksops-production-db-subnets` (used only by this instance) | `default-vpc-09f2268778966ce97` (used only by this instance) |
| Maintenance window | Thu 07:30–08:00 UTC | Wed 06:52–07:22 UTC |
| Backup window, retention | 04:40–05:10 UTC, 35 days, deletion protection on | 04:03–04:33 UTC, 35 days, deletion protection on |
| Read replicas, RDS Proxy | none | none |

Both subnet groups contain the same six subnets:

| Subnet | AZ | Route to 0.0.0.0/0 | Keep |
|---|---|---|---|
| `subnet-0df2518070c5b9ff0` | us-east-1a | NAT `nat-15f538197c4a75331` (private) | **yes** |
| `subnet-092e4e41821fba6c4` | us-east-1f | NAT (private) | **yes** |
| `subnet-03989e61c0468268a` | us-east-1b | IGW `igw-07fb541358a89fe21` | remove |
| `subnet-0b498a80f0688a913` | us-east-1c | IGW | remove |
| `subnet-0e8b078a61551da1c` | us-east-1d | IGW | remove |
| `subnet-017e2db43a4f5e5d8` | us-east-1e | IGW | remove |

Every Lambda in the VPC already runs only in the two private subnets (1a, 1f).

## Approach

**Edit each existing DB subnet group. Do not move an instance to a new subnet group.**

AWS documents that changing an instance's subnet group causes an outage while it is applied. Editing
the group's subnet list does not, as long as no subnet in use by an instance is removed. A subnet
group needs subnets in at least two AZs; 1a and 1f satisfy that.

- **Staging** runs in 1f, which stays. Its group can be edited directly, with no restart.
- **Production's standby** runs in 1b, which must go. So production:
  1. turns Multi-AZ off: the standby is deleted and the primary in 1f keeps running;
  2. edits the group;
  3. turns Multi-AZ back on: RDS builds a new standby in the only other AZ left, 1a, which is
     private.

AWS documents both Multi-AZ conversions as made without downtime. Creating the standby takes a
snapshot and syncs it, so expect higher I/O latency while it builds. Between steps P1 and P3,
production runs without a standby; backups and point-in-time restore continue throughout.

## Staging (first)

Go phrase: **"move the staging database to private subnets"**

```bash
# S0 pre-check (read-only): instance available, in 1f, Single-AZ, group used only by it
aws rds describe-db-instances --db-instance-identifier checksops-staging \
  --query 'DBInstances[0].[DBInstanceStatus,AvailabilityZone,MultiAZ,DBSubnetGroup.DBSubnetGroupName]'

# S1: keep only the two private subnets in the staging subnet group
aws rds modify-db-subnet-group --db-subnet-group-name default-vpc-09f2268778966ce97 \
  --subnet-ids subnet-0df2518070c5b9ff0 subnet-092e4e41821fba6c4

# S2 verify: group shows only 1a and 1f; instance still available in 1f
aws rds describe-db-subnet-groups --db-subnet-group-name default-vpc-09f2268778966ce97 \
  --query 'DBSubnetGroups[0].Subnets[].[SubnetIdentifier,SubnetAvailabilityZone.Name]'
```

Then prove the application path with the guarded read-only run: `guarded-staging-sql-executor.yml`,
mode `read-live`, with `approved_commit` = main.

Rollback: re-run `modify-db-subnet-group` with all six subnet IDs.

## Production (after staging verifies, in an announced window)

Pick a window that avoids the backup window (04:40–05:10 UTC) and the maintenance window (Thu
07:30–08:00 UTC), at low traffic. Allow about 60 minutes. Each step has its own go phrase:

| Step | Go phrase | Command | Wait for |
|---|---|---|---|
| P0 | (read-only, no phrase) | `describe-db-instances`: `available`, Multi-AZ, primary 1f, standby 1b; no pending modifications; latest restorable time within 5 minutes | |
| P1 | **"production database: Multi-AZ off"** | `aws rds modify-db-instance --db-instance-identifier checksops-production --no-multi-az --apply-immediately` | `available`, `MultiAZ` false, primary still 1f |
| P2 | **"production database: private subnets"** | `aws rds modify-db-subnet-group --db-subnet-group-name checksops-production-db-subnets --subnet-ids subnet-0df2518070c5b9ff0 subnet-092e4e41821fba6c4` | group lists only 1a and 1f |
| P3 | **"production database: Multi-AZ on"** | `aws rds modify-db-instance --db-instance-identifier checksops-production --multi-az --apply-immediately` | `available`, `MultiAZ` true, `SecondaryAvailabilityZone` us-east-1a |

After each step, check the application. https://checksops.com/prep/health must report `ok`, and the
production Lambda's CloudWatch errors must show no new database connection errors.

Stop on any surprise, for example the primary not in 1f at P0, or the instance leaving `available`
for longer than expected. After P1, re-enabling Multi-AZ (P3) restores redundancy even if P2 is
skipped.

**Rollback:**
- P2: re-run `modify-db-subnet-group` with all six subnets.
- P1: `--multi-az`. The new standby may then land in any AZ of the group.
- P3: needs no rollback; it restores the original redundancy.

## Applied: staging (2026-11-03)

Owner's go phrase: "move the staging database to private subnets". Claude cannot change RDS since the
least-privilege change, so the owner ran S1 and S2 in CloudShell.

- **S0, before 02:11 UTC, read-only:**
  - `checksops-staging` was `available` in us-east-1f, single-AZ, not publicly accessible, with no pending changes.
  - `default-vpc-09f2268778966ce97` was used only by this instance (no clusters) and held the six subnets listed above.
  - The only RDS ENI in a subnet to be removed (`eni-01cedb9d6ff35faf7`, 1b) carries `checksops-production-rds` and is production's standby. It belongs to production's own subnet group, which S1 does not touch.
- **S1, owner, 02:11:07 UTC:** CloudTrail records `ModifyDBSubnetGroup` by root.
- **S2:**
  - The group is `Complete`, holding only `subnet-0df2518070c5b9ff0` (1a) and `subnet-092e4e41821fba6c4` (1f), both `Active`.
  - The instance is still `available` in 1f.
  - Production is unchanged: six subnets, primary 1f, standby 1b.
- **Application path:** guarded read-live run 41564778049 (main `4068a8cd`, 02:15 UTC) reached the staging database through the executor. Its report was identical to the read-live from before the change, run 41540079590: live definition `03fcea3c…`, `already_applied` true, `missing_ledger_trigger_count` 0.
- **Security Hub, 06:45 UTC:** RDS.46 PASSED for `checksops-staging`.

Production: on 11-03 the owner gave the P1 phrase at about 02:23 UTC. P0 then held it: `LatestRestorableTime`
was over 5 minutes old (02:18:11, still unchanged at 02:25). At the owner's request the session
waited an hour. At 03:28 P0 passed again: latest restorable time 03:23:05, no RDS events, no
database errors in the production Lambda's logs for 65 minutes. P1 was not run; it waits for the
owner to repeat the phrase.

## After both

- Security Hub RDS.46 should pass for both instances at its next evaluation.
- Record the before/after state and timings in this file, as an "Applied" section in a follow-up
  docs PR.

## Separate, optional: pending OS update

AWS lists a pending `system-update` ("New Operating System update is available") for both
instances. It is applied automatically in the maintenance window unless applied earlier. On
production (Multi-AZ) AWS patches the standby, fails over (usually under a minute of reconnects),
then patches the old primary. It is independent of this move. If wanted, apply it after P3 with
`aws rds apply-pending-maintenance-action --opt-in-type immediate --apply-action system-update`,
in the same window, on its own go phrase.
