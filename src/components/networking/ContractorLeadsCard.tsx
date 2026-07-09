import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Mail, Phone, MapPin, MessageSquare, Loader2, Inbox } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";

type Lead = {
  id: string;
  homeowner_name: string;
  homeowner_email: string;
  homeowner_phone: string | null;
  property_zip: string | null;
  loss_type: string | null;
  message: string | null;
  status: string;
  created_at: string;
  contacted_at: string | null;
};

const STATUS_OPTIONS = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
  { value: "spam", label: "Spam" },
];

const statusColor: Record<string, string> = {
  new: "bg-primary text-primary-foreground",
  contacted: "bg-blue-500/20 text-blue-300",
  quoted: "bg-purple-500/20 text-purple-300",
  won: "bg-green-500/20 text-green-300",
  lost: "bg-muted text-muted-foreground",
  spam: "bg-destructive/20 text-destructive",
};

export function ContractorLeadsCard() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<string>("all");

  const { data: leads, isLoading } = useQuery({
    queryKey: ["homeowner-intro-requests"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("homeowner_intro_requests")
        .select(
          "id, homeowner_name, homeowner_email, homeowner_phone, property_zip, loss_type, message, status, created_at, contacted_at",
        )
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Lead[];
    },
  });

  const updateStatus = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: string }) => {
      const patch: Record<string, unknown> = { status };
      if (status === "contacted") patch.contacted_at = new Date().toISOString();
      const { error } = await supabase.from("homeowner_intro_requests").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["homeowner-intro-requests"] });
      toast.success("Updated");
    },
    onError: (e: any) => toast.error(e.message ?? "Update failed"),
  });

  const filtered = (leads ?? []).filter((l) => filter === "all" || l.status === filter);
  const newCount = (leads ?? []).filter((l) => l.status === "new").length;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Inbox className="h-4 w-4" />
              Homeowner leads
              {newCount > 0 && (
                <Badge className="ml-1 bg-primary text-primary-foreground">{newCount} new</Badge>
              )}
            </CardTitle>
            <CardDescription>
              Requests from homeowners who found you on <code>checksops.com/find-a-pro</code>.
            </CardDescription>
          </div>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            {filter === "all"
              ? "No homeowner leads yet. Once your directory listing is published, requests appear here."
              : "No leads in this status."}
          </p>
        ) : (
          <div className="space-y-3">
            {filtered.map((l) => (
              <div key={l.id} className="border border-border rounded-md p-3 space-y-2">
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="min-w-0">
                    <div className="font-medium text-sm">{l.homeowner_name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {formatDistanceToNow(new Date(l.created_at), { addSuffix: true })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge className={`text-[10px] ${statusColor[l.status] ?? ""}`}>
                      {STATUS_OPTIONS.find((s) => s.value === l.status)?.label ?? l.status}
                    </Badge>
                    <Select
                      value={l.status}
                      onValueChange={(v) => updateStatus.mutate({ id: l.id, status: v })}
                    >
                      <SelectTrigger className="h-7 w-[110px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((s) => (
                          <SelectItem key={s.value} value={s.value}>
                            {s.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-muted-foreground">
                  <a
                    href={`mailto:${l.homeowner_email}`}
                    className="flex items-center gap-1.5 hover:text-foreground truncate"
                  >
                    <Mail className="h-3 w-3" /> {l.homeowner_email}
                  </a>
                  {l.homeowner_phone && (
                    <a
                      href={`tel:${l.homeowner_phone}`}
                      className="flex items-center gap-1.5 hover:text-foreground"
                    >
                      <Phone className="h-3 w-3" /> {l.homeowner_phone}
                    </a>
                  )}
                  {(l.property_zip || l.loss_type) && (
                    <div className="flex items-center gap-1.5">
                      <MapPin className="h-3 w-3" />
                      {[l.property_zip, l.loss_type].filter(Boolean).join(" • ")}
                    </div>
                  )}
                </div>
                {l.message && (
                  <div className="text-sm border-l-2 border-primary/40 pl-2 flex gap-2">
                    <MessageSquare className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0 mt-0.5" />
                    <span>{l.message}</span>
                  </div>
                )}
                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => {
                      window.location.href = `mailto:${l.homeowner_email}?subject=${encodeURIComponent(
                        "Following up on your ChecksOps request",
                      )}`;
                      if (l.status === "new") updateStatus.mutate({ id: l.id, status: "contacted" });
                    }}
                  >
                    <Mail className="h-3 w-3 mr-1" /> Email
                  </Button>
                  {l.homeowner_phone && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs"
                      onClick={() => {
                        window.location.href = `tel:${l.homeowner_phone}`;
                        if (l.status === "new") updateStatus.mutate({ id: l.id, status: "contacted" });
                      }}
                    >
                      <Phone className="h-3 w-3 mr-1" /> Call
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
