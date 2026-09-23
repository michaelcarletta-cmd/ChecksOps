import { useState } from "react";
import { supabase } from "@/integrations/aws/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MessageSquarePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface Props {
  claimId: string | null | undefined;
  tenantId: string | null | undefined;
  checkId?: string | null;
  label?: string;
  compact?: boolean;
}

/**
 * Lets tenant staff post an update note to the homeowner's timeline
 * for ANY claim (mortgage or not), as long as a check has been uploaded.
 */
export function PostHomeownerUpdateCard({ claimId, tenantId, checkId, label, compact }: Props) {
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const post = async () => {
    if (!note.trim()) {
      toast.error("Add a note first");
      return;
    }
    setSaving(true);

    let resolvedClaimId = claimId ?? null;
    let resolvedTenantId = tenantId ?? null;

    // Fallback: derive from the check if props are missing
    if ((!resolvedClaimId || !resolvedTenantId) && checkId) {
      const { data: chk } = await supabase
        .from("claim_checks")
        .select("claim_id, tenant_id")
        .eq("id", checkId)
        .maybeSingle();
      resolvedClaimId = resolvedClaimId ?? (chk as any)?.claim_id ?? null;
      resolvedTenantId = resolvedTenantId ?? (chk as any)?.tenant_id ?? null;
    }

    if (!resolvedTenantId) {
      const { data: userRes } = await supabase.auth.getUser();
      const uid = userRes.user?.id;
      if (uid) {
        const { data: tu } = await supabase
          .from("tenant_users")
          .select("tenant_id")
          .eq("user_id", uid)
          .limit(1)
          .maybeSingle();
        resolvedTenantId = (tu as any)?.tenant_id ?? null;
      }
    }

    if (!resolvedTenantId || !resolvedClaimId) {
      setSaving(false);
      toast.error("Cannot post: this check isn't linked to a claim yet");
      return;
    }

    const { data: userRes } = await supabase.auth.getUser();
    const { error } = await supabase.from("homeowner_ledger_events").insert({
      tenant_id: resolvedTenantId,
      claim_id: resolvedClaimId,
      event_type: "tenant_update",
      occurred_at: new Date().toISOString(),
      actor_label: "Update",
      payload_json: { note: note.trim() },
      created_by: userRes.user?.id ?? null,
    } as any);
    setSaving(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setNote("");
    toast.success("Posted to homeowner timeline");
  };


  return (
    <Card>
      <CardHeader className={compact ? "pb-2" : undefined}>
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquarePlus className="h-4 w-4 text-primary" />
          {label || "Post update to homeowner timeline"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Share a status update the homeowner should see (e.g. 'Endorsements requested from carrier — expect 2-3 business days')."
          rows={3}
        />
        <div className="flex justify-end">
          <Button size="sm" onClick={post} disabled={saving || !note.trim()}>
            {saving ? <Loader2 className="h-3 w-3 mr-1 animate-spin" /> : null}
            Post update
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
