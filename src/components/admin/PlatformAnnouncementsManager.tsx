import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SectionCard } from "@/components/settings/SectionCard";
import { toast } from "@/hooks/use-toast";
import { Loader2, Megaphone, Trash2 } from "lucide-react";
import { useAllPlatformAnnouncements, type PlatformAnnouncement } from "@/hooks/usePlatformAnnouncements";

const DEFAULT_REFRESH =
  "When the update is complete, refresh your browser (Ctrl+Shift+R on Windows, Cmd+Shift+R on Mac) or click Refresh in the banner to load the newest version.";

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PlatformAnnouncementsManager() {
  const queryClient = useQueryClient();
  const { data: announcements = [], isLoading } = useAllPlatformAnnouncements();

  const [title, setTitle] = useState("Scheduled platform update");
  const [message, setMessage] = useState(
    "ChecksOps will be receiving a system update. The platform may be briefly unavailable during this window."
  );
  const [severity, setSeverity] = useState<PlatformAnnouncement["severity"]>("maintenance");
  const [scheduledStart, setScheduledStart] = useState("");
  const [scheduledEnd, setScheduledEnd] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [refreshInstructions, setRefreshInstructions] = useState(DEFAULT_REFRESH);
  const [saving, setSaving] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["platform-announcements"] });

  const publish = async () => {
    if (!title.trim() || !message.trim()) {
      toast({ title: "Title and message are required", variant: "destructive" });
      return;
    }
    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    const { error } = await supabase.from("platform_announcements" as any).insert({
      title: title.trim(),
      message: message.trim(),
      severity,
      scheduled_start: scheduledStart ? new Date(scheduledStart).toISOString() : null,
      scheduled_end: scheduledEnd ? new Date(scheduledEnd).toISOString() : null,
      ends_at: endsAt ? new Date(endsAt).toISOString() : null,
      refresh_instructions: refreshInstructions.trim() || null,
      created_by: userData.user?.id ?? null,
      is_active: true,
    } as any);
    setSaving(false);
    if (error) {
      toast({ title: "Could not publish", description: error.message, variant: "destructive" });
      return;
    }
    toast({ title: "Announcement published", description: "Every tenant will see it on their next page load." });
    refresh();
  };

  const toggleActive = async (a: PlatformAnnouncement, value: boolean) => {
    const { error } = await supabase
      .from("platform_announcements" as any)
      .update({ is_active: value } as any)
      .eq("id", a.id);
    if (error) toast({ title: "Update failed", description: error.message, variant: "destructive" });
    refresh();
  };

  const remove = async (a: PlatformAnnouncement) => {
    const { error } = await supabase.from("platform_announcements" as any).delete().eq("id", a.id);
    if (error) toast({ title: "Delete failed", description: error.message, variant: "destructive" });
    refresh();
  };

  return (
    <div className="space-y-6">
      <SectionCard
        title="New platform announcement"
        description="Shown as a banner at the top of every page for every tenant, signed in or not."
        icon={<Megaphone className="h-4 w-4 text-primary" />}
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
      >
        <div className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5 md:col-span-2">
            <Label>Title</Label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Message</Label>
            <Textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Severity</Label>
            <Select value={severity} onValueChange={(v) => setSeverity(v as PlatformAnnouncement["severity"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="info">Info</SelectItem>
                <SelectItem value="maintenance">Scheduled maintenance</SelectItem>
                <SelectItem value="critical">Critical (cannot be dismissed)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Banner auto-hides at (optional)</Label>
            <Input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Maintenance window start</Label>
            <Input type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>Maintenance window end</Label>
            <Input type="datetime-local" value={scheduledEnd} onChange={(e) => setScheduledEnd(e.target.value)} />
          </div>
          <div className="space-y-1.5 md:col-span-2">
            <Label>Refresh instructions</Label>
            <Textarea rows={2} value={refreshInstructions} onChange={(e) => setRefreshInstructions(e.target.value)} />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button onClick={publish} disabled={saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Megaphone className="mr-2 h-4 w-4" />}
            Publish announcement
          </Button>
        </div>
      </SectionCard>

      <SectionCard
        title="Announcements"
        description="Toggle off to hide from tenants without deleting."
        icon={<Megaphone className="h-4 w-4 text-primary" />}
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
      >
        {isLoading ? (
          <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin" /></div>
        ) : announcements.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No announcements yet.</p>
        ) : (
          <div className="space-y-2">
            {announcements.map((a) => (
              <Card key={a.id}>
                <CardContent className="flex flex-wrap items-start gap-3 p-3">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">{a.title}</span>
                      <Badge variant="outline" className="text-[10px] capitalize">{a.severity}</Badge>
                      {a.is_active && <Badge className="text-[10px]">Live</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground break-words">{a.message}</p>
                    {a.scheduled_start && (
                      <p className="text-[11px] text-muted-foreground">
                        Window: {toLocalInput(a.scheduled_start).replace("T", " ")}
                        {a.scheduled_end ? ` → ${toLocalInput(a.scheduled_end).replace("T", " ")}` : ""}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2">
                    <Switch checked={a.is_active} onCheckedChange={(v) => toggleActive(a, v)} />
                    <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => remove(a)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
