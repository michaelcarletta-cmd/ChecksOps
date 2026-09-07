# ChecksOps Incident Response Plan

**Production AWS is authoritative here:**
[`aws/cutover/INCIDENT_RESPONSE_AWS.md`](../aws/cutover/INCIDENT_RESPONSE_AWS.md)

This file keeps GLBA notification roles. Do not use the old Supabase/Lovable
containment steps (edge-function logs, Lovable API key rotation, Supabase
service-role revoke) against live AWS ChecksOps.

**Owner:** Qualified Individual — security@checksops.com  
**Tested:** Annually (tabletop exercise)

## 1. Definitions
- **Security event:** Any observed deviation from expected security posture (failed login spike, unusual export, suspicious vendor activity).
- **Security incident:** Confirmed unauthorized access, acquisition, or use of NPI, or material loss of availability/integrity.
- **Reportable breach (GLBA / FTC):** Notification event affecting unencrypted NPI of **500 or more consumers** — FTC must be notified within **30 days** of discovery.

## 2. Roles
| Role | Responsibility |
|---|---|
| Qualified Individual | Incident commander, regulator notifications |
| Engineering on-call | Containment, forensic preservation |
| Legal | Privilege, state notification matrix |
| Communications | Customer notifications, press |
| CEO | Final authorization for public statements |

## 3. AWS process (summary)

Use `aws/cutover/INCIDENT_RESPONSE_AWS.md` for:

- Credential compromise
- Database compromise / 35-day PITR
- S3 / check-image exposure
- Cognito / account takeover
- WAF / DDoS / API abuse
- Provider/payment compromise (**providers stay OFF**)

Do not enable Moov, CheckAlt, provider execution, or financial grants
during response.

## 4. Notification (unchanged)

- Internal: within 24 hours to CEO + Legal
- FTC: within 30 days if ≥ 500 consumers (16 CFR 314.5)
- State AGs and consumers: per state matrix (typically 30–60 days)
- Tenants: within 72 hours of confirmation
- Post-mortem: written within 14 days, filed under `docs/incidents/YYYY-MM-DD.md`
