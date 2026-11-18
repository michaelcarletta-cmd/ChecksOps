// Constant-time comparison for bearer tokens and API keys. Both values are
// hashed first, so neither the length nor the position of the first differing
// character is observable through response timing.

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function timingSafeEqualStrings(
  left: string | null | undefined,
  right: string | null | undefined,
): Promise<boolean> {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (!left || !right) return false;
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}
