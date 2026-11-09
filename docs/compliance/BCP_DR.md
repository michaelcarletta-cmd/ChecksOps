# Business continuity and disaster recovery

**Owner:** Michael Carletta, CEO (Qualified Individual) — security@checksops.com
**Effective:** 2026-11-06 • Matrix rows CC9.1, A1.2, A1.3 in `docs/compliance/SOC2_CONTROL_MATRIX.md`

## 1. Recovery targets

| Target | Value | Basis |
|---|---|---|
| Recovery point objective (RPO), database | 5 minutes | RDS point-in-time restore; `LatestRestorableTime` was 3 minutes old when read on 2026-11-06 18:16 UTC |
| Recovery point objective, files | 0 for overwrites and deletes | S3 versioning on the private-files bucket |
| Recovery time objective (RTO), single data center (AZ) failure | 5 minutes | Multi-AZ RDS fails over automatically; Lambda and API Gateway are multi-AZ by design |
| RTO, database corruption or bad change | 4 hours | Point-in-time restore to a new instance, then repoint the API after review. **To be measured** by the first restore test (row B-1). |
| RPO / RTO, loss of region `us-east-1` | Database: restorable in `us-east-2`; replication status `replicating` (read 2026-11-06 19:58 UTC: restore window 19:02–19:43 UTC, so about 15 minutes behind the source; 35-day retention). The restore time is to be measured (`ops/security/RESTORE_TEST_RUNBOOK.md`). Files: copied to `us-east-2` since 2026-11-09 (`checksops-production-privatefiles-dr-806168576068`; new uploads within minutes, deletes not copied), except the KMS-encrypted compliance documents (phase 2) (`ops/security/FILES_BUCKET_REPLICATION_2026_11.md` "Applied") | §4 |

**OWNER TO CONFIRM** these targets against what tenant contracts promise.

## 2. What protects production today (read 2026-11-06)

- **Database:** `checksops-production`, Multi-AZ (primary `us-east-1f`, standby `us-east-1a`),
  35-day automated backups with point-in-time restore, encrypted, deletion protection on.
- **Files:** `checksops-production-privatefiles-806168576068`, versioning on, SSE-KMS.
- **Application:** code and infrastructure definitions in GitHub; any version can be rebuilt and
  redeployed through the guarded workflows.
- **Secrets:** Secrets Manager, in-region.
- **Edge:** CloudFront and WAF are global services.

## 3. Scenarios and response

| Scenario | Response | Procedure |
|---|---|---|
| One AZ fails | Automatic RDS failover; no action | Watch the alarms; confirm `/health` |
| Bad deploy | Re-run the guarded workflow for the previous accepted build | `ops/production-lambda-rebuild.md`, `ops/production-spa-deploy.md` |
| Bad SQL change or data corruption | Point-in-time restore to a **new** instance, compare, then repoint after the owner's review. Never restore over the live instance. | `aws/cutover/INCIDENT_RESPONSE_AWS.md` §4, §9 |
| Files deleted or overwritten | Restore the previous object version | S3 versioning |
| Credential compromise | Rotate and contain | `aws/cutover/INCIDENT_RESPONSE_AWS.md` §3 |
| Provider outage (Moov, CheckAlt) | Payments or deposits pause; tenants told through `/status.json` | `ops/status-notice.md` |
| Loss of `us-east-1` | Not recoverable today; see §4 | — |

`aws/cutover/INCIDENT_RESPONSE_AWS.md` §9 still describes the staging instance as single-AZ; the
production values are those in §2 above.

## 4. Known gaps (decisions for the owner)

1. **Database copied to `us-east-2`** since 2026-11-06: RDS cross-region automated backup replication,
   35 days, KMS key `alias/checksops-production-rds-dr`
   (`ops/security/LOG_RETENTION_AND_DR_2026_11.md`). **Still single-region:** the private-files
   bucket (check images, documents) and Secrets Manager. S3 Cross-Region Replication of the bucket
   is the remaining option, a separate decision.
2. **No restore test recorded.** The first test sets the measured RTO (row B-1).
3. **Backup person: Austin Sukanick** (owner's decision, 2026-11-06). Acts for the owner on an
   incident, an outage or a restore when the owner cannot be reached. Before the role is real, Austin
   needs, and the evidence calendar records:
   - a named AWS IAM login with MFA, with the permissions to run the steps in §3 (no root access);
   - access to GitHub with permission to run the guarded workflows;
   - the security alert emails (SNS `checksops-production-security-alerts`);
   - a read of this document, `aws/cutover/INCIDENT_RESPONSE_AWS.md` and
     `docs/compliance/CHANGE_MANAGEMENT.md` §4, and the personnel steps in
     `docs/compliance/PERSONNEL_SECURITY.md` §1.

## 5. Testing

- Restore test once a year (row B-1): point-in-time restore of `checksops-production` to a new
  instance, record the time to `available`, compare row counts for key tables, delete the copy.
  The same test reads back the `us-east-2` files copy (one ordinary file, one compliance document
  under a temporary key policy statement) and compares object counts
  (`ops/security/RESTORE_TEST_RUNBOOK.md` "Files recovery").
- Tabletop exercise once a year (row I-1), including one continuity scenario.
