# SH-1 Accepted Production Baseline

This file records the accepted live production state after the SH-1 browser security
headers activation and its mandatory post-change smoke/telemetry gate.

It is evidence only. It is not restore authority. Before every future mutation,
production must be read again and the newer live state, if any, remains authoritative.

## Accepted source

- Main commit at verification: `f469be547b16a8ae3e8fdd2011f610ad203f1952`
- Source policy definition: `aws/production/cloudfront-security-headers.yaml`

## Accepted production fingerprint

- CloudFront distribution: `E1B0ZWWO5559U5`
- Distribution status: `Deployed`
- Distribution ETag: `E1VC38T7YXB528`
- WAF: `arn:aws:wafv2:us-east-1:806168576068:global/webacl/checksops-production-cloudfront-waf/cc8aadde-2bab-4d5e-8144-7d8981f44ad7`
- Response headers policy: `756a8f23-68dd-4f8a-8293-5a2fd08f919a`
- Response headers policy name: `checksops-production-browser-security-headers`
- Response headers policy ETag: `E23ZP02F085DFQ`
- Policy attached to default SPA behavior: yes
- Policy attached to `/prep`: yes
- Policy attached to `/prep/*`: yes

## Acceptance gate

The post-activation verification confirmed CloudFront returned to `Deployed`, the
existing WAF remained attached, and the intended response headers policy was attached
to the three intended behaviors. The immediate telemetry gate showed zero API Gateway
5xx datapoints and zero `checksops-production-prep-api` Lambda error datapoints in
the verification window.

No SPA bundle, Lambda code, SQL/RLS, Cognito/login, Moov/payments, WalletOps,
Signature Requests, OCR, Mortgage Ops, or Claim Ledger code was replaced by this step.

## Forward-compose rule

This fingerprint is historical evidence only. It must never be used to restore or
overwrite a newer production composition. Before the next security mutation, fresh-read
GitHub and the live AWS targets, compare them with this evidence, and stop or
forward-reconcile if production has moved.
