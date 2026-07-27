import type { PaymentProvider, PaymentProviderId } from "../types";
import { actumProvider } from "./actumProvider";
import { plaidProvider } from "./plaidProvider";
import { moovProvider } from "./moovProvider";

const REGISTRY: Record<PaymentProviderId, PaymentProvider> = {
  actum: actumProvider,
  plaid: plaidProvider,
  moov: moovProvider,
};

export function getProvider(id: PaymentProviderId): PaymentProvider {
  const provider = REGISTRY[id];
  if (!provider) throw new Error(`Unknown payment provider: ${id}`);
  return provider;
}

export { actumProvider, plaidProvider, moovProvider };
