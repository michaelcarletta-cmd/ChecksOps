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

Do not introduce a new Supabase, Lovable, or preview runtime. Historical `supabase/` sources and `supabase.functions.invoke` call sites remain as the AWS adapter surface; they are not a second production backend.

## Local development

Requires Node.js 20+ and npm.

```sh
git clone <YOUR_GIT_URL>
cd ChecksOps
npm i
```

AWS frontend (Cognito + `/prep`):

```sh
npm run dev:aws
```

Default `npm run dev` is a historical Vite mode. Do not point new work at Lovable Cloud or live Supabase keys.

## Production / staging builds

```sh
npm run build:aws
npm run preview:aws
```

Copy values from `.env.production.aws.example` privately for an AWS SPA build. Do not copy that file over `.env.production`.

`npm run build` without `--mode aws` is the legacy Lovable/Supabase bundle path. Do not use it for ChecksOps.com.

## Tests

```sh
npm run test:aws-api
```

## Tenant onboarding

New customers are created from the platform-owner Tenant Admin UI. A new tenant starts fail-closed: no Freedom Moov account, CheckAlt depositor, wallet, bank method, checks, claims, documents, or branding. Provider execution stays off until that tenant is intentionally configured and approved.
