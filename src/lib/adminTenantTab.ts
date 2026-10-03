export const ADMIN_TENANT_TAB_VALUES = [
  "tenants",
  "mortgage-agents",
  "platform-finance",
  "checkalt",
  "referrals",
  "announcements",
] as const;

export type AdminTenantTab = (typeof ADMIN_TENANT_TAB_VALUES)[number];

export function resolveAdminTenantTab(raw: string | null | undefined): AdminTenantTab {
  const value = String(raw || "").trim();
  return (ADMIN_TENANT_TAB_VALUES as readonly string[]).includes(value)
    ? (value as AdminTenantTab)
    : "tenants";
}
