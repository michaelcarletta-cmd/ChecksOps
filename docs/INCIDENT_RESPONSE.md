# ChecksOps Incident Response Plan

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

## 3. Process
1. **Detect** — alert sources: Supabase audit, `glba_security_events`, customer report, vendor notice
2. **Triage** — within 1 hour, assign severity (Sev 1 NPI exposure / Sev 2 internal-only / Sev 3 attempted)
3. **Contain** — revoke compromised tokens, rotate API keys (`ai_gateway--rotate_lovable_api_key`, Supabase service role, Actum, CheckAlt), block IPs
4. **Eradicate** — patch vulnerability, remove malicious artifacts
5. **Recover** — restore from clean backup if needed, monitor for recurrence
6. **Notify** —
   - Internal: within 24 hours to CEO + Legal
   - FTC: within 30 days if ≥ 500 consumers (16 CFR 314.5)
   - State AGs and consumers: per state matrix (typically 30–60 days)
   - Tenants: within 72 hours of confirmation
7. **Post-mortem** — written within 14 days, filed under `docs/incidents/YYYY-MM-DD.md`

## 4. Evidence Preservation
- Snapshot relevant Postgres tables and storage buckets before mutation
- Export `audit_logs`, `glba_security_events`, `pii_reveal_logs` for impacted window
- Preserve edge function logs (`supabase--edge_function_logs`)

## 5. Communication Templates
Drafts under `docs/templates/notification-*.md` (customer, regulator, vendor).

## 6. Tabletop Exercise
Annually. Scenarios rotate: phishing → admin token compromise; vendor breach (CheckAlt); ransomware on engineer laptop; lost device with cached PII; insider exfiltration via export.
