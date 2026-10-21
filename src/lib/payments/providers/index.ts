import type { PaymentProvider, PaymentProviderId } from "../types";
import { moovProvider } from "./moovProvider";

const REGISTRY: Record<PaymentProviderId, PaymentProvider> = {
  moov: moovProvider,
};

export function getProvider(id: PaymentProviderId): PaymentProvider {
  const provider = REGISTRY[id];
  if (!provider) throw new Error(`Unknown payment provider: ${id}`);
  return provider;
}

export { moovProvider };
