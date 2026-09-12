/**
 * Safe TanStack Query mutation variables for recipient tax profiles.
 *
 * Replacement TIN must never appear in mutation variables or the query cache.
 * Authorized entry still requires brief in-memory presence plus HTTPS
 * transmission to `tenant-tax-profiles`; this is not zero browser presence.
 */

export type TaxProfileMutationVariables = {
  recipient_key: string;
  recipient_name: string;
  address_street: string;
  address_city: string;
  address_state: string;
  address_zip: string;
  account_number: string;
  notes: string;
};

const SAFE_KEYS: Array<keyof TaxProfileMutationVariables> = [
  "recipient_key",
  "recipient_name",
  "address_street",
  "address_city",
  "address_state",
  "address_zip",
  "account_number",
  "notes",
];

export function taxProfileMutationVariables(
  form: TaxProfileMutationVariables,
): TaxProfileMutationVariables {
  const out = {} as TaxProfileMutationVariables;
  for (const key of SAFE_KEYS) {
    out[key] = String(form[key] ?? "");
  }
  return out;
}

export function taxProfileMutationHasTin(variables: unknown): boolean {
  if (!variables || typeof variables !== "object") return false;
  const keys = Object.keys(variables as Record<string, unknown>).map((k) => k.toLowerCase());
  return keys.includes("tin")
    || keys.includes("tin_replace")
    || keys.includes("tin_encrypted")
    || keys.includes("ssn")
    || keys.includes("ein");
}
