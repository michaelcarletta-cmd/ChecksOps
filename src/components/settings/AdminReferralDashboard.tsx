import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Users, DollarSign, TrendingUp, Search, Download, Star } from "lucide-react";
import { format } from "date-fns";

export function AdminReferralDashboard() {
  const { user } = useAuth();
  const [search, setSearch] = useState("");

  // Only show to admin
  if (!isPlatformOwner(user?.email)) return null;

  const { data: tenants = [], isLoading } = useQuery({
    queryKey: ["admin-referral-tenants"],
    refetchOnMount: "always",
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("tenants")
        .select(`
          id, name, slug, referral_code, referral_discount_cents,
          monthly_rate_cents, is_founding_partner, created_at,
          referred_by:referred_by_tenant_id (name, referral_code)
        `)
        .eq("is_system_tenant", false)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const { data: referralEvents = [] } = useQuery({
    queryKey: ["admin-referral-events"],
    refetchOnMount: "always",
    refetchInterval: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("referral_events")
        .select(`
          id, discount_applied_cents, status, created_at,
          referrer:referrer_tenant_id (name, referral_code),
          referred:referred_tenant_id (name)
        `)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  // Source of truth = tenants table (same field powering the "Active Discount"
  // column below), so top-card metrics can never drift from the per-row values.
  // referral_events is a separate log and may be missing rows if an insert
  // failed while the tenant record was still updated.
  const totalReferrals = tenants.filter((t: any) => t.referred_by).length;
  const totalDiscountsGiven =
    tenants.reduce((s: number, t: any) => s + (t.referral_discount_cents || 0), 0) / 100;
  const eventCount = referralEvents.filter((e: any) => e.status === "active").length;
  const foundingPartners = tenants.filter((t: any) => t.is_founding_partner).length;

  const filteredTenants = tenants.filter((t: any) =>
    !search ||
    t.name?.toLowerCase().includes(search.toLowerCase()) ||
    t.referral_code?.toLowerCase().includes(search.toLowerCase())
  );

  const exportCSV = () => {
    const headers = ["Tenant", "Referral Code", "Discount/mo", "Effective Rate", "Founding Partner", "Referred By", "Joined"];
    const rows = filteredTenants.map((t: any) => [
      t.name,
      t.referral_code || "N/A",
      `$${(t.referral_discount_cents || 0) / 100}`,
      `$${((t.monthly_rate_cents || 0) - (t.referral_discount_cents || 0)) / 100}`,
      t.is_founding_partner ? "Yes" : "No",
      t.referred_by?.name || "None",
      format(new Date(t.created_at), "yyyy-MM-dd")
    ]);

    const csvContent = [headers, ...rows].map(e => e.join(",")).join("\n");
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
          <p className="text-muted-foreground">Global overview of referral performance and discounts</p>
        </div>
        <Button variant="outline" onClick={exportCSV} className="gap-2">
          <Download className="h-4 w-4" />
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" />
              Total Referrals
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalReferrals}</div>
            <div className="text-[10px] text-muted-foreground mt-1">
              {eventCount} logged in events
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Monthly Discounts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">${totalDiscountsGiven.toFixed(2)}</div>
            <div className="text-[10px] text-muted-foreground mt-1">Sum of active tenant credits</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <Star className="h-4 w-4 text-yellow-500" />
              Founding Partners
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{foundingPartners}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Conversion Rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {tenants.length > 0 ? ((totalReferrals / tenants.length) * 100).toFixed(1) : 0}%
            </div>
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
              <thead className="text-xs text-muted-foreground uppercase bg-muted/50">
                <tr>
                  <th className="px-6 py-3">Tenant</th>
                  <th className="px-6 py-3 text-center">Referral Code</th>
                  <th className="px-6 py-3 text-center">Active Discount</th>
                  <th className="px-6 py-3 text-center">Status</th>
                  <th className="px-6 py-3">Referred By</th>
                  <th className="px-6 py-3 text-right">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                      Loading referral data...
                    </td>
                  </tr>
                ) : filteredTenants.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-muted-foreground">
                      No matching tenants found.
                    </td>
                  </tr>
                ) : (
                  filteredTenants.map((t: any) => (
                    <tr key={t.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4">
                        <div className="font-medium text-foreground">{t.name}</div>
                        <div className="text-xs text-muted-foreground">{t.slug}</div>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <code className="bg-primary/10 text-primary px-2 py-1 rounded text-xs font-bold">
                          {t.referral_code || "PENDING"}
                        </code>
                      </td>
                      <td className="px-6 py-4 text-center font-bold text-green-600">
                        ${(t.referral_discount_cents || 0) / 100}/mo
                      </td>
                      <td className="px-6 py-4 text-center">
                        {t.is_founding_partner && (
                          <Badge className="bg-yellow-500/10 text-yellow-600 border-yellow-200 hover:bg-yellow-500/20">
                            Founding Partner
                          </Badge>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        {t.referred_by ? (
                          <div className="flex flex-col">
                            <span className="text-xs font-medium">{t.referred_by.name}</span>
                            <span className="text-[10px] text-muted-foreground">{t.referred_by.referral_code}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground italic text-xs">Direct</span>
                        )}
                      </td>
                      <td className="px-6 py-4 text-right text-xs text-muted-foreground">
                        {format(new Date(t.created_at), "MMM d, yyyy")}
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
