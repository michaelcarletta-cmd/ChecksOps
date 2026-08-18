# Plan: Hide Actum Integration

The goal is to globally disable Actum/Authentecheck UI and logic, following the pattern used to hide Plaid. Moov will be the primary and only visible rail.

## User Review Required

> [!IMPORTANT]
> This will hide the Actum disbursement options and Authentecheck verification UI for all tenants. Actum code remains in the repository but will be unreachable.

## Proposed Changes

### Core Configuration
- Update `src/lib/payments/featureFlags.ts` to set `USE_ACTUM: false`.
- Update `src/hooks/usePaymentRail.ts` to force `isActum: false`.

### UI Hardening
- **Disbursement**: Update `DisbursementConsole.tsx` and `SendPaymentPanel.tsx` to remove the Actum fallback logic and references.
- **Settings**: Remove "Actum Settings" from the Settings page.
- **Verification**: Hide or remove `AuthentecheckVerification` components where they appear (e.g., `StakeholderAccountSettings.tsx`, `BankVerification.tsx`).
- **Payroll**: Ensure Moov is used exclusively in `RunPayrollDialog.tsx` and related components.

### Cleanup
- Remove `src/components/settings/ActumSettings.tsx` and `src/components/disbursement/AuthentecheckVerification.tsx` if they are no longer needed.
- Update `FundsTab.tsx` and other ledger views to handle historical Actum data without offering new Actum actions.

## Technical Details

### `src/lib/payments/featureFlags.ts`
```typescript
export const PAYMENT_FLAGS: PaymentFeatureFlags = {
  USE_ACTUM: false, // Changed from envFlag("USE_ACTUM", true)
  USE_PLAID: false,
  USE_MOOV: true,
  // ...
};
```

### `src/hooks/usePaymentRail.ts`
```typescript
  return {
    rail: "moov" as any, // Force moov context if possible, or handle as disabled actum
    isActum: false,
    isPlaid: false,
    isLoading,
  };
```

### Affected Files
- `src/lib/payments/featureFlags.ts`
- `src/hooks/usePaymentRail.ts`
- `src/pages/Settings.tsx`
- `src/components/disbursement/DisbursementConsole.tsx`
- `src/components/payments/SendPaymentPanel.tsx`
- `src/components/disbursement/StakeholderAccountSettings.tsx`
- `src/components/disbursement/BankVerification.tsx`
