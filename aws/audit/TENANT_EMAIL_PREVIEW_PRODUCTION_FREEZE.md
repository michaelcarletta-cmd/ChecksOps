# Tenant Email Preview — production freeze

Safeguard-only record. This workstream did not deploy, invalidate CloudFront,
update Lambda, or write production data.

## Current accepted SPA provenance

These values are **provenance, not permanent rollback pins**. Future overlays
start from the then-current live SPA.

| Field | Value |
| --- | --- |
| Index SHA256 | `58c867a066a32813e47f454aeadf7166c609ca9b7b3bb17be6c9f1a6a71d109b` |
| Index VersionId | `KoqxddGRI3swQom6uSEhLcRASAgwbkR9` |
| Entry | `/assets/index-BAD1KYoF.js` |
| Graph | 103 / 103, 0 missing, 0 HTML fallbacks |
| Overlay | Tenant Email Preview |

## Protected signature sender (independently frozen)

| Field | Value |
| --- | --- |
| Function | `checksops-production-prep-api` |
| CodeSha256 | `9OLR9DMhuDrAUp5/TmT6+8bfQC2I6USFk+zwFkluJLQ=` |
| RevisionId | `a6a23fc9-a7cb-4e7c-b1c8-db9cb80ea150` |
| Live `esign.mjs` | `b8f707dfc724a54fb5d973a11cb26380f3381baea26324c08aa30dc93cb5656e` |
| From | `{Request-Owning Tenant Name} <support@checksops.com>` |

Do not copy this worktree's `aws/functions/api/esign.mjs`
(`37c5c742…`) into a production Lambda package.

## Email Preview contract

Settings → Branding & Appearance mounts a tenant-facing **Email Preview**.

- Freedom: `Freedom Adjustment <support@checksops.com>`
- Generic: `{Tenant Name} <support@checksops.com>`
- Branding derives from the current tenant context
- Logo resolution stays on the accepted R4A resolver

Forbidden regressions: `via ChecksOps`, `noreply@checksops.com`,
`ChecksOps <support@checksops.com>`, Sending Domain / Subdomain, DNS, SES,
DKIM, SPF, or infrastructure verification controls.

## Historical provenance only

| Bundle | SHA / VersionId | Rule |
| --- | --- | --- |
| Previous R4A production SPA | `6b211037…` / `advEv5N0JfqM41odUraOM7kCH6Z2snP3` | Must never automatically replace the newer Email Preview SPA |
| Staging preview SPA | `3201c90c…` | Never production authority |
| Pre-R4A post-image SPA | `342c2e15…` | Already historical |

## Future SPA overlay rule

A future change that does not explicitly supersede this contract must preserve
it. Changing a protected preview file requires an explicit allowlist, the
preview regression suite, tenant isolation, the signature-sender contract, the
guarded SPA promotion process, production data-plane proof, and a complete
recursive asset graph.

Protected source:

- `src/lib/signatureRequestSender.ts`
- `src/components/settings/SignatureRequestEmailPreview.tsx`
- Email Preview mount inside `src/components/settings/TenantBrandingSettings.tsx`
  (mount/contract only; unrelated Branding Settings work is not locked)
