import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useTenant } from "@/contexts/TenantContext";
import { canPlatformPreviewTenant } from "@/lib/platformAdminPreview";

function envLabel(environment?: string | null) {
  const value = String(environment || "").trim().toLowerCase();
  if (value === "production") return "Production";
  if (value === "sandbox") return "SANDBOX";
  return null;
}

/**
 * Makes the active tenant unmistakable during platform-admin preview and
 * restores Tenant Management without changing ownership or membership.
 */
export function TenantPreviewBanner() {
  const { tenant } = useTenant();
  const { user } = useAuth();
  if (!canPlatformPreviewTenant(user) || !tenant) return null;

  const environment = envLabel(tenant.moov_environment);
  const isTest = !!tenant.is_test_account;

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 md:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-400">
          Previewing
        </span>
        <span className="truncate text-sm font-semibold">{tenant.name}</span>
        {isTest && (
          <Badge variant="outline" className="h-5 border-amber-500/50 px-1.5 text-[10px] text-amber-700 dark:text-amber-400">
            TEST
          </Badge>
        )}
        {environment && (
          <Badge
            variant="outline"
            className={
              environment === "SANDBOX"
                ? "h-5 border-sky-500/50 px-1.5 text-[10px] text-sky-600 dark:text-sky-400"
                : "h-5 border-emerald-500/50 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400"
            }
          >
            {environment}
          </Badge>
        )}
      </div>
      <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" asChild>
        <Link to="/admin/tenants">
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          Return to Tenant Management
        </Link>
      </Button>
    </div>
  );
}
