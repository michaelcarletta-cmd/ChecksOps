# Batch 2 WAF operator procedure (Console / CloudFormation)

The Cloud Agent staging role cannot create WAFv2 ACLs
(`wafv2:CreateWebACL` denied on `ChecksOpsCursorCloudStaging`).
Do **not** broaden that role. Deploy the reviewed templates from an
operator principal that already has WAF + CloudFront update rights.

**This document does not authorize Moov, CheckAlt, provider execution,
financial execution, or `64_financial_activation_grants.sql`.**

Account `806168576068`, region **`us-east-1`**. CloudFront WAF is
global/CLOUDFRONT scope and must still be created in `us-east-1`.

---

## Current live state after agent apply

| Item | Live |
|---|---|
| CloudFront | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` |
| Aliases | `checksops.com`, `www.checksops.com` |
| WebACLId | empty (not attached) |
| HTTP API | `kiqojucc02` stage `prep` |
| Failed stacks | `checksops-production-cloudfront-waf` and `checksops-production-api-waf` were `ROLLBACK_COMPLETE` after `wafv2:CreateWebACL` denial. Delete them before recreate if they still exist. |
| Staging API | `psr19uhop4` — do **not** attach WAF here |

---

## Reviewed templates (already in repo)

- `aws/production/waf-cloudfront.yaml` → stack `checksops-production-cloudfront-waf`
- `aws/production/waf-api.yaml` → stack `checksops-production-api-waf`

Do not change rule actions in this batch.

### CloudFront ACL `checksops-production-cloudfront-waf`

| Priority | Rule | Mode |
|---|---|---|
| 0 | `AWSManagedRulesCommonRuleSet` | **COUNT** |
| 1 | `AWSManagedRulesKnownBadInputsRuleSet` | **COUNT** |
| 2 | `AWSManagedRulesAmazonIpReputationList` | **COUNT** |
| 10 | General flood 2000 req / 5 min / IP | **COUNT** |
| 20 | `/auth` 100 req / 5 min / IP | **BLOCK** |
| 21 | `/storage` 300 req / 5 min / IP | **BLOCK** |
| 22 | `/public` 200 req / 5 min / IP | **BLOCK** |

Default action: **Allow**.

### Regional API ACL `checksops-production-api-waf`

| Priority | Rule | Mode |
|---|---|---|
| 0 | `AWSManagedRulesCommonRuleSet` | **COUNT** |
| 1 | `AWSManagedRulesKnownBadInputsRuleSet` | **COUNT** |
| 20 | `/auth` 100 req / 5 min / IP | **BLOCK** |
| 21 | `/storage` 300 req / 5 min / IP | **BLOCK** |
| 22 | `/public` 200 req / 5 min / IP | **BLOCK** |

Association: `arn:aws:apigateway:us-east-1::/apis/kiqojucc02/stages/prep`.

Managed rules stay in COUNT so we can report false positives before
enforcing. Path rate limits are conservative BLOCK ceilings.

---

## Console / CLI steps

Work only in **`us-east-1`**. Do not change RDS, Cognito MFA, staging
Lambda, DNS, or any `AWS_*_ENABLED` flags.

1. CloudFormation → delete `checksops-production-cloudfront-waf` and
   `checksops-production-api-waf` if status is `ROLLBACK_COMPLETE`.
2. Deploy CloudFront WAF:

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-cloudfront-waf \
  --template-file aws/production/waf-cloudfront.yaml \
  --no-fail-on-empty-changeset
```

3. Deploy API WAF (associates to prep automatically):

```bash
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name checksops-production-api-waf \
  --template-file aws/production/waf-api.yaml \
  --parameter-overrides ApiId=kiqojucc02 StageName=prep \
  --no-fail-on-empty-changeset
```

4. Read the CloudFront WebACL ARN from stack output `WebACLArn`.
5. Attach it to distribution `E1B0ZWWO5559U5` (`WebACLId` = that ARN).
   Wait until the distribution status is `Deployed`.
6. Confirm WAF → Web ACLs:
   - `checksops-production-cloudfront-waf` scope CloudFront, associated
   - `checksops-production-api-waf` scope Regional, associated to
     `kiqojucc02/prep`

Do **not** flip managed rules from COUNT to BLOCK in this batch.

---

## After you finish

Tell the agent the stacks are `CREATE_COMPLETE` and the CloudFront
`WebACLId` is set. The agent will re-verify read-only and will not
create WAF itself.
