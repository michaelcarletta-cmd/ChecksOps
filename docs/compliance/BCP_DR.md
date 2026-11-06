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
| RTO, loss of region `us-east-1` | **Not met today** | See §4 |

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

1. **No copy outside `us-east-1`.** No cross-region RDS backup replication, no S3 replication, no
   AWS Backup plan. Losing the region loses the data until AWS restores it. Options, cheapest first:
   - RDS cross-region automated backup replication (for example to `us-east-2`), 7 days;
   - S3 Cross-Region Replication of the private-files bucket;
   - an AWS Backup plan with a cross-region copy and Vault Lock.
   Each is a production change for its own reviewed runbook.
2. **No restore test recorded.** The first test sets the measured RTO (row B-1).
3. **Single operator.** The owner is the only person who can approve a production change. Write
   down who acts if the owner is unavailable (a break-glass contact with sealed credentials).
   **OWNER TO CONFIRM.**

## 5. Testing

- Restore test once a year (row B-1): point-in-time restore of `checksops-production` to a new
  instance, record the time to `available`, compare row counts for key tables, delete the copy.
- Tabletop exercise once a year (row I-1), including one continuity scenario.
