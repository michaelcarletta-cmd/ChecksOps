import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Trash2, Plus, BellRing, Clock } from "lucide-react";
import { toast } from "sonner";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";

interface Recipient {
  id: string;
  display_name: string;
  phone_number: string;
  is_active: boolean;
}

interface Rule {
  id: string;
  rule_key: string;
  display_label: string;
  status_names: string[];
  threshold_days: number;
  count_mode: "calendar" | "business";
  trigger_kind: string;
  is_enabled: boolean;
}

export default function StatusUrgencyNotificationsSettings() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [adding, setAdding] = useState(false);
  const [scanning, setScanning] = useState(false);

  const { data: recipients = [] } = useQuery({
    queryKey: ["urgency_sms_recipients"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("urgency_sms_recipients")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw error;
      return data as Recipient[];
    },
  });

  const { data: rules = [] } = useQuery({
    queryKey: ["status_urgency_rules"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("status_urgency_rules")
        .select("*")
        .order("display_label", { ascending: true });
      if (error) throw error;
      return data as Rule[];
    },
  });

  const handleAdd = async () => {
    if (!name.trim() || !phone.trim()) {
      toast.error("Name and phone are required");
      return;
    }
    setAdding(true);
    const { error } = await supabase
      .from("urgency_sms_recipients")
      .insert({ display_name: name.trim(), phone_number: phone.trim() });
    setAdding(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    setName("");
    setPhone("");
    toast.success("Recipient added");
    qc.invalidateQueries({ queryKey: ["urgency_sms_recipients"] });
  };

  const handleToggle = async (r: Recipient) => {
    const { error } = await supabase
      .from("urgency_sms_recipients")
      .update({ is_active: !r.is_active })
      .eq("id", r.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["urgency_sms_recipients"] });
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Remove this recipient?")) return;
    const { error } = await supabase
      .from("urgency_sms_recipients")
      .delete()
      .eq("id", id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["urgency_sms_recipients"] });
    toast.success("Recipient removed");
  };

  const handleToggleRule = async (rule: Rule) => {
    const { error } = await supabase
      .from("status_urgency_rules")
      .update({ is_enabled: !rule.is_enabled })
      .eq("id", rule.id);
    if (error) return toast.error(error.message);
    qc.invalidateQueries({ queryKey: ["status_urgency_rules"] });
  };

  const handleRunScanNow = async () => {
    setScanning(true);
    const { data, error } = await supabase.functions.invoke("scan-status-urgency", {
      body: {},
    });
    setScanning(false);
    if (error) {
      toast.error(error.message);
      return;
    }
    const summary = (data as any)?.summary;
    toast.success(
      `Scan complete — ${summary?.breachesFound ?? 0} breaches, ${summary?.smsSent ?? 0} SMS sent`,
    );
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Status Inactivity Alerts"
        description="Configure SMS notifications for claims that breach status-based thresholds."
        badge="Notifications"
        icon={<BellRing className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="SMS Recipients"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<BellRing className="h-4 w-4 text-primary" />}
        description="Admins who will receive SMS alerts."
      >
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <Label htmlFor="rec-name">Name</Label>
              <Input
                id="rec-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Mike Smith"
              />
            </div>
            <div>
              <Label htmlFor="rec-phone">Phone (E.164 or 10-digit)</Label>
              <Input
                id="rec-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+15551234567"
              />
            </div>
            <div className="flex items-end">
              <Button onClick={handleAdd} disabled={adding} className="w-full">
                <Plus className="h-4 w-4 mr-2" />
                Add Recipient
              </Button>
            </div>
          </div>

          {recipients.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center border border-dashed rounded">
              No recipients yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Active</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>{r.display_name}</TableCell>
                    <TableCell className="font-mono text-sm">{r.phone_number}</TableCell>
                    <TableCell>
                      <Switch checked={r.is_active} onCheckedChange={() => handleToggle(r)} />
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)}>
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </SectionCard>

      <SectionCard
        title="Urgency Rules"
        accent="bg-gradient-to-r from-muted-foreground/60 to-muted-foreground/10"
        icon={<Clock className="h-4 w-4 text-muted-foreground" />}
      >
        <CardContent>
          <div className="flex items-center justify-end mb-4">
            <Button variant="outline" onClick={handleRunScanNow} disabled={scanning}>
              {scanning ? "Scanning…" : "Run scan now"}
            </Button>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Rule</TableHead>
                <TableHead>Threshold</TableHead>
                <TableHead>Statuses</TableHead>
                <TableHead className="w-20">Enabled</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rules.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div className="font-medium">{rule.display_label}</div>
                    <div className="text-xs text-muted-foreground">{rule.trigger_kind.replace(/_/g, " ")}</div>
                  </TableCell>
                  <TableCell>
                    {rule.trigger_kind === "inactivity"
                      ? `${rule.threshold_days} days`
                      : "Trigger"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1 max-w-xl">
                      {rule.status_names.map((s) => (
                        <Badge key={s} variant="secondary" className="text-xs">{s}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Switch checked={rule.is_enabled} onCheckedChange={() => handleToggleRule(rule)} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </SectionCard>
    </div>
  );
}