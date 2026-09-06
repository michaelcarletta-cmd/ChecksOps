# Associate existing CloudFront WAF with E1B0ZWWO5559U5

**DO NOT DEPLOY THIS AS CLOUDFORMATION AGAINST THE DISTRIBUTION.**  
**DO NOT use `AWS::WAFv2::WebACLAssociation` for CloudFront.**  
**DO NOT recreate or replace `E1B0ZWWO5559U5`.**  
**DO NOT recreate the WAF.**  
**DO NOT enable CloudFront “security protections” / default AWS WAF.**

Financial/provider activation remains **NOT AUTHORIZED**. Leave Moov,
CheckAlt, provider execution, financial execution **OFF**. Leave
`64_financial_activation_grants.sql` **NOT_APPLIED**.

Inspected read-only at **2026-09-06T23:30:04Z**. No AWS mutations from
that inspect.

---

## 1. Current ownership / stack

| Item | Live |
|---|---|
| Distribution | `E1B0ZWWO5559U5` / `dmgs35lzv89ms.cloudfront.net` |
| Status | `Deployed`, Enabled |
| Live `WebACLId` | **empty** (not associated) |
| Aliases | `checksops.com`, `www.checksops.com` |
| ACM | `arn:aws:acm:us-east-1:806168576068:certificate/5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3` |
| Logging | Enabled, cookies false, bucket `checksops-production-access-logs-806168576068.s3.amazonaws.com`, prefix `cloudfront/E1B0ZWWO5559U5/` |
| Origin | `ProductionSpaS3` → `checksops-production-frontend-806168576068.s3.us-east-1.amazonaws.com` OAC `E35N26NNHZAG11` |
| Creating stack | `checksops-production-prep` = **CREATE_COMPLETE** |
| Stack output `ProductionCloudFrontId` | `E1B0ZWWO5559U5` |
| Stack template in repo | `aws/production/prep-stack.yaml` resource `ProductionFrontendDistribution` |
| WAF stack | `checksops-production-cloudfront-waf` = **CREATE_COMPLETE** |
| WAF ACL | `checksops-production-cloudfront-waf` |
| WAF ARN (set this on CloudFront) | `arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7` |
| WAF Id (do **not** put this in `WebACLId`) | `cc8aadde-2bab-4d5e-8144-7d8981f44ad7` |

The distribution was **created** by CloudFormation, then **changed
out-of-band**. The original stack template still has **no** `Aliases`,
**no** ACM `ViewerCertificate`, **no** `Logging`, **no** `WebACLId`, and
comment `checksops-production-prep SPA (no checksops.com aliases; DNS
unchanged)`. Live config has aliases, ACM, logging, and a different
comment.

Therefore `checksops-production-prep` is **not safely updatable** to set
WAF. A CloudFormation update of `ProductionFrontendDistribution` would
send the stale `DistributionConfig` and would try to remove aliases,
ACM, and logging. Do **not** import the distribution into a new stack.
Do **not** add `WebACLId` to `prep-stack.yaml` and deploy.

`AWS::WAFv2::WebACLAssociation` is **not** valid for CloudFront. The WAF
stack must stay ACL-only.

---

## 2. Exact proposed change

Set **only** `DistributionConfig.WebACLId` on the existing distribution
to the WAF **ARN** above. Copy every other field from the current
`get-distribution` config. No CloudFormation change to the distribution.

Replacement risk: **NO** (in-place `UpdateDistribution` of `WebACLId`).  
Other CloudFront properties changed: **NO** (if the operator copies the
live config and edits only `WebACLId`).

---

## 3. Operator steps (minimal, in-place)

Use an operator principal that can `cloudfront:GetDistribution` and
`cloudfront:UpdateDistribution`. Do not use the Cloud Agent role for
this. Work in account `806168576068`. CloudFront APIs are global;
`--region us-east-1` is fine.

Do not open the CloudFront “Enable security protections” wizard. That
attaches AWS default managed protections, not this reviewed ACL.

### A. Record baseline (read-only)

```bash
aws cloudfront get-distribution --id E1B0ZWWO5559U5 \
  --query "Distribution.{Status:Status,Domain:DomainName,WebACLId:DistributionConfig.WebACLId,Aliases:DistributionConfig.Aliases,ACM:DistributionConfig.ViewerCertificate.ACMCertificateArn,Logging:DistributionConfig.Logging}"
```

Confirm `WebACLId` is empty, aliases are apex/www, ACM ARN matches, and
logging is still enabled with cookies false.

Confirm the WAF stack output (do not recreate the ACL):

```bash
aws cloudformation describe-stacks --region us-east-1 \
  --stack-name checksops-production-cloudfront-waf \
  --query "Stacks[0].{Status:StackStatus,Outputs:Outputs}"
```

Confirm the seven reviewed rules are unchanged (managed **COUNT**, path
rates **BLOCK** 100/300/200). Do not edit the ACL.

### B. Patch only WebACLId

```bash
aws cloudfront get-distribution --id E1B0ZWWO5559U5 \
  --output json > /tmp/e1b0-before.json

python3 - <<'PY'
import json
from pathlib import Path
src = json.loads(Path("/tmp/e1b0-before.json").read_text())
cfg = src["Distribution"]["DistributionConfig"]
assert not cfg.get("WebACLId"), cfg.get("WebACLId")
assert set(cfg["Aliases"]["Items"]) == {"checksops.com", "www.checksops.com"}
assert cfg["ViewerCertificate"]["ACMCertificateArn"].endswith("5cdde8e7-49fb-4b42-ba36-9aaa9d9b1aa3")
assert cfg["Logging"]["Enabled"] is True
assert cfg["Logging"]["IncludeCookies"] is False
cfg["WebACLId"] = (
    "arn:aws:wafv2:us-east-1:806168576068:global/webacl/"
    "checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7"
)
Path("/tmp/e1b0-webacl-only.json").write_text(json.dumps(cfg, indent=2) + "\n")
Path("/tmp/e1b0-etag.txt").write_text(src["ETag"])
print("etag", src["ETag"])
print("webacl", cfg["WebACLId"])
PY

# Diff must show only WebACLId (plus JSON formatting). Stop if anything else appears.
diff -u \
  <(python3 -c 'import json;from pathlib import Path;print(json.dumps(json.loads(Path("/tmp/e1b0-before.json").read_text())["Distribution"]["DistributionConfig"],indent=2,sort_keys=True))') \
  <(python3 -c 'import json;from pathlib import Path;print(json.dumps(json.loads(Path("/tmp/e1b0-webacl-only.json").read_text()),indent=2,sort_keys=True))')
```

The diff must be **only** `WebACLId`: `""` → the ARN. If the diff shows
aliases, certificate, logging, origins, behaviors, or cache policies,
**stop**.

```bash
aws cloudfront update-distribution \
  --id E1B0ZWWO5559U5 \
  --if-match "$(cat /tmp/e1b0-etag.txt)" \
  --distribution-config file:///tmp/e1b0-webacl-only.json
```

Wait until `Status` is `Deployed`. Do not change DNS, S3, Cognito,
Lambda, API Gateway, or staging while it deploys.

### C. Verify (read-only)

```bash
aws cloudfront get-distribution --id E1B0ZWWO5559U5 \
  --query "Distribution.{Status:Status,WebACLId:DistributionConfig.WebACLId,Aliases:DistributionConfig.Aliases.Items,ACM:DistributionConfig.ViewerCertificate.ACMCertificateArn,Logging:DistributionConfig.Logging,Origin:DistributionConfig.Origins.Items[0].DomainName}"
```

Expect:

- `Status` = `Deployed`
- `WebACLId` = the ARN above (not the short id)
- Aliases still `checksops.com` and `www.checksops.com`
- Same ACM ARN
- Logging still enabled, cookies false, same bucket/prefix
- Same S3 origin
- WAF stack still `CREATE_COMPLETE` with the same seven rules
- Staging CloudFront `E1CG52WRQZI7X1` unchanged

---

## 4. Rollback

Repeat the same get → copy config → edit **only** `WebACLId` →
`update-distribution --if-match` flow. Set `WebACLId` to `""` to detach.
Do not delete the WAF stack. Do not change other distribution fields.

---

## 5. What not to do

- Do not `cloudformation deploy` / `update-stack` on
  `checksops-production-prep` to add `WebACLId`.
- Do not add `AWS::WAFv2::WebACLAssociation` to
  `aws/production/waf-cloudfront.yaml`.
- Do not create a second distribution or second Web ACL.
- Do not import `E1B0ZWWO5559U5` into a new stack.
- Do not enable CloudFront default security protections.
- Do not attach the regional API ACL
  (`checksops-production-api-waf`) to CloudFront.
