# Gate 3B BLOCKED — GetSecretValue denied by KMS

**STOP FOR REVIEW.** Gate 3A **PASS**. Gate 3C **not started**.

`GetSecretValue` on `checksops/production/cloudfront-origin-verify`
fails with `Access to KMS is not allowed` because Step3Temp
`DenyKmsAndRoleChaining` is `kms:*`.

CloudFront was not modified. Custom header quantity on
`ProductionPrepHttpApi` remains 0. WAF remains attached.

Operator: except `alias/aws/secretsmanager` (key
`691886af-d43c-4c6e-a411-3e55f44249ba`) from that deny and allow
`kms:Decrypt` (and Encrypt / GenerateDataKey / DescribeKey) on it.
Do not print the secret. Then resume Gate 3B → 3C observe mode only.
