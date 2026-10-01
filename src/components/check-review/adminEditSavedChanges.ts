/** Toast labels for admin-edit intake keys. Keep prefixes in sync with
 *  `CheckAdminEditDialog` change messages (`"<label> → …"`).
 */
export const ADMIN_EDIT_INTAKE_CHANGE_PREFIX: Record<string, string> = {
  amount: "amount →",
  routing_number: "routing # →",
  account_number: "account # →",
  mortgage_monitoring_type: "mortgage routing →",
  status: "status →",
  carrier_name: "carrier →",
  check_number: "check # →",
  payee_line: "payee →",
  issue_date: "date →",
};

const SKIPPED_FIELD_LABEL: Record<string, string> = {
  amount: "amount",
  routing_number: "routing number",
  account_number: "account number",
  mortgage_monitoring_type: "mortgage routing",
  status: "status",
};

export function omitSkippedAdminEditChanges(
  changes: string[],
  skipped: string[],
): string[] {
  const prefixes = skipped
    .map((key) => ADMIN_EDIT_INTAKE_CHANGE_PREFIX[key])
    .filter((prefix): prefix is string => Boolean(prefix));
  if (prefixes.length === 0) return [...changes];
  return changes.filter((message) => !prefixes.some((prefix) => message.startsWith(prefix)));
}

export function describeSkippedAdminEditFields(skipped: string[]): string {
  const labels = skipped
    .map((key) => SKIPPED_FIELD_LABEL[key] ?? key.replace(/_/g, " "))
    .filter(Boolean);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}`;
}

export function summarizeAdminEditSave(
  changes: string[],
  skippedIntakeFields: string[],
): {
  savedMessages: string[];
  warning: string | null;
  toast: { kind: "info" | "success"; message: string };
} {
  const savedMessages = omitSkippedAdminEditChanges(changes, skippedIntakeFields);
  const warning = skippedIntakeFields.length > 0
    ? `AWS staging cannot save ${describeSkippedAdminEditFields(skippedIntakeFields)}`
    : null;
  const toast = savedMessages.length === 0
    ? { kind: "info" as const, message: "No changes to save" }
    : { kind: "success" as const, message: `Saved: ${savedMessages.join(", ")}` };
  return { savedMessages, warning, toast };
}
