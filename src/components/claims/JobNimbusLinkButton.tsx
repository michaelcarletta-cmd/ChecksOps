import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Link2, Search, Check, Loader2, Unlink } from "lucide-react";
import { toast } from "sonner";

interface JobNimbusCandidate {
  jnid: string;
  name: string;
  address: string;
  status: string;
  claimNumber: string;
  confidence: number;
}

interface JobNimbusLinkButtonProps {
  claimId: string;
  currentJobId: string | null;
  onLinked?: (jobId: string | null) => void;
}

export function JobNimbusLinkButton({ claimId, currentJobId, onLinked }: JobNimbusLinkButtonProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [candidates, setCandidates] = useState<JobNimbusCandidate[]>([]);
  const [claimInfo, setClaimInfo] = useState<any>(null);
  const [linking, setLinking] = useState<string | null>(null);

  const searchMatches = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke('jobnimbus-search-match', {
        body: { claimId },
      });

      if (error) throw error;
      setCandidates(data.candidates || []);
      setClaimInfo(data.claim);
    } catch (err: any) {
      toast.error("Failed to search JobNimbus: " + (err.message || "Unknown error"));
    } finally {
      setLoading(false);
    }
  };

  const linkToJob = async (jnid: string) => {
    setLinking(jnid);
    try {
      const { error } = await supabase
        .from('claims')
        .update({ jobnimbus_job_id: jnid })
        .eq('id', claimId);

      if (error) throw error;
      toast.success("Claim linked to JobNimbus job");
      onLinked?.(jnid);
      setOpen(false);
    } catch (err: any) {
      toast.error("Failed to link: " + err.message);
    } finally {
      setLinking(null);
    }
  };

  const unlinkJob = async () => {
    try {
      const { error } = await supabase
        .from('claims')
        .update({ jobnimbus_job_id: null })
        .eq('id', claimId);

      if (error) throw error;
      toast.success("JobNimbus link removed");
      onLinked?.(null);
    } catch (err: any) {
      toast.error("Failed to unlink: " + err.message);
    }
  };

  const createNewJob = async () => {
    setLinking('new');
    try {
      // Queue a sync which will create a new job
      const { error } = await supabase
        .from('jobnimbus_sync_queue' as any)
        .insert({ claim_id: claimId, sync_type: 'claim', status: 'pending', contractor_id: null });

      if (error) throw error;
      toast.success("Claim queued for JobNimbus sync — a new job will be created");
      setOpen(false);
    } catch (err: any) {
      toast.error("Failed to queue sync: " + err.message);
    } finally {
      setLinking(null);
    }
  };

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 60) return <Badge className="bg-green-500/10 text-green-600 border-green-200">Strong Match</Badge>;
    if (confidence >= 30) return <Badge className="bg-yellow-500/10 text-yellow-600 border-yellow-200">Possible Match</Badge>;
    return <Badge variant="outline" className="text-muted-foreground">Low Match</Badge>;
  };

  return (
    <div className="flex items-center gap-2">
      {currentJobId ? (
        <>
          <Badge variant="outline" className="text-green-600 border-green-200 gap-1">
            <Link2 className="h-3 w-3" />
            Linked to JN
          </Badge>
          <Button variant="ghost" size="sm" onClick={unlinkJob} className="h-7 px-2 text-xs text-muted-foreground">
            <Unlink className="h-3 w-3 mr-1" />
            Unlink
          </Button>
        </>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => { setOpen(true); searchMatches(); }}>
              <Link2 className="h-4 w-4" />
              Link to JobNimbus
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Link to JobNimbus</DialogTitle>
            </DialogHeader>

            {claimInfo && (
              <div className="bg-muted/50 rounded-md p-3 text-sm space-y-1">
                <p className="font-medium">{claimInfo.name}</p>
                <p className="text-muted-foreground">{claimInfo.address}</p>
                <p className="text-muted-foreground">Claim #: {claimInfo.claimNumber}</p>
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center py-8 gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Searching JobNimbus...
              </div>
            ) : candidates.length > 0 ? (
              <div className="space-y-2">
                <p className="text-sm text-muted-foreground">Select a matching JobNimbus job:</p>
                {candidates.map((c) => (
                  <div
                    key={c.jnid}
                    className="flex items-center justify-between p-3 border rounded-md hover:bg-muted/50 transition-colors"
                  >
                    <div className="space-y-0.5 flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm truncate">{c.name}</p>
                        {getConfidenceBadge(c.confidence)}
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{c.address}</p>
                      <div className="flex gap-3 text-xs text-muted-foreground">
                        {c.claimNumber && <span>#{c.claimNumber}</span>}
                        <span>{c.status}</span>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="ml-2 shrink-0"
                      disabled={linking === c.jnid}
                      onClick={() => linkToJob(c.jnid)}
                    >
                      {linking === c.jnid ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No matching jobs found in JobNimbus.
              </p>
            )}

            <div className="flex items-center justify-between pt-2 border-t">
              <Button variant="ghost" size="sm" onClick={searchMatches} disabled={loading}>
                <Search className="h-3 w-3 mr-1" />
                Re-search
              </Button>
              <Button
                size="sm"
                onClick={createNewJob}
                disabled={linking === 'new'}
              >
                {linking === 'new' ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                Create New JN Job
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
