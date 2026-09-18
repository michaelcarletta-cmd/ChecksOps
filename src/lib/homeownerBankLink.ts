/** Query key consumed by Funds UI for the homeowner payout/bank setup link. */

export function homeownerBankLinkQueryKey(checkIntakeItemId: string) {
  return ["homeowner-bank-link", checkIntakeItemId] as const;
}

export function queriesInvalidatedAfterBankLinkSend(checkIntakeItemId: string) {
  return [
    ["check-stakeholders", checkIntakeItemId] as const,
    homeownerBankLinkQueryKey(checkIntakeItemId),
  ];
}
