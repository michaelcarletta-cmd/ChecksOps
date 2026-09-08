# Gate 3B BLOCKED — GetSecretValue denied by KMS

**STOP FOR REVIEW.** Gate 3A **PASS**. Gate 3C **not started**.

`GetSecretValue` on `checksops/production/cloudfront-origin-verify`
fails with `Access to KMS is not allowed` because Step3Temp
`DenyKmsAndRoleChaining` is `kms:*`.

CloudFront was not modified. Custom header quantity on
`ProductionPrepHttpApi` remains 0. WAF remains attached.

Do **not** broaden Step3Temp. Use the privileged-operator Gate 3B
package in `aws/cutover/API_PERIMETER_STEP3_OPERATOR_GATE3B.md`.
Do not start Gate 3C from that package.
