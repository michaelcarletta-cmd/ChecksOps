# Plan: Moov UX Best Practices Alignment

The current Moov implementation in ChecksOps is functional but can be improved to align more closely with Moov's official UX Best Practices, specifically around reducing friction during onboarding and bank verification.

## Proposed Changes

### 1. Streamline Onboarding Navigation
- **Current:** Opens onboarding in a new tab.
- **Improvement:** Update `PaymentAccountPanel.tsx` and `TenantPaymentAccountPanel.tsx` to handle the transition more seamlessly. We will add a "Setup in Progress" overlay or state to guide the user to return and refresh once they finish the external flow.

### 2. Enhance Bank Linking Drop Feedback
- **Current:** Basic toast on success/error.
- **Improvement:** Update `MoovBankLink.tsx` to use more descriptive placeholder text and better error mapping from the Moov Drop.

### 3. Clearer Capability Status & "Fix" Actions
- **Current:** Lists required fields in a text box.
- **Improvement:** In `PaymentAccountPanel.tsx`, if the status is `additional_information_required` or `restricted`, the primary action button should dynamically change to "Provide Missing Information" and deep-link directly into the Moov onboarding flow for those specific requirements.

### 4. Micro-deposit Guidance
- **Current:** Basic input fields for amounts.
- **Improvement:** Add a "Where to find these?" tooltip/help text in `MicroDepositVerification.tsx` explaining that the amounts appear as "MOOV" or "CHECKS OPS" on their bank statement.

## Technical Details
- **Files:** `src/components/payments/PaymentAccountPanel.tsx`, `src/components/payments/MoovBankLink.tsx`, `src/components/payments/MicroDepositVerification.tsx`.
- **Logic:** No schema changes required. Purely UI/UX enhancement to existing Edge Function triggers.

## Next Steps
- Implement the "Fix Information" button logic.
- Add instructional tooltips to micro-deposit confirmation.
- Refine the onboarding tab-closing/return-home logic.
