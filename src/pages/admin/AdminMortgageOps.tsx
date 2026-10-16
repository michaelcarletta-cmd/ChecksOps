import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { isPlatformOwner } from "@/lib/masterMerchant";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { ArrowLeft, Briefcase, Home, Loader2 } from "lucide-react";
import { goToChecksOpsHome } from "@/lib/goToChecksOpsHome";
import { MortgageAgentsPanel } from "@/components/admin/MortgageAgentsPanel";

export default function AdminMortgageOps() {
  const navigate = useNavigate();
  const [authorized, setAuthorized] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !isPlatformOwner(user.email, user.id)) {
        toast.error("Not authorized");
        navigate("/");
        return;
      }
      setAuthorized(true);
      setChecking(false);
    })();
  }, [navigate]);

  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }
  if (!authorized) return null;

  return (
    <div className="min-h-screen bg-background">
      <div className="border-b border-border bg-card">
        <div className="max-w-7xl mx-auto px-6 py-5 flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => navigate("/admin/tenants?tab=mortgage-agents")}>
            <ArrowLeft className="w-4 h-4 mr-1" /> Tenant Management
          </Button>
          <Button variant="ghost" size="sm" onClick={() => goToChecksOpsHome(navigate)}>
            <Home className="w-4 h-4 mr-1" /> Home
          </Button>
          <Briefcase className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-xl font-semibold">Mortgage Agents</h1>
            <p className="text-xs text-muted-foreground">Alias of Tenant Management → Mortgage Agents</p>
          </div>
        </div>
      </div>
      <div className="max-w-[1400px] mx-auto px-6 py-8">
        <MortgageAgentsPanel />
      </div>
    </div>
  );
}
