# Privileged operator — Gate 3B only

**STOP FOR REVIEW. DO NOT DEPLOY GATE 3C FROM THIS PACKAGE.**
Do not attach the authorizer. Do not set `ORIGIN_VERIFY_REQUIRE=true`.
Do not broaden `ChecksOpsCursorApiPerimeterStep3Temp` (keep the KMS deny).
Do not modify SPA / prep Lambda / RDS / Cognito / WAF / DNS.

Gate 3A is **PASS**. Step3Temp cannot `GetSecretValue`. This package is
the operator-only path to add `x-checksops-origin-verify` on
`ProductionPrepHttpApi`.

Script: `aws/origin-verify/operator-apply-gate3b.mjs`
Validate: `aws/origin-verify/operator-validate-gate3b.mjs`

The apply script:

1. Refuses if the caller is Step3Temp.
2. Reads `checksops/production/cloudfront-origin-verify` and keeps
   `current` in memory only.
3. Loads a fresh `GetDistributionConfig` + ETag for `E1B0ZWWO5559U5`.
4. Refuses unless all guards pass:
   - distribution id is `E1B0ZWWO5559U5`
   - WAF ARN is the production CloudFront WAF
   - API origin id is `ProductionPrepHttpApi` → `kiqojucc02.execute-api.us-east-1.amazonaws.com`
   - that origin currently has **0** custom headers
   - `/prep` and `/prep/*` still use CachingDisabled
     `4135ea2d-6df8-44a3-9df3-4b5a84be39ad` and
     AllViewerExceptHostHeader `b689b0a8-53d0-40ab-baf2-68738e2966ac`
5. Adds only header name `x-checksops-origin-verify` on that origin.
   Every other distribution field is left as returned by the fresh config.
6. `UpdateDistribution --if-match <ETag>`.
7. Writes the config to a 0600 temp file, then shreds/unlinks it.
8. Waits until Status `Deployed`.
9. Validates CloudFront Deployed, WAF unchanged, `/prep/health` 200 via
   CloudFront, raw execute-api 200. Never prints the secret.

---

## Commands (privileged IAM, not Step3Temp)

Read-only preflight (no secret, no update):

```
node aws/origin-verify/operator-apply-gate3b.mjs
```

Exits **2** (plan only) unless the execute env is set.

```
CHECKSOPS_OPERATOR_PREFLIGHT=1 node aws/origin-verify/operator-apply-gate3b.mjs
```

Apply (operator only):

```
unset ORIGIN_VERIFY_REQUIRE
export CHECKSOPS_OPERATOR_GATE3B=I_UNDERSTAND_PRODUCTION
export CHECKSOPS_OPERATOR_EXECUTE=1
node aws/origin-verify/operator-apply-gate3b.mjs
unset CHECKSOPS_OPERATOR_EXECUTE CHECKSOPS_OPERATOR_GATE3B
node aws/origin-verify/operator-validate-gate3b.mjs
```

Expected apply JSON includes `headerValuePrinted: false`,
`secretValuePrinted: false`, `startGate3C: false`, `wafUnchanged: true`.

Then **STOP**. Do not run `apply-gate3c.mjs`. Do not change `$default`.
