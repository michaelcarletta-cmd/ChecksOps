import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Edit, CheckSquare, Activity } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { SectionCard } from "./SectionCard";

type TriggerType = "on_claim_creation" | "on_status_change" | "on_sub_status_change" | "on_check_status_change";

const CHECK_FIELDS = [
  { value: "endorsement_status", label: "Endorsement Status" },
  { value: "payment_direction_status", label: "Payment Direction Status" },
  { value: "deposit_status", label: "Deposit Status" },
  { value: "cleared_status", label: "Cleared Status" },
] as const;

const CHECK_FIELD_VALUES: Record<string, { value: string; label: string }[]> = {
  endorsement_status: [
    { value: "pending", label: "Pending" },
    { value: "requested", label: "Requested" },
    { value: "signed", label: "Signed" },
    { value: "rejected", label: "Rejected" },
  ],
  payment_direction_status: [
    { value: "not_requested", label: "Not Requested" },
    { value: "pending", label: "Pending" },
    { value: "answered", label: "Answered" },
    { value: "expired", label: "Expired" },
  ],
  deposit_status: [
    { value: "pending", label: "Pending" },
    { value: "deposited", label: "Deposited" },
    { value: "cleared", label: "Cleared" },
  ],
  cleared_status: [
    { value: "pending", label: "Pending" },
    { value: "cleared", label: "Cleared" },
  ],
};

interface TaskAutomation {
  id: string;
  title: string;
  description: string | null;
  trigger_type: TriggerType;
  trigger_status: string | null;
  trigger_sub_status_id: string | null;
  trigger_check_field: string | null;
  trigger_check_value: string | null;
  priority: "low" | "medium" | "high";
  due_date_offset: number;
  is_active: boolean;
}

interface ClaimStatus {
  id: string;
  name: string;
}

interface SubStatus {
  id: string;
  parent_status_id: string;
  name: string;
  display_order: number;
}

export function TaskAutomationsSettings() {
  const [automations, setAutomations] = useState<TaskAutomation[]>([]);
  const [statuses, setStatuses] = useState<ClaimStatus[]>([]);
  const [subStatuses, setSubStatuses] = useState<SubStatus[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAutomation, setEditingAutomation] = useState<TaskAutomation | null>(null);
  const [formData, setFormData] = useState({
    title: "",
    description: "",
    trigger_type: "on_claim_creation" as TriggerType,
    trigger_status: "",
    trigger_sub_status_id: "",
    trigger_check_field: "",
    trigger_check_value: "",
    priority: "medium" as "low" | "medium" | "high",
    due_date_offset: 0,
    is_active: true,
  });
  const { toast } = useToast();

  useEffect(() => {
    fetchAutomations();
    fetchStatuses();
    fetchSubStatuses();
  }, []);

  const fetchAutomations = async () => {
    try {
      const { data, error } = await supabase
        .from("task_automations")
        .select("*")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setAutomations((data || []) as TaskAutomation[]);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const fetchStatuses = async () => {
    try {
      const { data, error } = await supabase
        .from("claim_statuses")
        .select("id, name")
        .eq("is_active", true)
        .order("display_order");

      if (error) throw error;
      setStatuses(data || []);
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const fetchSubStatuses = async () => {
    try {
      const { data, error } = await supabase
        .from("claim_sub_statuses")
        .select("id, parent_status_id, name, display_order")
        .eq("is_active", true)
        .order("display_order");

      if (error) throw error;
      setSubStatuses(data || []);
    } catch (error: any) {
      console.error("Error fetching sub-statuses:", error);
    }
  };

  const handleSubmit = async () => {
    if (!formData.title.trim()) {
      toast({ title: "Error", description: "Task title is required", variant: "destructive" });
      return;
    }

    try {
      const payload = {
        title: formData.title,
        description: formData.description || null,
        trigger_type: formData.trigger_type,
        trigger_status: formData.trigger_type === "on_status_change" ? formData.trigger_status : null,
        trigger_sub_status_id: formData.trigger_type === "on_sub_status_change" ? (formData.trigger_sub_status_id || null) : null,
        trigger_check_field: formData.trigger_type === "on_check_status_change" ? (formData.trigger_check_field || null) : null,
        trigger_check_value: formData.trigger_type === "on_check_status_change" ? (formData.trigger_check_value || null) : null,
        priority: formData.priority,
        due_date_offset: formData.due_date_offset,
        is_active: formData.is_active,
      };

      if (editingAutomation) {
        const { error } = await supabase
          .from("task_automations")
          .update(payload)
          .eq("id", editingAutomation.id);
        if (error) throw error;
        toast({ title: "Success", description: "Task automation updated successfully" });
      } else {
        const { error } = await supabase
          .from("task_automations")
          .insert(payload);
        if (error) throw error;
        toast({ title: "Success", description: "Task automation created successfully" });
      }

      setIsDialogOpen(false);
      resetForm();
      fetchAutomations();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const handleEdit = (automation: TaskAutomation) => {
    setEditingAutomation(automation);
    setFormData({
      title: automation.title,
      description: automation.description || "",
      trigger_type: automation.trigger_type,
      trigger_status: automation.trigger_status || "",
      trigger_sub_status_id: automation.trigger_sub_status_id || "",
      trigger_check_field: automation.trigger_check_field || "",
      trigger_check_value: automation.trigger_check_value || "",
      priority: automation.priority,
      due_date_offset: automation.due_date_offset,
      is_active: automation.is_active,
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async (id: string) => {
    try {
      const { error } = await supabase.from("task_automations").delete().eq("id", id);
      if (error) throw error;
      toast({ title: "Success", description: "Task automation deleted successfully" });
      fetchAutomations();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const toggleActive = async (id: string, currentActive: boolean) => {
    try {
      const { error } = await supabase
        .from("task_automations")
        .update({ is_active: !currentActive })
        .eq("id", id);
      if (error) throw error;
      toast({ title: "Success", description: `Task automation ${!currentActive ? "activated" : "deactivated"}` });
      fetchAutomations();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    }
  };

  const resetForm = () => {
    setEditingAutomation(null);
    setFormData({
      title: "",
      description: "",
      trigger_type: "on_claim_creation",
      trigger_status: "",
      trigger_sub_status_id: "",
      trigger_check_field: "",
      trigger_check_value: "",
      priority: "medium",
      due_date_offset: 0,
      is_active: true,
    });
  };

  const getSubStatusName = (id: string | null) => {
    if (!id) return "";
    const sub = subStatuses.find(s => s.id === id);
    if (!sub) return id;
    const parent = statuses.find(st => st.id === sub.parent_status_id);
    return parent ? `${parent.name} → ${sub.name}` : sub.name;
  };

  const getTriggerDisplay = (automation: TaskAutomation) => {
    if (automation.trigger_type === "on_claim_creation") return "When claim is created";
    if (automation.trigger_type === "on_sub_status_change") {
      return `When sub-step: ${getSubStatusName(automation.trigger_sub_status_id)}`;
    }
    if (automation.trigger_type === "on_check_status_change") {
      const fieldLabel = CHECK_FIELDS.find(f => f.value === automation.trigger_check_field)?.label || automation.trigger_check_field;
      return `When check ${fieldLabel} → ${automation.trigger_check_value}`;
    }
    return `When status → ${automation.trigger_status}`;
  };

  // Group sub-statuses by parent for the selector
  const groupedSubStatuses = statuses
    .map(status => ({
      status,
      subs: subStatuses.filter(s => s.parent_status_id === status.id),
    }))
    .filter(g => g.subs.length > 0);

  return (
    <SectionCard
      title="Task Automations"
      icon={<CheckSquare className="h-4 w-4 text-primary" />}
      accent="bg-gradient-to-r from-primary/60 to-primary/10"
      description="Automatically create tasks when claims are created, enter specific statuses, or reach sub-steps"
    >
      <div className="space-y-6">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
          <h3 className="text-sm font-medium">Task Rules</h3>
          <Dialog open={isDialogOpen} onOpenChange={(open) => {
            setIsDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                Add Automation
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>
                  {editingAutomation ? "Edit Task Automation" : "Create Task Automation"}
                </DialogTitle>
                <DialogDescription>
                  Define a task that will be automatically created based on claim events
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="title">Task Title*</Label>
                  <Input
                    id="title"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    placeholder="e.g., Schedule inspection"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="description">Task Description</Label>
                  <Textarea
                    id="description"
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    placeholder="Optional task details..."
                    rows={3}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="trigger_type">Trigger Type</Label>
                  <Select
                    value={formData.trigger_type}
                    onValueChange={(value: TriggerType) =>
                      setFormData({ ...formData, trigger_type: value, trigger_status: "", trigger_sub_status_id: "", trigger_check_field: "", trigger_check_value: "" })
                    }
                  >
                    <SelectTrigger id="trigger_type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="on_claim_creation">When claim is created</SelectItem>
                      <SelectItem value="on_status_change">When status changes</SelectItem>
                      <SelectItem value="on_sub_status_change">When sub-step is entered</SelectItem>
                      <SelectItem value="on_check_status_change">When check status changes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {formData.trigger_type === "on_status_change" && (
                  <div className="space-y-2">
                    <Label htmlFor="trigger_status">Target Status</Label>
                    <Select
                      value={formData.trigger_status}
                      onValueChange={(value) => setFormData({ ...formData, trigger_status: value })}
                    >
                      <SelectTrigger id="trigger_status">
                        <SelectValue placeholder="Select status" />
                      </SelectTrigger>
                      <SelectContent>
                        {statuses.map((status) => (
                          <SelectItem key={status.id} value={status.name}>
                            {status.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {formData.trigger_type === "on_sub_status_change" && (
                  <div className="space-y-2">
                    <Label htmlFor="trigger_sub_status">Target Sub-step</Label>
                    <Select
                      value={formData.trigger_sub_status_id}
                      onValueChange={(value) => setFormData({ ...formData, trigger_sub_status_id: value })}
                    >
                      <SelectTrigger id="trigger_sub_status">
                        <SelectValue placeholder="Select a sub-step" />
                      </SelectTrigger>
                      <SelectContent>
                        {groupedSubStatuses.map(({ status, subs }) => (
                          <div key={status.id}>
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground">{status.name}</div>
                            {subs.map((sub) => (
                              <SelectItem key={sub.id} value={sub.id} className="pl-6">
                                {sub.name}
                              </SelectItem>
                            ))}
                          </div>
                        ))}
                        {groupedSubStatuses.length === 0 && (
                          <div className="px-2 py-3 text-xs text-muted-foreground text-center">
                            No sub-steps configured. Add them in Workflow → Claim Statuses.
                          </div>
                        )}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {formData.trigger_type === "on_check_status_change" && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="trigger_check_field">Check Status Field</Label>
                      <Select
                        value={formData.trigger_check_field}
                        onValueChange={(value) => setFormData({ ...formData, trigger_check_field: value, trigger_check_value: "" })}
                      >
                        <SelectTrigger id="trigger_check_field">
                          <SelectValue placeholder="Select field" />
                        </SelectTrigger>
                        <SelectContent>
                          {CHECK_FIELDS.map((f) => (
                            <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="trigger_check_value">Target Value</Label>
                      <Select
                        value={formData.trigger_check_value}
                        onValueChange={(value) => setFormData({ ...formData, trigger_check_value: value })}
                        disabled={!formData.trigger_check_field}
                      >
                        <SelectTrigger id="trigger_check_value">
                          <SelectValue placeholder="Select value" />
                        </SelectTrigger>
                        <SelectContent>
                          {(CHECK_FIELD_VALUES[formData.trigger_check_field] || []).map((v) => (
                            <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="priority">Priority</Label>
                    <Select
                      value={formData.priority}
                      onValueChange={(value: "low" | "medium" | "high") =>
                        setFormData({ ...formData, priority: value })
                      }
                    >
                      <SelectTrigger id="priority">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="low">Low</SelectItem>
                        <SelectItem value="medium">Medium</SelectItem>
                        <SelectItem value="high">High</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="due_date_offset">Due Date (days from trigger)</Label>
                    <Input
                      id="due_date_offset"
                      type="number"
                      value={formData.due_date_offset}
                      onChange={(e) =>
                        setFormData({ ...formData, due_date_offset: parseInt(e.target.value) || 0 })
                      }
                    />
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  <Switch
                    id="is_active"
                    checked={formData.is_active}
                    onCheckedChange={(checked) => setFormData({ ...formData, is_active: checked })}
                  />
                  <Label htmlFor="is_active">Active</Label>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setIsDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSubmit}>
                  {editingAutomation ? "Update" : "Create"} Automation
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
        <div className="grid gap-4">
          {automations.length === 0 && (
            <div className="text-center py-8 border-2 border-dashed rounded-lg">
              <p className="text-sm text-muted-foreground">No task automations created yet.</p>
            </div>
          )}
          {automations.map((automation) => (
            <div key={automation.id} className="flex items-center justify-between p-4 rounded-lg border bg-muted/20">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{automation.title}</span>
                  <Badge variant="outline" className="text-[10px] py-0">
                    {getTriggerDisplay(automation)}
                  </Badge>
                  <Badge 
                    className={`text-[10px] py-0 font-bold uppercase ${
                      automation.priority === 'high' ? 'bg-red-500/10 text-red-500' :
                      automation.priority === 'medium' ? 'bg-amber-500/10 text-amber-500' :
                      'bg-blue-500/10 text-blue-500'
                    }`}
                    variant="outline"
                  >
                    {automation.priority}
                  </Badge>
                </div>
                {automation.description && (
                  <p className="text-xs text-muted-foreground">{automation.description}</p>
                )}
                {automation.due_date_offset > 0 && (
                  <p className="text-[10px] text-muted-foreground">
                    Due {automation.due_date_offset} days after trigger
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={automation.is_active}
                  onCheckedChange={() => toggleActive(automation.id, automation.is_active)}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8"
                  onClick={() => handleEdit(automation)}
                >
                  <Edit className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  onClick={() => handleDelete(automation.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}
