# ChecksOps

Insurance check endorsement, deposit, and disbursement operations.

Production runtime is the accepted AWS stack:

- Cognito
- AWS `/prep` API
- RDS
- S3
- Textract
- SES
- AWS public workflow handlers
- CheckAlt production execution
- Moov production execution implementation

The SPA talks to AWS through `src/integrations/aws/client.ts`. There is no hosted-Supabase or Lovable production path.

## Local development

Requires Node.js 20+ and npm.

```sh
git clone <YOUR_GIT_URL>
cd ChecksOps
npm i
cp .env.aws.example .env.aws
npm run dev
```

## Production / staging builds

```sh
npm run build
npm run preview
```

`npm run build` and `npm run build:aws` are the same AWS Cognito frontend. Copy values from `.env.production.aws.example` privately for a production SPA build. Do not put `VITE_SUPABASE_*` in `.env.production`.

## Tests

```sh
npm run test:aws-api
```

## Tenant onboarding

New customers are created from the platform-owner Tenant Admin UI. A new tenant starts fail-closed: no Freedom Moov account, CheckAlt depositor, wallet, bank method, checks, claims, documents, or branding. Provider execution stays off until that tenant is intentionally configured and approved.
