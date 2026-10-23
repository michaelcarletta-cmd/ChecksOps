import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Users, DollarSign, TrendingUp, Search, Download } from "lucide-react";
import { format } from "date-fns";

// The platform owner's view of Refer & Earn (SQL 111): one row per tenant with its code, the
// referrals it has made, the credit those earn ($5.00 each, at most $25.00 a month), any
// discount set by hand, and what is applied to its maintenance invoice.
type OverviewRow = {
  tenant_id: string;
  name: string | null;
  slug: string | null;
  referral_code: string | null;
  created_at: string | null;
  monthly_rate_cents: number;
  manual_discount_cents: number;
  active_referrals: number;
  earned_credit_cents: number;
  applied_discount_cents: number;
  referred_by: { tenant_id: string; name: string | null; code: string | null } | null;
};

type RpcError = { message?: string; code?: string } | null;
type RpcCall = (name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: RpcError }>;
// The SQL 111 function is AWS-only, so it is not in the generated Supabase function types.
const rpc = (name: string, args?: Record<string, unknown>) => (supabase.rpc as unknown as RpcCall).call(supabase, name, args);

const dollars = (cents: number | null | undefined) => ((Number(cents) || 0) / 100).toFixed(2);

export function AdminReferralDashboard() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");
  // Only shown to the platform owner (the function refuses anyone else too).
  const owner = isPlatformOwner(user?.email, user?.id);

  const { data: tenants = [], isLoading, error } = useQuery({
    queryKey: ["admin-referral-overview"],
    enabled: owner,
    refetchOnMount: "always",
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await rpc("aws_platform_owner_referral_overview");
      if (error) throw new Error(error.message || "Could not load referral overview");
      return (Array.isArray(data) ? data : []) as OverviewRow[];
    },
  });

  if (!owner) return null;

  // Every number comes from the same function the billing engine's rules are written against,
  // so the cards can never drift from the per-row values.
  const referredTenants = tenants.filter((t) => !!t.referred_by).length;
  const activeReferrals = tenants.reduce((s, t) => s + (Number(t.active_referrals) || 0), 0);
  const earnedCredits = tenants.reduce((s, t) => s + (Number(t.earned_credit_cents) || 0), 0);
  const appliedDiscounts = tenants.reduce((s, t) => s + (Number(t.applied_discount_cents) || 0), 0);

  const filteredTenants = tenants.filter((t) =>
    !search ||
    t.name?.toLowerCase().includes(search.toLowerCase()) ||
    t.referral_code?.toLowerCase().includes(search.toLowerCase())
  );

  const exportCSV = () => {
    const headers = ["Tenant", "Referral Code", "Active Referrals", "Referral Credit/mo", "Manual Discount/mo", "Applied Discount/mo", "Monthly Rate", "Referred By", "Joined"];
    const cell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const rows = filteredTenants.map((t) => [
      t.name,
      t.referral_code || "N/A",
      Number(t.active_referrals) || 0,
      `$${dollars(t.earned_credit_cents)}`,
      `$${dollars(t.manual_discount_cents)}`,
      `$${dollars(t.applied_discount_cents)}`,
      `$${dollars(t.monthly_rate_cents)}`,
      t.referred_by?.name || "None",
      t.created_at ? format(new Date(t.created_at), "yyyy-MM-dd") : "",
    ]);

    const csvContent = [headers, ...rows].map((row) => row.map(cell).join(",")).join("\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.setAttribute("href", url);
    link.setAttribute("download", `referrals-export-${format(new Date(), "yyyy-MM-dd")}.csv`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6 mt-8 border-t pt-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <TrendingUp className="h-6 w-6 text-primary" />
            Admin Referral Dashboard
          </h2>
          <p className="text-muted-foreground">Who referred whom, and the maintenance credits those referrals earn</p>
        </div>
        <Button variant="outline" onClick={exportCSV} className="gap-2">
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Active Referrals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeReferrals}</div>
            <div className="text-[10px] text-muted-foreground mt-1">
              {referredTenants} of {tenants.length} tenants joined with a code
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Referral Credits
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">${dollars(earnedCredits)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">Earned per month, $5 per referral, $25 cap per tenant</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Applied Discounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">${dollars(appliedDiscounts)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">Referral credits plus manual discounts, capped at each tenant&apos;s maintenance</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex items-center gap-4 bg-muted/30 p-4 rounded-lg">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by company or code..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="relative overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead className="text-xs text-muted-foreground bg-muted/50">
                <tr>
                  <th className="px-6 py-3">Tenant</th>
                  <th className="px-6 py-3 text-center">Referral Code</th>
                  <th className="px-6 py-3 text-center">Referrals</th>
                  <th className="px-6 py-3 text-center">Credit / mo</th>
                  <th className="px-6 py-3 text-center">Applied / mo</th>
                  <th className="px-6 py-3">Referred By</th>
                  <th className="px-6 py-3 text-right">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-muted-foreground">
                      Loading referral data...
                    </td>
                  </tr>
                ) : error ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-destructive">
                      Could not load referral data: {error instanceof Error ? error.message : String(error)}
                    </td>
                  </tr>
                ) : filteredTenants.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-muted-foreground">
                      No matching tenants found.
                    </td>
                  </tr>
                ) : (
                  filteredTenants.map((t) => (
                    <tr key={t.tenant_id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium text-foreground">{t.name}</div>
                        <div className="text-xs text-muted-foreground">{t.slug}</div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <code className="bg-primary/10 text-primary px-2 py-1 rounded text-xs font-bold">
                          {t.referral_code || "Pending"}
                        </code>
                      </td>
                      <td className="px-6 py-4 text-center font-bold">{Number(t.active_referrals) || 0}</td>
                      <td className="px-6 py-4 text-center font-bold text-green-600">${dollars(t.earned_credit_cents)}</td>
                      <td className="px-6 py-4 text-center">
                        <div className="font-bold">${dollars(t.applied_discount_cents)}</div>
                        {Number(t.manual_discount_cents) > 0 ? (
                          <div className="text-[10px] text-muted-foreground">incl. ${dollars(t.manual_discount_cents)} manual</div>
                        ) : null}
                      </td>
                      <td className="px-6 py-4">
                        {t.referred_by ? (
                          <div className="flex flex-col">
                            <span className="text-xs font-medium">{t.referred_by.name}</span>
                            <span className="text-[10px] text-muted-foreground">{t.referred_by.code}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground italic text-xs">Direct</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right text-xs text-muted-foreground">
                        {t.created_at ? format(new Date(t.created_at), "MMM d, yyyy") : ""}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
