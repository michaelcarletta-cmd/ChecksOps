import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Archive, ChevronDown, ChevronRight, Copy, Trash2, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// Define the structure for asset types and their labels
interface GeneratedAsset {
  id: string;
  asset_type: string;
  title: string;
  content_md: string | null;
  redacted: boolean;
  created_at: string;
  metadata_json: Record<string, any> | null;
}

interface DarwinGeneratedAssetsProps {
  claimId: string;
}

const assetTypeLabels: Record<string, { label: string; color: string }> = {
  claim_analysis: { label: "Analysis", color: "bg-primary/10 text-primary" },
  operating_manual: { label: "Manual", color: "bg-blue-500/10 text-blue-600 dark:text-blue-400" },
  case_study: { label: "Case Study", color: "bg-amber-500/10 text-amber-600 dark:text-amber-400" },
  marketing_assets: { label: "Marketing", color: "bg-purple-500/10 text-purple-600 dark:text-purple-400" },
};

export const DarwinGeneratedAssets = ({ claimId }: DarwinGeneratedAssetsProps) => {
  const [assets, setAssets] = useState<GeneratedAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const fetch = async () => {
      setLoading(true);
      const { data } = await supabase
        .from("generated_assets")
        .select("id, asset_type, title, content_md, redacted, created_at, metadata_json")
        .eq("claim_id", claimId)
        .order("created_at", { ascending: false })
        .limit(20);
      setAssets((data as GeneratedAsset[]) ?? []);
      setLoading(false);
    };
    fetch();

    const channel = supabase
      .channel(`generated_assets_${claimId}`)
      .on("postgres_changes", {
        event: "INSERT",
        schema: "public",
        table: "generated_assets",
        filter: `claim_id=eq.${claimId}`,
      }, (payload) => {
        setAssets((prev) => [payload.new as GeneratedAsset, ...prev].slice(0, 20));
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [claimId]);

  const handleCopy = async (content: string) => {
    await navigator.clipboard.writeText(content);
    toast.success("Copied to clipboard");
  };

  const handleDelete = async (id: string) => {
    const { error } = await supabase.from("generated_assets").delete().eq("id", id);
    if (error) {
      toast.error("Failed to delete");
      return;
    }
    setAssets((prev) => prev.filter((a) => a.id !== id));
    toast.success("Asset deleted");
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center p-6">
          <Loader2 className="h-4 w-4 animate-spin mr-2 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading assets…</span>
        </CardContent>
      </Card>
    );
  }

  if (assets.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Archive className="h-4 w-4 text-muted-foreground" />
            Generated Assets
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            No assets yet. Use the Darwin Command Bar to generate analyses, case studies, or marketing assets.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Archive className="h-4 w-4 text-muted-foreground" />
          Generated Assets
          <Badge variant="secondary" className="text-[10px] ml-auto">{assets.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {assets.map((asset) => {
          const typeInfo = assetTypeLabels[asset.asset_type] ?? { label: asset.asset_type, color: "bg-muted text-muted-foreground" };
          const isExpanded = expandedId === asset.id;

          return (
            <Collapsible key={asset.id} open={isExpanded} onOpenChange={() => setExpandedId(isExpanded ? null : asset.id)}>
              <CollapsibleTrigger asChild>
                <button className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted/50 text-left text-xs transition-colors">
                  {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                  <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="font-medium truncate flex-1">{asset.title}</span>
                  <Badge className={cn("text-[9px] px-1 py-0", typeInfo.color)} variant="outline">{typeInfo.label}</Badge>
                  {asset.redacted && <Badge variant="outline" className="text-[9px] px-1 py-0 border-amber-500/50 text-amber-600">Redacted</Badge>}
                  <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                    {new Date(asset.created_at).toLocaleDateString()}
                  </span>
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-7 mt-1 mb-2 space-y-2">
                  <div className="max-h-64 overflow-y-auto rounded border border-border/50 p-2">
                    <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-sans">
                      {asset.content_md?.slice(0, 5000) ?? "No content"}
                      {(asset.content_md?.length ?? 0) > 5000 && "\n\n… (truncated)"}
                    </pre>
                  </div>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] gap-1" onClick={() => handleCopy(asset.content_md ?? "")}>
                      <Copy className="h-3 w-3" /> Copy
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] gap-1 text-destructive hover:text-destructive" onClick={() => handleDelete(asset.id)}>
                      <Trash2 className="h-3 w-3" /> Delete
                    </Button>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </CardContent>
    </Card>
  );
};
