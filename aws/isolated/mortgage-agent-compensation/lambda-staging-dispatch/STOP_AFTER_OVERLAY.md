# STOP — staging Mortgage Agent Compensation dispatcher repair

Manual UAT may proceed. Overlay is complete. No further writes from this workstream.

## After identity

* Function: `checksops-staging-api`
* CodeSha256: `2A5rH3IXzdd6R8Rnv9FRlVDRkb725qQCA0s/MXPgvvQ=`
* RevisionId: `41c1df5c-9960-4549-a6d6-a8cee87acd31`
* LastModified: `2026-10-04T20:06:28.000+0000`

Starting authority was `aZ0K2droM3XKT0eQRUYdHEKwW0ehTlAy8VY/qm7YCgE=` / `99a9dd03-e001-448f-8c18-7ba9f0e823e5`.

## Delta

Only `app-services.mjs` changed. Member count stayed 6480. No adds. No deletes.

Patched dispatcher SHA256: `a82cbbd9fee129d78400ec3f715f18441f964c08c9f6e55d283622e8d43362bf`

Added lines only:

* `import { handleMortgageAgentCompensation } from './mortgage-agent-compensation.mjs';`
* `'mortgage-agent-compensation'` in `CLASS_A_FUNCTIONS`
* `case 'mortgage-agent-compensation': return handleMortgageAgentCompensation(event);`

## Routing

* `POST /functions/v1/mortgage-agent-compensation` unauth: `401 missing_cognito_token` (was `403 provider_disabled`)
* `POST /functions/v1/hire-mortgage-agent` unauth: `401 missing_cognito_token`
* `homeowner-ledger-endorse-link` unauth: `400 missing_fields` (still registered)
* `homeowner-ledger-document-sign-link` unauth: `400 missing_fields` (still registered)
* `send-signature-request` unauth: `401 missing_cognito_token`
* `tenant-email-branding-get` unauth: `401 missing_cognito_token`
* unknown function unauth: `403 provider_disabled`

## Preserved members

Unchanged: `mortgage-agent-compensation.mjs`, `homeowner.mjs`, `email-branding.mjs`, `esign.mjs`, `tenant-admin.mjs`, `identity.mjs`, `workflow-rpc.mjs`, `write-check-workflow.mjs`, `index.mjs`.

## Controls

Production API remains `CWB8lxnHoqANyVcaNpKL7h4MtDSPMlHZ6wliFuGE6yA=` / `16327bba-cc0a-4a17-b2a8-55b7b2d1b069`.

Official one-use replay refused. No SPA, SQL, Cognito, provider, production, agent, or financial writes.
