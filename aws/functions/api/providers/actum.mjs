import { denyProviderExecution } from '../provider-flags.mjs';

export const actumInterface = () => ({
  provider: 'actum',
  interfaceOnly: true,
  liveCharges: false,
  edgeFunctionOnMain: false,
  tables: ['actum_transactions'],
  message: 'Actum has no dedicated Edge Function on current main. AWS exposes the interface and secrets boundary only.',
});

export const actumExecutionStub = (operation) => denyProviderExecution('actum', operation, {
  interfaceOnly: true,
});
