---
title: Moov Capabilities Audit & Alignment
description: Audit and align Moov account capabilities implementation with the official documentation.
type: feature
---

# Plan: Moov Capabilities Audit & Alignment

The user is asking if "Capabilities" (as described in Moov's documentation: https://docs.moov.io/guides/accounts/capabilities/) are set up in ChecksOps. 

Based on the audit of the codebase:
1.  **Requesting Capabilities**: `moov-account-create`, `moov-onboarding-link`, and `moov-sync` already request the standard set: `transfers`, `send-funds`, `collect-funds`, and `wallet`.
2.  **Tracking Capabilities**: `moov-sync` and `moov-readiness` fetch and evaluate the status of these capabilities.
3.  **UI Feedback**: `PaymentReadinessPanel.tsx` and `PaymentAccountPanel.tsx` use the capability flags to show the user whether they can move money.

We can improve this by:
- Explicitly requesting `send-funds.ach` and `collect-funds.ach` (newer Moov rail-specific identifiers) alongside the base capabilities.
- Ensuring `moov-readiness.ts` handles the specific rail capabilities correctly.
- Adding better error handling for capability-related failures.

## Proposed Changes

### Backend (Edge Functions)

#### 1. Update Capability Requests
- Modify `moov-account-create` and `moov-sync` to request rail-specific capabilities if available, ensuring the platform is ready for ACH movement.

#### 2. Refine Readiness Evaluation
- Update `_shared/moovReadiness.ts` to be more robust against Moov's evolving capability naming (e.g., ensuring `send-funds.ach` is prioritized).

### Frontend

#### 1. Enhanced Readiness Display
- Update the Payment Readiness UI to explicitly show which rails (ACH Standard, Same-Day) are enabled based on capability statuses.

## Technical Details
- **Files to modify**:
    - `supabase/functions/moov-account-create/index.ts`
    - `supabase/functions/moov-sync/index.ts`
    - `supabase/functions/_shared/moovReadiness.ts`
    - `src/components/payments/PaymentReadinessPanel.tsx`
- **Validation**:
    - Use `moov-selftest` edge function to verify capability reads.
    - Check the Payment Readiness panel in the UI to ensure statuses update correctly when syncing.
