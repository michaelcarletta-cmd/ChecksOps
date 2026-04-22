import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { GuidedClaimHome } from "@/components/guided/GuidedClaimHome";
import { GuidedIntakeWizard } from "@/components/guided/GuidedIntakeWizard";
import { GuidedIssueWorkspace } from "@/components/guided/GuidedIssueWorkspace";
import { Loader2, LogOut, Plus, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

type GuidedView = "claims_list" | "intake" | "claim_home" | "issue_workspace";

export default function GuidedPortal() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [view, setView] = useState<GuidedView>("claims_list");
  const [claims, setClaims] = useState<any[]>([]);
  const [selectedClaimId, setSelectedClaimId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!authLoading && !user) {
      navigate("/guided/auth");
    }
  }, [user, authLoading, navigate]);

  useEffect(() => {
    if (user) loadClaims();
  }, [user]);

  const loadClaims = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("guided_claim_access")
      .select("claim_id, relationship, claims(*)")
      .eq("user_id", user!.id);

    setClaims(data?.map((d: any) => ({ ...d.claims, relationship: d.relationship })) || []);
    setLoading(false);
  };

  const handleClaimCreated = (claimId: string) => {
    setSelectedClaimId(claimId);
    loadClaims();
    setView("claim_home");
  };

  const handleSelectTask = (taskType: string) => {
    setSelectedTask(taskType);
    setView("issue_workspace");
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    navigate("/guided/auth");
  };

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b border-border bg-card sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {view !== "claims_list" && (
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (view === "issue_workspace") setView("claim_home");
                  else { setView("claims_list"); setSelectedClaimId(null); }
                }}
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
            )}
            <h1 className="text-lg font-semibold text-foreground">Darwin Guided Claims</h1>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground hidden sm:block">{user?.email}</span>
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-5xl mx-auto px-4 py-6">
        {view === "claims_list" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-foreground">Your Claims</h2>
                <p className="text-sm text-muted-foreground">Manage your self-guided insurance claims</p>
              </div>
              <Button onClick={() => setView("intake")}>
                <Plus className="h-4 w-4 mr-2" />
                New Claim
              </Button>
            </div>

            {claims.length === 0 ? (
              <div className="border border-dashed border-border rounded-lg p-12 text-center">
                <h3 className="text-lg font-medium text-foreground mb-2">No claims yet</h3>
                <p className="text-muted-foreground mb-4">Start your first guided claim to get Darwin's help with your insurance case.</p>
                <Button onClick={() => setView("intake")}>
                  <Plus className="h-4 w-4 mr-2" />
                  Start Your First Claim
                </Button>
              </div>
            ) : (
              <div className="grid gap-3">
                {claims.map((claim) => (
                  <button
                    key={claim.id}
                    className="w-full text-left border border-border rounded-lg p-4 bg-card hover:bg-accent/50 transition-colors"
                    onClick={() => { setSelectedClaimId(claim.id); setView("claim_home"); }}
                  >
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-medium text-foreground">{claim.claim_number || "No claim number"}</p>
                        <p className="text-sm text-muted-foreground">{claim.insurance_company || "Unknown carrier"} — {claim.policyholder_address || "No address"}</p>
                      </div>
                      <span className="text-xs px-2 py-1 rounded-full bg-primary/10 text-primary font-medium">
                        {claim.status || "New"}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {view === "intake" && (
          <GuidedIntakeWizard
            userId={user!.id}
            onComplete={handleClaimCreated}
            onCancel={() => setView("claims_list")}
          />
        )}

        {view === "claim_home" && selectedClaimId && (
          <GuidedClaimHome
            claimId={selectedClaimId}
            onSelectTask={handleSelectTask}
          />
        )}

        {view === "issue_workspace" && selectedClaimId && selectedTask && (
          <GuidedIssueWorkspace
            claimId={selectedClaimId}
            taskType={selectedTask}
            onBack={() => setView("claim_home")}
          />
        )}
      </main>
    </div>
  );
}
