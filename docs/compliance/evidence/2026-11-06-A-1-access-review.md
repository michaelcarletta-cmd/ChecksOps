# Access review 2026 Q4 (row A-1)

**Prepared:** 2026-11-06 22:30 UTC, read-only as `user/claude-code` (Cognito `ListUsers`, IAM, IAM
Identity Center, GitHub collaborators)
**Reviewer:** Michael Carletta, CEO, signs off below
**Matrix rows:** CC6.2, CC6.3

Every tenant member has the same full access within their tenant, so there are no roles to review.
This review asks one question per identity: should it still have access? The list with names and
emails is not stored here (`docs/compliance/EVIDENCE_CALENDAR.md`, "Where records go"). It was given
to the owner as `ACCESS_REVIEW_2026_Q4_NAMED_LIST.md`, and the signed copy goes to the restricted
compliance folder.

## What was reviewed

| Population | Count read | Notes |
|---|---|---|
| Production sign-in users (Cognito `us-east-1_h00WorYMT`) | 13: 12 enabled, 1 disabled, all CONFIRMED; email domains: 4 | No Cognito groups. Every user needs the authenticator code at sign-in since 2026-11-06. |
| AWS console administrators (IAM Identity Center) | 2 users, permission set `AdministratorAccess` | Both appear to belong to the owner. Confirm whether both are needed. |
| IAM users | 1: `claude-code`, programmatic only (no console password), 1 active access key created 2026-10-26 and last used 2026-11-06 | Used by the AI coding agent through the session proxy. Denied infrastructure changes (`ops/security/IAM_CLAUDE_CODE_LEAST_PRIVILEGE.md`). Rotate the key at 90 days (2027-01-24). |
| AWS root | MFA on (`AccountMFAEnabled` = 1), no access keys | Day-to-day root use is an open item (matrix CC6.1). |
| IAM roles (not service-linked) | 30 | Machine identities for the API, logging, the guarded workflows (GitHub OIDC) and RDS. See the findings below. |
| GitHub collaborators on `michaelcarletta-cmd/ChecksOps` | 1: the owner, admin | |
| Staging sign-in users (Cognito `us-east-1_vPmQ7cL1F`), for information | 28: 19 confirmed, 8 never finished sign-up (FORCE_CHANGE_PASSWORD), 1 disabled | Staging is outside the audit scope; tidy it up when convenient. |

## Findings for the owner's decision

Nothing below was changed. Each removal is a separate, owner-approved change.

1. **Production users:** mark each of the 13 as Keep or Remove on the named list. Remove the
   disabled user if the person has left.
2. **Identity Center:** confirm that both administrator users are needed.
3. **IAM roles never used, or unused for 25 days or more** (read 2026-11-06):
   - never used: `Checksops-role-ku1r91ck` (created 2026-09-01), `ChecksOpsGitHubStagingDbReadonlyDiagnosticDeploy`,
     `ChecksOpsStagingDbReadonlyDiagnosticCloudFormationExecution`, `rds-proxy-role-1788286368527`,
     `rds-proxy-role-1788286468693`;
   - 26 days: `ChecksOpsCursorCloudStaging` (a Cursor cloud agent's staging role),
     `ChecksOpsProductionSql53ConfigWriter` (a temporary SQL 53 role);
   - 61 days: `checksops-production-prep-api-role` (the API now runs as
     `checksops-production-api-execution`).

   Recommended: confirm and delete the roles nothing uses, starting with the Cursor role and the
   SQL 53 temporary roles. Do it through a reviewed runbook, as for the hardening items.
4. **`claude-code` access key:** rotate by 2027-01-24 (90 days).

## Sign-off

- [ ] Production users reviewed; removals listed on the named list
- [ ] Identity Center administrators confirmed
- [ ] Role clean-up decided (list which roles go)

Reviewed by: ______________________ (Michael Carletta, CEO)  Date: __________
