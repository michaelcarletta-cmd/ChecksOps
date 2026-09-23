import { supabase } from "@/integrations/aws/client";
import type { NavigateFunction } from "react-router-dom";

/**
 * Send the current user back to their ChecksOps home (their tenant's
 * /{slug}/checks page). Falls back to /login if the user is signed out
 * or has no accessible tenant.
 */
export async function goToChecksOpsHome(navigate: NavigateFunction): Promise<void> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    navigate("/login");
    return;
  }

  // Prefer the user's tenant membership → tenant slug.
  const { data: memberships } = await supabase
    .from("tenant_users")
    .select("tenant_id")
    .eq("user_id", user.id)
    .limit(1);

  const tenantId = memberships?.[0]?.tenant_id;
  if (tenantId) {
    const { data: tenant } = await supabase
      .from("tenants")
      .select("slug")
      .eq("id", tenantId)
      .maybeSingle();
    if (tenant?.slug) {
      navigate(`/${tenant.slug}/checks`);
      return;
    }
  }

  // Last resort — the ChecksOps landing page.
  navigate("/");
}
