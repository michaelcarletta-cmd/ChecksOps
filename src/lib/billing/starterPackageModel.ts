/**
 * The optional Starter Package (SQL 150, owner 2026-11-10): one-time $3,500 covering setup,
 * 12 months of Monthly Maintenance and 250 included checks. Included checks do not expire; each
 * check processed and each failed deposit uses one; other fees are still charged. Only the
 * ChecksOps platform owner turns it on (Tenant Management -> Billing), with its dates.
 */
export const STARTER_PACKAGE_DEFAULT_CHECKS = 250;

export interface StarterPackage {
  enabled: boolean;
  starts_on: string | null;
  maintenance_ends_on: string | null;
  included_checks: number;
  checks_used: number;
  checks_left: number;
}

export interface StarterPackageInput {
  enabled: boolean;
  starts_on: string | null;
  maintenance_ends_on: string | null;
  included_checks: number | null;
}

/** The last day of 12 months of maintenance from a start date (YYYY-MM-DD), as SQL 150 defaults it. */
export function defaultMaintenanceEndsOn(startsOn: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(startsOn || ""));
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]) + 1, Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export type StarterPackageRow = {
  starter_package_enabled?: boolean | null;
  starter_package_starts_on?: string | null;
  starter_package_maintenance_ends_on?: string | null;
  starter_package_included_checks?: number | null;
};

/** Builds the package from the tenant's columns and the included checks used; null before SQL 150. */
export function starterPackageFromRow(row: StarterPackageRow | null | undefined, checksUsed: number): StarterPackage | null {
  if (!row || !("starter_package_enabled" in row)) return null;
  const included = Math.max(0, Number(row.starter_package_included_checks ?? STARTER_PACKAGE_DEFAULT_CHECKS));
  const used = Math.max(0, Number(checksUsed || 0));
  return {
    enabled: row.starter_package_enabled === true,
    starts_on: row.starter_package_starts_on ?? null,
    maintenance_ends_on: row.starter_package_maintenance_ends_on ?? null,
    included_checks: included,
    checks_used: used,
    checks_left: Math.max(0, included - used),
  };
}

/** "Included checks left: 187 of 250 · maintenance included through Oct 31, 2027" pieces. */
export function starterPackageSummary(pkg: StarterPackage | null | undefined, today = new Date()): string | null {
  if (!pkg?.enabled) return null;
  const fmt = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  const parts = [`${pkg.checks_left} of ${pkg.included_checks} included checks left`];
  const iso = today.toISOString().slice(0, 10);
  if (pkg.starts_on && iso < pkg.starts_on) parts.push(`starts ${fmt(pkg.starts_on)}`);
  if (pkg.maintenance_ends_on) {
    parts.push(iso <= pkg.maintenance_ends_on
      ? `maintenance included through ${fmt(pkg.maintenance_ends_on)}`
      : `maintenance included until ${fmt(pkg.maintenance_ends_on)}`);
  }
  return parts.join(" · ");
}
