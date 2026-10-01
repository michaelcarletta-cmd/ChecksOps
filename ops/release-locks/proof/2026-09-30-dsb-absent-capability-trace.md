# DSb-present / candidate-absent capability trace

Read-only. **No production SPA upload. No Lambda write.**
Unknown checks not mutated. Stop for approval.

Live HTTPS still `/assets/index-DSbVZXu8.js`. Candidate remains
`/assets/index-CvCKsSsX.js` (not rebuilt; source for these three
surfaces did not change).

These three strings are absent from the candidate bundle. Marker
absence is **not** the proof. Live DSb source is `82460c8c2`.
Candidate source is this compose branch.

---

## 1. Default payout speed — equivalent replacement

**Live DSb (`WalletOps.tsx` @ `82460c8c2`)**

Users can change payout speed two ways, both writing the same sweep:

1. Inline **Default payout speed** (`#walletops-rail`) →
   `handleSavePayoutSpeed` → `useSweepConfig().save({ pushRail })`.
2. **Manage sweeps** dialog → `MoovTreasuryPanel` →
   `handleSave` → the same `save({ pushRail: rail })`.

Live compiled `WalletOps-Dhje5XLB.js` contains both
`Default payout speed` / `Save payout preference` and
`Manage sweeps` / `sweep-rail` / `Choose a payout speed first`.

**Candidate (`9afb57fe` WalletOps + unchanged `MoovTreasuryPanel`)**

The inline slot was removed on purpose
(`large box in place of the old payout-preference slot`).
WalletOps still shows the current `config.push_rail` as **Payout speed**
and still opens **Manage sweeps** → `MoovTreasuryPanel`.

`MoovTreasuryPanel.tsx` is **byte-identical** to live DSb.
`useSweepConfig.ts` is unchanged. Compiled candidate
`WalletOps-B4ZiFA_r.js` has `Manage sweeps`, `sweep-rail`,
`Choose a payout speed first`, `Load payout speeds`.

**Verdict:** not a regression. Deploying `CvCKsSsX` keeps the live
treasury write path. Users set speed at WalletOps → Manage sweeps →
Payout speed, then Save / Turn on daily payouts.

---

## 2. Invoice letterhead upload — equivalent replacement

**Live DSb (`CompanyBrandingSettings.tsx`)**

Settings → Invoice branding → `#invoice-letterhead-upload` →
“Click to upload invoice letterhead” → writes
`tenants.invoice_letterhead_url`.

**Candidate (`b97a8dc6` CompanyBrandingSettings)**

Same settings card. Control id is `#invoice-logo-upload`.
Copy is “Click to upload an independent invoice logo”.
`handleInvoiceLogoUpload` calls
`uploadTenantAsset(..., "invoice-logo", "company-branding")` and
save sends `persistableLogoField(...)` as `invoice_letterhead_url`
only when non-blank (does not persist `null`).

Public invoice and Invoices tab still render
`invoice_letterhead_url` with company-logo fallback
(`PublicInvoicePage.tsx`, `InvoicesTab.tsx`).

Compiled candidate entry contains
“Click to upload an independent invoice logo” and
`invoice_letterhead_url`.

**Verdict:** not a regression. Same stored field, safer persist, same
public render. The DSb-only marker `invoice-letterhead-upload` is a
renamed control.

---

## 3. DKIM / sending-subdomain — not a working live capability

**Live DSb (`EmailSenderSettings.tsx` @ `82460c8c2`)**

Settings still paints **Sending subdomain**, Start domain verification
(`tenant-domain-verify`), Check verification, Disable custom sending,
and **DKIM DNS records**. The same page already tells AWS users:

> SES domain APIs are not enabled in this environment.

when `domainFeatureEnabled === false`.

**Server (unchanged; not written this task)**

- `aws/template.yaml`: `AWS_TENANT_EMAIL_DOMAIN_ENABLED: "false"`
- `tenant-email-domain.mjs`: SESv2 is never constructed unless that
  flag is `true`
- `runStartDomainVerification`: if the flag is off and no injected
  mock, returns **503** `tenant_email_domain_disabled`
  (“Tenant SES domain APIs are disabled in this environment.”)

So the live DSb form is a **disabled shell**. Start verification cannot
create SES identities on this environment.

**Candidate (`b97a8dc6` EmailSenderSettings)**

Removes that shell. Users still save **working** email branding:
logo (`persistableLogoField`, no blank wipe), color, From display name,
Reply-To, preview. Mail stays `noreply@checksops.com` (platform sender).
That is the accepted #581/#584 settings replacement.

**Verdict:** not a user-facing regression of a working production
capability. Restoring the DSb DKIM form would put back a 503-disabled
UI and drop persist-safe branding. Not added.

---

## Compose decision

No source overlay added. No rebuild required. Candidate identity
stays `index-CvCKsSsX.js` /
`cd55efcde625c03ab8bba60decec3c4d6b3bb53e3a8e45dd6a4c2b9991065007`.

Behavioral tests:
`aws/tests/dsb-candidate-capability-equivalence.test.mjs`.
