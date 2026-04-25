# Plan: Make ChecksOps the Industry-Leading Insurance Check Command Center

## Goal
Keep **FreedomClaims.work** as the internal CRM and make **ChecksOps.com** the standalone white-label platform for insurance check intake, endorsement control, deposit readiness, and loss draft visibility.

This will not rebuild what already exists. It will sharpen, organize, and expand the ChecksOps experience around the strongest competitive position: **control, transparency, auditability, and white-label operations**.

## What will change

### 1. Strengthen the ChecksOps public positioning
Update the ChecksOps marketing page so it clearly competes as a full operating system, not just a payment tool.

Messaging will emphasize:
- Insurance check command center
- Digital endorsement workflows
- Claim-centered check files
- Loss draft visibility without taking control away from the professional
- White-label portals for PAs, contractors, mitigation companies, and claim teams
- Secure audit trail and partner sharing

I will avoid positioning ChecksOps as if it directly handles mortgage companies. Instead, the message will be:

> ChecksOps gives you visibility, documentation, and workflow control over mortgage/loss-draft funds without forcing you to hand the claim relationship to a third-party payment middleman.

### 2. Turn current check grouping into stronger “Claim Check Files”
The Check Command Center already groups checks by claim number and policyholder. I will make that feel more intentional and powerful.

Updates:
- Rename claim group headers visually into **Claim Check File** sections.
- Add group-level indicators such as:
  - total check value
  - number of checks
  - endorsement progress
  - blocked / pending / ready status
  - loss draft required indicator when applicable
- Make grouped rows easier to scan on desktop and mobile.

This makes ChecksOps feel claim-centered rather than transaction-centered.

### 3. Add bottleneck intelligence inside ChecksOps
Add an operational intelligence strip near the top of the Check Command Center.

It will surface practical issues like:
- checks waiting on endorsements
- checks needing manual review
- checks ready for deposit
- checks requiring branch deposit
- reissue requests
- funds blocked in loss draft
- stale or overdue loss draft follow-ups

Where possible, this will reuse the existing tenant-scoped dashboard functions already in the backend. If an extra metric is needed, I will add it through a safe backend migration with tenant isolation.

### 4. Reframe the Loss Draft area as “Loss Draft Visibility”
The existing Loss Draft Tracker is already strong. I will refine the UI language so it does not imply ChecksOps personally handles mortgage companies.

Language will shift from “we handle mortgage disbursements” to:
- track lender-held funds
- document every follow-up
- monitor missing documents
- record draw requests and releases
- prove where funds are stuck
- keep the professional in control

The workflow stays intact, but the competitive positioning becomes cleaner.

### 5. Improve white-label tenant polish
Make tenant workspaces feel more standalone and branded.

Updates:
- Improve the header subtitle inside tenant ChecksOps workspaces.
- Keep tenant logo/name/plan badge visible.
- Add clearer settings language for tenant branding.
- Show the correct ChecksOps-style URL guidance on `checksops.com` and the `/wl/:slug` fallback on FreedomClaims/preview routes.

This helps ChecksOps feel like a licensed platform, not an internal CRM page.

### 6. Preserve domain separation
No CRM data will be moved.

Routing remains:

```text
FreedomClaims.work
  Internal CRM: claims, clients, tasks, Darwin, estimates, documents, settings

ChecksOps.com
  Public ChecksOps landing page
  Tenant login
  Tenant white-label check workspaces at /:tenantSlug/checks
```

I will only adjust copy and UI behavior where needed to reinforce this split.

## Technical implementation

Planned areas to update:
- `src/pages/marketing/CheckCenterMarketing.tsx`
  - stronger competitive copy
  - refined hero/sections
  - new “not a payment middleman” positioning
- `src/pages/CheckCommandCenter.tsx`
  - Claim Check File group headers
  - operational intelligence strip
  - improved tab counts/labels where needed
- `src/components/check-review/CheckDashboardCards.tsx`
  - likely reuse or adapt for the new intelligence strip
- `src/components/loss-draft/LossDraftDashboard.tsx`
  - refine language around tracking and visibility
- `src/components/loss-draft/LossDraftDashboardCards.tsx`
  - keep the strong blocked/stale/unreleased metrics, with clearer labels
- `src/components/white-label/WhiteLabelCheckCenter.tsx`
  - stronger standalone tenant header/subtitle if needed
- `src/components/white-label/WhiteLabelSettings.tsx`
  - clearer branding/domain wording

Possible backend change:
- If current counts are not enough for the new intelligence strip, add a tenant-scoped backend function or extend the existing tenant dashboard count function.
- Any backend change will preserve tenant isolation and existing access rules.

## What will not change

- FreedomClaims.work will not be replaced by ChecksOps.
- Claim files will not be moved out of the CRM.
- ChecksOps will not claim to directly handle mortgage companies.
- Existing check upload, OCR, endorsement, deposit, partner sharing, and loss draft workflows will remain.
- Tenant isolation will remain enforced through tenant IDs and backend access rules.

## Result
ChecksOps.com will look and feel like a focused industry platform:

- public-facing product brand
- tenant-branded workspaces
- claim-centered check files
- endorsement and deposit command center
- loss draft visibility and bottleneck tracking
- stronger competitor positioning against iink without copying their mortgage-company handling model