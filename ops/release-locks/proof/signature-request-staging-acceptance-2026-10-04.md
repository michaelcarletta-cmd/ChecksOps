# Signature Request staging acceptance — 2026-10-04

Manual end-to-end UAT passed on current staging. This file records the accepted composition. It does not deploy production, apply SQL, or mutate the pending request.

## Accepted live staging fingerprints

| Surface | Identity |
| --- | --- |
| SPA entry | `/assets/index-DDibq3aS.js` |
| SPA `index.html` sha256 | `1236a7b145e43bab4cb99b933febd90e2fcc553a0ba93c9575267f25681371e9` |
| API `checksops-staging-api` CodeSha256 | `aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=` |
| API RevisionId | `99a9dd03-e001-448f-8c18-7ba9f0e823e5` |
| `esign.mjs` | `7c60b6462f7e0caa21800481a68735a44fc38bde19d74f78c64bc5ca97956b74` |
| `signature-submit.mjs` | `24845b4cfbce74de6163a7f94174d5c56af2e5828cfbdeca99c791175150f38d` |
| `email-branding.mjs` | `8b23eb8893377bad1c11d9a02522c789d222053b084d4ba53107eae7d374bb4b` |
| `homeowner.mjs` | `e770bbca94c31096443a96b03aed6a0e36e780ef79b17e1e73423647ede3e302` |
| `homeowner-signing-integration.mjs` | `d1a83f97003024419fcab8948667a3789d1e623e32f7229144587a35dc755a6f` |

Production `checksops-production-prep-api` remained `CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=` rev `16327bba-cc0a-4a17-b2a8-55b7b2d1b069`.

## Applied staging SQL (catalog, not reapplied)

| SQL | Source sha256 | Role |
| --- | --- | --- |
| 73 | `02a19f8ef11cb3e60122b1ff1e07dd331f95a677d13028564d497ef06e523c9e` | Homeowner ledger last-viewed best-effort |
| 74 | `a7ee929bc25a7ca56bf29dacebdab20198bf1a7625e661333545dc9d1f662c4f` | Homeowner signing RLS-boundary doorways |
| 75 | `cbf158109926f12a8ec2a32b6815978468dc9d3f5fe22560c2646826582c8283` | Column-scoped `check_files.signature_request_id` UPDATE grant; RLS stays enforced |

Live catalog routine-definition hashes were not readable from this environment (`DATABASE_SECRET_ARN` is present on `checksops-staging-api`, but the read-only query timed out with no VPC path). Source hashes plus prior staging apply evidence are the freeze pins. Do not reapply SQL 73/74/75.

## Manual UAT

Passed: Files-tab create, Class A create-payload, request/signers, check-file association, send, token lifecycle, Homeowner discovery/doorway, `/sign`, submit, completion, correctly located stamp, signed PDF returned to ChecksOps.

## Storage contract

Claim-linked completed PDF: `signed/{claim_id}/{request_id}-final.pdf` under `files/claim-files/`, attached by `aws_public_signature_attach_signed`.

## Status

Staging-locked, not production. Future compositions must keep this chain or explicitly update the lock.
