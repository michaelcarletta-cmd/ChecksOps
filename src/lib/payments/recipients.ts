import type { BusinessRecipient, ExternalRecipient, Recipient } from "./types";

/**
 * Generic recipient models.
 *
 * Two shapes only: a business (tenant, contractor, vendor) and an external
 * party (homeowner, one-time payee). Payment flows are not implemented here —
 * this is the shared vocabulary the provider adapters will consume.
 */

export function businessRecipient(
  input: Omit<BusinessRecipient, "kind">,
): BusinessRecipient {
  return { kind: "business", ...input };
}

export function externalRecipient(
  input: Omit<ExternalRecipient, "kind">,
): ExternalRecipient {
  return { kind: "external", ...input };
}

export function isBusinessRecipient(r: Recipient): r is BusinessRecipient {
  return r.kind === "business";
}

export function isExternalRecipient(r: Recipient): r is ExternalRecipient {
  return r.kind === "external";
}

export function recipientLabel(r: Recipient): string {
  if (isBusinessRecipient(r)) {
    switch (r.role) {
      case "tenant":
        return `${r.name} (organization)`;
      case "contractor":
        return `${r.name} (contractor)`;
      case "vendor":
        return `${r.name} (vendor)`;
      default:
        return r.name;
    }
  }
  return r.relationship === "homeowner" ? `${r.name} (homeowner)` : r.name;
}

/** Maps an existing stakeholder row onto the generic recipient model. */
export function recipientFromStakeholder(row: {
  id: string;
  name?: string | null;
  payee_name?: string | null;
  email?: string | null;
  phone?: string | null;
  payee_type?: string | null;
  tenant_id?: string | null;
  stakeholder_account_id?: string | null;
}): Recipient {
  const name = row.name ?? row.payee_name ?? "Recipient";
  const type = (row.payee_type ?? "").toLowerCase();

  if (type === "contractor" || type === "vendor" || row.tenant_id) {
    return businessRecipient({
      id: row.id,
      tenantId: row.tenant_id ?? null,
      name,
      email: row.email ?? null,
      phone: row.phone ?? null,
      role: type === "vendor" ? "vendor" : row.tenant_id ? "tenant" : "contractor",
      bankAccountId: row.stakeholder_account_id ?? null,
    });
  }

  return externalRecipient({
    id: row.id,
    name,
    email: row.email ?? null,
    phone: row.phone ?? null,
    relationship: type === "insured" || type === "homeowner" ? "homeowner" : "one_time",
    bankAccountId: row.stakeholder_account_id ?? null,
  });
}
