import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Send, Link as LinkIcon, Copy, Eye, RefreshCcw, Tag } from "lucide-react";
import { toast } from "sonner";

type Token = {
  id: string;
  token: string;
  homeowner_email: string | null;
  homeowner_name: string | null;
  last_viewed_at: string | null;
  view_count: number | null;
  revoked_at: string | null;
  created_at: string;
  partner_code: string | null;
  sent_by_user_id: string | null;
};

export function SendHomeownerUploadLink({ tenantId }: { tenantId?: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [tokens, setTokens] = useState<Token[]>([]);
  const [loading, setLoading] = useState(true);
  const [partnerCodes, setPartnerCodes] = useState<string[]>([]);
  const [partnerCode, setPartnerCode] = useState<string>("");

  const load = async () => {
    setLoading(true);
    let q = supabase
      .from("homeowner_ledger_tokens")
      .select("id, token, homeowner_email, homeowner_name, last_viewed_at, view_count, revoked_at, created_at, partner_code, sent_by_user_id")
      .is("claim_id", null)
      .order("created_at", { ascending: false })
      .limit(20);
    if (tenantId) q = q.eq("tenant_id", tenantId);
    const { data } = await q;
    setTokens((data ?? []) as Token[]);
    setLoading(false);
  };

  const loadCodes = async () => {
    const { data } = await supabase.rpc("get_my_tenant_partner_codes");
    const codes = ((data ?? []) as any[])
      .filter((r) => !tenantId || r.tenant_id === tenantId)
      .map((r) => r.code as string);
    setPartnerCodes(codes);
    if (codes.length && !partnerCode) setPartnerCode(codes[0]);
  };

  useEffect(() => { load(); loadCodes(); /* eslint-disable-next-line */ }, [tenantId]);

  const send = async () => {
    if (!email && !phone) { toast.error("Add an email or phone"); return; }
    if (partnerCodes.length && !partnerCode) { toast.error("Pick a partner code"); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("homeowner-ledger-send", {
        body: {
          claim_id: null,
          tenant_id: tenantId,
          homeowner_email: email || null,
          homeowner_phone: phone || null,
          homeowner_name: name || null,
          partner_code: partnerCode || null,
          rotate: false,
          origin: window.location.origin,
        },
      });
      if (error) throw new Error(error.message);
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`Upload link sent${partnerCode ? ` (tagged ${partnerCode})` : ""}`);
      setName(""); setEmail(""); setPhone("");
      await load();
    } catch (e: any) {
      toast.error(e.message || "Send failed");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = (t: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/start-claim/${t}`);
    toast.success("Link copied");
  };

  const revoke = async (id: string) => {
    await supabase.from("homeowner_ledger_tokens")
      .update({ revoked_at: new Date().toISOString() }).eq("id", id);
    toast.success("Link revoked");
    load();
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <LinkIcon className="h-4 w-4" /> Send Homeowner Upload Link
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The link is tagged with your partner code. When the homeowner uploads, the check lands in review assigned to you.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label className="text-xs flex items-center gap-1"><Tag className="h-3 w-3" /> Partner code</Label>
            {partnerCodes.length > 0 ? (
              <Select value={partnerCode} onValueChange={setPartnerCode}>
                <SelectTrigger className="h-9"><SelectValue placeholder="Select code" /></SelectTrigger>
                <SelectContent>
                  {partnerCodes.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Input value={partnerCode} onChange={(e) => setPartnerCode(e.target.value.toUpperCase())} placeholder="e.g. FRDM01" />
            )}
          </div>
          <div className="space-y-1"><Label className="text-xs">Homeowner name</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1"><Label className="text-xs">Email</Label><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" /></div>
          <div className="space-y-1"><Label className="text-xs">Phone</Label><Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(optional)" /></div>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={send} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Send className="h-4 w-4 mr-2" />}
            Send upload link
          </Button>
          {partnerCode && (
            <Badge variant="outline" className="text-[10px]">
              <Tag className="h-3 w-3 mr-1" /> Active: {partnerCode}
            </Badge>
          )}
        </div>

        <div className="border-t border-border pt-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">Recent pre-claim links</div>
          {loading ? (
            <div className="flex justify-center py-3"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
          ) : tokens.length === 0 ? (
            <div className="text-xs text-muted-foreground py-2">No pre-claim links yet.</div>
          ) : (
            <ul className="space-y-2">
              {tokens.map((t) => (
                <li key={t.id} className="text-xs border border-border rounded p-2 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <div className="truncate">
                      <span className="font-medium">{t.homeowner_name || t.homeowner_email || "Homeowner"}</span>
                      {t.homeowner_email && <span className="text-muted-foreground"> • {t.homeowner_email}</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      {t.partner_code && <Badge variant="outline" className="text-[10px]"><Tag className="h-2.5 w-2.5 mr-1" />{t.partner_code}</Badge>}
                      {t.revoked_at
                        ? <Badge variant="destructive" className="text-[10px]">Revoked</Badge>
                        : <Badge variant="secondary" className="text-[10px]">Active</Badge>}
                    </div>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {t.last_viewed_at ? `Viewed ${new Date(t.last_viewed_at).toLocaleString()}` : "Not viewed yet"}
                    {t.view_count ? ` • ${t.view_count} views` : ""}
                  </div>
                  {!t.revoked_at && (
                    <div className="flex gap-2 pt-1">
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => copyLink(t.token)}>
                        <Copy className="h-3 w-3 mr-1" /> Copy
                      </Button>
                      <Button size="sm" variant="outline" className="h-7 text-[11px]" asChild>
                        <a href={`/start-claim/${t.token}`} target="_blank" rel="noreferrer"><Eye className="h-3 w-3 mr-1" /> Preview</a>
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-[11px] text-destructive" onClick={() => revoke(t.id)}>
                        <RefreshCcw className="h-3 w-3 mr-1" /> Revoke
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
