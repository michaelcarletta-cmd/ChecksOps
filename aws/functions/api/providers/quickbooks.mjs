import { denyProviderExecution } from '../provider-flags.mjs';

export const quickbooksInterface = () => ({
  provider: 'quickbooks',
  interfaceOnly: true,
  livePayments: false,
  oauth: 'disabled',
  functions: ['quickbooks-auth', 'quickbooks-payment'],
  message: 'QuickBooks OAuth and payment execution stay disabled. Secrets stay in Secrets Manager.',
});

export const quickbooksExecutionStub = (operation) => denyProviderExecution('quickbooks', operation, {
  interfaceOnly: true,
});
