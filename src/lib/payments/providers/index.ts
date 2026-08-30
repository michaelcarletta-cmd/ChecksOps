import type { PaymentProvider, PaymentProviderId } from "../types";
import { plaidProvider } from "./plaidProvider";
import { moovProvider } from "./moovProvider";

const REGISTRY: Record<PaymentProviderId, PaymentProvider> = {
  plaid: plaidProvider,
  moov: moovProvider,
};

export function getProvider(id: PaymentProviderId): PaymentProvider {
  const provider = REGISTRY[id];
  if (!provider) throw new Error(`Unknown payment provider: ${id}`);
  return provider;
}

export { plaidProvider, moovProvider };
