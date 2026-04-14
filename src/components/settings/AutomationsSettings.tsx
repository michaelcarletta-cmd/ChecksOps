import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Loader2, Plus, Play, Trash2, Clock, Mail, MessageSquare, CheckSquare, AlertCircle, Zap, ListTodo, Pencil, Settings } from "lucide-react";
import { TaskAutomationsSettings } from "./TaskAutomationsSettings";
import { AutomationGlobalSettings } from "./AutomationGlobalSettings";
import { RichTextEditor } from "@/components/ui/rich-text-editor";

interface TriggerConfig {
  // For scheduled
  schedule_type?: 'once' | 'daily' | 'weekly' | 'days_after';
  schedule_time?: string;
  schedule_day?: string;
  days_after_creation?: number;
  // For inactivity
  inactivity_days?: number;
  // For status_change
  status?: string;
  // For sub_status_change
  sub_status_id?: string;
  // For task_completed
  task_title_pattern?: string;
  // For inbound_email / inbound_sms
  sender_type?: 'insurance' | 'client' | 'contractor' | 'any';
}

interface ActionConfig {
  type: 'send_email' | 'send_sms' | 'create_task' | 'send_notification' | 'update_claim_status' | 'call_webhook';
  config: {
    // Email/SMS - support multiple recipients
    recipient_types?: ('policyholder' | 'adjuster' | 'referrer' | 'contractors')[]; // Multiple recipient types
    manual_emails?: string[]; // Manually entered email addresses
    manual_emails_text?: string; // Raw input for editing
    recipient_type?: 'policyholder' | 'adjuster' | 'referrer' | 'contractors' | 'claim_staff' | 'admins'; // Legacy + SMS support
    subject?: string;
    message?: string;
    email_template_id?: string; // Reference to email template
    sms_template_id?: string; // Reference to SMS template
    // Email attachments
    attachment_folders?: string[]; // Folder names to pull files from
    file_name_patterns?: string[]; // File name patterns to match (parsed from text)
    file_name_patterns_text?: string; // Raw input text for editing
    // Task
    title?: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high';
    due_date_offset?: number;
    due_date_type?: 'calendar' | 'business'; // Calendar or business days
    assign_to_type?: 'none' | 'user' | 'claim_contractor' | 'claim_staff'; // Assignment type
    assign_to_user_id?: string; // Specific user ID
    // Status change
    new_status?: string;
    // Webhook
    webhook_url?: string;
    webhook_include_files?: boolean;
  };
}

export const AutomationsSettings = () => {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [triggerType, setTriggerType] = useState<string>("");
  const [triggerConfig, setTriggerConfig] = useState<TriggerConfig>({});
  const [actions, setActions] = useState<ActionConfig[]>([]);
  const [currentAction, setCurrentAction] = useState<ActionConfig | null>(null);
  const [editingActionIndex, setEditingActionIndex] = useState<number | null>(null);

  const { data: automations, isLoading } = useQuery({
    queryKey: ["automations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("automations")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const { data: executions } = useQuery({
    queryKey: ["automation-executions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("automation_executions")
        .select("*, automation:automations(name)")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  const { data: statuses } = useQuery({
    queryKey: ["claim-statuses-automations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_statuses")
        .select("*")
        .eq("is_active", true)
        .order("display_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: subStatuses } = useQuery({
    queryKey: ["claim-sub-statuses-automations"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_sub_statuses")
        .select("id, name, parent_status_id")
        .eq("is_active", true)
        .order("display_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: emailTemplates } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_templates")
        .select("id, name, subject, body, category")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  const { data: smsTemplates } = useQuery({
    queryKey: ["sms-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_templates")
        .select("id, name, body, category")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data;
    },
  });

  const { data: users } = useQuery({
    queryKey: ["profiles-for-assignment"],
    queryFn: async () => {
      // Get staff and admin users only (exclude clients and contractors)
      const { data: staffRoles, error: rolesError } = await supabase
        .from("user_roles")
        .select("user_id")
        .in("role", ["admin", "staff"]);
      
      if (rolesError) throw rolesError;
      
      const staffUserIds = staffRoles?.map(r => r.user_id) || [];
      
      if (staffUserIds.length === 0) return [];
      
      const { data, error } = await supabase
        .from("profiles")
        .select("id, full_name, email")
        .in("id", staffUserIds)
        .order("full_name");
      if (error) throw error;
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async (automation: any) => {
      const { error } = await supabase.from("automations").insert(automation);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast.success("Automation created successfully");
      resetForm();
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, automation }: { id: string; automation: any }) => {
      const { error } = await supabase.from("automations").update(automation).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast.success("Automation updated successfully");
      resetForm();
    },
    onError: (error: any) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("automations").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
      toast.success("Automation deleted");
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("automations")
        .update({ is_active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["automations"] });
    },
  });

  const manualTriggerMutation = useMutation({
    mutationFn: async (automationId: string) => {
      const { data, error } = await supabase.functions.invoke('automation-webhook', {
        body: { automation_id: automationId }
      });
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      toast.success("Automation triggered");
      queryClient.invalidateQueries({ queryKey: ["automation-executions"] });
    },
  });

  const resetForm = () => {
    setIsDialogOpen(false);
    setEditingId(null);
    setFormName("");
    setFormDescription("");
    setTriggerType("");
    setTriggerConfig({});
    setActions([]);
    setCurrentAction(null);
    setEditingActionIndex(null);
  };

  const openEditDialog = (automation: any) => {
    setEditingId(automation.id);
    setFormName(automation.name);
    setFormDescription(automation.description || "");
    setTriggerType(automation.trigger_type);
    setTriggerConfig(automation.trigger_config || {});
    setActions(((automation.actions as ActionConfig[]) || []).map(normalizeAction));
    setCurrentAction(null);
    setEditingActionIndex(null);
    setIsDialogOpen(true);
  };

  const saveAction = () => {
    if (currentAction) {
      // Parse file name patterns from text if present
      const actionToSave = { ...currentAction };
      if (actionToSave.type === 'send_email') {
        // Parse file name patterns
        if (actionToSave.config.file_name_patterns_text) {
          const patterns = actionToSave.config.file_name_patterns_text
            .split(',')
            .map(p => p.trim())
            .filter(p => p.length > 0);
          actionToSave.config.file_name_patterns = patterns.length > 0 ? patterns : undefined;
        }
        // Parse manual emails
        if (actionToSave.config.manual_emails_text) {
          const emails = actionToSave.config.manual_emails_text
            .split(',')
            .map(e => e.trim())
            .filter(e => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
          actionToSave.config.manual_emails = emails.length > 0 ? emails : undefined;
        }
      }
      
      if (editingActionIndex !== null) {
        // Update existing action
        const updatedActions = [...actions];
        updatedActions[editingActionIndex] = actionToSave;
        setActions(updatedActions);
        setEditingActionIndex(null);
      } else {
        // Add new action
        setActions([...actions, actionToSave]);
      }
      setCurrentAction(null);
    }
  };

  const editAction = (index: number) => {
    const action = actions[index];
    setCurrentAction(normalizeAction(action));
    setEditingActionIndex(index);
  };

  const cancelEditAction = () => {
    setCurrentAction(null);
    setEditingActionIndex(null);
  };

  const removeAction = (index: number) => {
    setActions(actions.filter((_, i) => i !== index));
    if (editingActionIndex === index) {
      setCurrentAction(null);
      setEditingActionIndex(null);
    }
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    
    if (actions.length === 0) {
      toast.error("Please add at least one action");
      return;
    }

    const automation = {
      name: formName,
      description: formDescription,
      trigger_type: triggerType,
      trigger_config: triggerConfig,
      actions: actions,
    };

    if (editingId) {
      updateMutation.mutate({ id: editingId, automation });
    } else {
      createMutation.mutate({ ...automation, is_active: true });
    }
  };

  const normalizeAction = (action: Partial<ActionConfig> | null | undefined): ActionConfig => {
    const rawAction = (action ?? {}) as Record<string, any>;

    return {
      type: (rawAction.type as ActionConfig["type"]) || "send_notification",
      config: {
        recipient_type: rawAction.recipient_type,
        subject: rawAction.subject,
        message: rawAction.message ?? rawAction.message_template,
        email_template_id: rawAction.email_template_id,
        sms_template_id: rawAction.sms_template_id,
        title: rawAction.title,
        description: rawAction.description,
        priority: rawAction.priority,
        due_date_offset: rawAction.due_date_offset,
        due_date_type: rawAction.due_date_type,
        assign_to_type: rawAction.assign_to_type,
        assign_to_user_id: rawAction.assign_to_user_id,
        new_status: rawAction.new_status,
        webhook_url: rawAction.webhook_url,
        webhook_include_files: rawAction.webhook_include_files,
        recipient_types: rawAction.recipient_types,
        manual_emails: rawAction.manual_emails,
        manual_emails_text: rawAction.manual_emails_text,
        attachment_folders: rawAction.attachment_folders,
        file_name_patterns: rawAction.file_name_patterns,
        file_name_patterns_text: rawAction.file_name_patterns_text,
        ...(rawAction.config || {}),
      },
    };
  };

  const getTriggerDescription = (automation: any) => {
    const config = automation.trigger_config || {};
    const senderLabels: Record<string, string> = {
      'insurance': 'Insurance/Adjuster',
      'client': 'Client/Policyholder',
      'contractor': 'Contractor',
      'any': 'Any sender'
    };
    switch (automation.trigger_type) {
      case 'scheduled':
        if (config.schedule_type === 'once') return `Once at ${config.schedule_time}`;
        if (config.schedule_type === 'daily') return `Daily at ${config.schedule_time}`;
        if (config.schedule_type === 'weekly') return `Weekly on ${config.schedule_day} at ${config.schedule_time}`;
        if (config.days_after_creation) return `${config.days_after_creation} days after claim creation`;
        return 'Scheduled';
      case 'inactivity':
        return `After ${config.inactivity_days || 7} days of inactivity`;
      case 'status_change':
        return config.status ? `When status changes to ${config.status}` : 'On any status change';
      case 'sub_status_change': {
        const subName = subStatuses?.find(s => s.id === config.sub_status_id)?.name;
        return config.sub_status_id ? `When sub-step: ${subName || config.sub_status_id}` : 'On any sub-step change';
      }
      case 'task_completed':
        return config.task_title_pattern 
          ? `When task containing "${config.task_title_pattern}" is completed` 
          : 'When any task is completed';
      case 'inspection_scheduled':
        return 'When a new inspection is scheduled';
      case 'inspection_upcoming_24h':
        return `When inspection is within ${config.hours_before || 24} hours`;
      case 'inbound_email':
        return `When email received from ${senderLabels[config.sender_type] || 'any sender'}`;
      case 'inbound_sms':
        return `When SMS received from ${senderLabels[config.sender_type] || 'any sender'}`;
      default:
        return automation.trigger_type.replace('_', ' ');
    }
  };

  const getActionIcon = (type: string) => {
    switch (type) {
      case 'send_email': return <Mail className="h-4 w-4" />;
      case 'send_sms': return <MessageSquare className="h-4 w-4" />;
      case 'create_task': return <CheckSquare className="h-4 w-4" />;
      case 'send_notification': return <AlertCircle className="h-4 w-4" />;
      case 'update_claim_status': return <Zap className="h-4 w-4" />;
      case 'call_webhook': return <Zap className="h-4 w-4" />;
      default: return null;
    }
  };

  const getActionDescription = (action: ActionConfig) => {
    const normalizedAction = normalizeAction(action);

    switch (normalizedAction.type) {
      case 'send_email':
        const attachmentInfo = normalizedAction.config.attachment_folders?.length 
          ? ` (with ${normalizedAction.config.attachment_folders.length} folder attachments)` 
          : '';
        const templateInfo = normalizedAction.config.email_template_id 
          ? emailTemplates?.find(t => t.id === normalizedAction.config.email_template_id)?.name || 'Template'
          : normalizedAction.config.subject;
        // Build recipients description
        const recipientParts: string[] = [];
        if (normalizedAction.config.recipient_types?.length) {
          recipientParts.push(normalizedAction.config.recipient_types.join(', '));
        } else if (normalizedAction.config.recipient_type) {
          recipientParts.push(normalizedAction.config.recipient_type);
        }
        if (normalizedAction.config.manual_emails?.length) {
          recipientParts.push(`+${normalizedAction.config.manual_emails.length} manual`);
        }
        const recipientsStr = recipientParts.length > 0 ? recipientParts.join(' & ') : 'no recipients';
        return `Email to ${recipientsStr}: ${templateInfo}${attachmentInfo}`;
      case 'send_sms':
        const smsRecipientLabel: Record<string, string> = {
          policyholder: 'Policyholder',
          adjuster: 'Insurance Adjuster',
          contractors: 'Assigned Contractors',
          claim_staff: 'Assigned Staff',
          admins: 'All Admins',
        };
        return `SMS to ${smsRecipientLabel[normalizedAction.config.recipient_type || ''] || normalizedAction.config.recipient_type || 'recipient'}`;
      case 'create_task':
        const assignInfo = normalizedAction.config.assign_to_type === 'user' 
          ? ` → ${users?.find(u => u.id === normalizedAction.config.assign_to_user_id)?.full_name || 'User'}`
          : normalizedAction.config.assign_to_type === 'claim_contractor' 
            ? ' → Claim Contractor'
            : '';
        return `Create task: ${normalizedAction.config.title}${assignInfo}`;
      case 'send_notification':
        return `Send notification`;
      case 'update_claim_status':
        return `Change status to: ${normalizedAction.config.new_status}`;
      case 'call_webhook':
        return `Call webhook: ${normalizedAction.config.webhook_url ? 'Zapier' : 'Not configured'}`;
      default:
        return normalizedAction.type;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-foreground">Automations</h2>
        <p className="text-muted-foreground">Create automated workflows for follow-ups, reminders, and more</p>
      </div>

      <Tabs defaultValue="workflows" className="space-y-4">
        <TabsList className="flex flex-col md:flex-row h-auto w-full bg-muted/40 p-2 gap-1">
          <TabsTrigger value="workflows" className="w-full md:w-auto justify-start text-base font-medium px-4 flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Workflows
          </TabsTrigger>
          <TabsTrigger value="task-automations" className="w-full md:w-auto justify-start text-base font-medium px-4 flex items-center gap-2">
            <ListTodo className="h-4 w-4" />
            Task Automations
          </TabsTrigger>
          <TabsTrigger value="global-settings" className="w-full md:w-auto justify-start text-base font-medium px-4 flex items-center gap-2">
            <Settings className="h-4 w-4" />
            Global Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="workflows" className="space-y-6">
          <div className="flex items-center justify-end">
        <Dialog open={isDialogOpen} onOpenChange={(open) => open ? setIsDialogOpen(true) : resetForm()}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Automation
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>{editingId ? 'Edit Automation' : 'Create Automation'}</DialogTitle>
                <DialogDescription>
                  Set up automated follow-ups, emails, texts, and tasks
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-6 py-4">
                {/* Basic Info */}
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="name">Automation Name</Label>
                    <Input 
                      id="name" 
                      placeholder="e.g., 7-Day Follow-up Email" 
                      value={formName}
                      onChange={(e) => setFormName(e.target.value)}
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="description">Description</Label>
                    <Textarea 
                      id="description" 
                      placeholder="What does this automation do?" 
                      value={formDescription}
                      onChange={(e) => setFormDescription(e.target.value)}
                    />
                  </div>
                </div>

                {/* Trigger Configuration */}
                <div className="space-y-4 border-t pt-4">
                  <h3 className="font-semibold flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    When should this run?
                  </h3>
                  <div className="space-y-2">
                    <Label>Trigger Type</Label>
                    <Select value={triggerType} onValueChange={(value) => {
                      setTriggerType(value);
                      setTriggerConfig({});
                    }}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select when to trigger" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="scheduled">Scheduled (specific time after claim creation)</SelectItem>
                        <SelectItem value="inactivity">After Inactivity Period</SelectItem>
                        <SelectItem value="status_change">When Claim Status Changes</SelectItem>
                        <SelectItem value="sub_status_change">When Sub-Step Changes</SelectItem>
                        <SelectItem value="task_completed">When Task is Completed</SelectItem>
                        <SelectItem value="inspection_scheduled">When Inspection is Scheduled</SelectItem>
                          <SelectItem value="inspection_upcoming_24h">24 Hours Before Inspection</SelectItem>
                        <SelectItem value="inbound_email">When Inbound Email Received</SelectItem>
                        <SelectItem value="inbound_sms">When Inbound SMS Received</SelectItem>
                        <SelectItem value="manual">Manual Trigger Only</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Scheduled Trigger Config */}
                  {triggerType === 'scheduled' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>Schedule Type</Label>
                        <Select 
                          value={triggerConfig.schedule_type || ''} 
                          onValueChange={(value) => setTriggerConfig({ ...triggerConfig, schedule_type: value as any })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select schedule type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="days_after">Days after claim creation</SelectItem>
                            <SelectItem value="daily">Daily recurring</SelectItem>
                            <SelectItem value="weekly">Weekly recurring</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      
                      {triggerConfig.schedule_type === 'days_after' && (
                        <div className="space-y-2">
                          <Label>Days After Claim Creation</Label>
                          <Input 
                            type="number" 
                            min="1"
                            placeholder="e.g., 7"
                            value={triggerConfig.days_after_creation || ''}
                            onChange={(e) => setTriggerConfig({ ...triggerConfig, days_after_creation: parseInt(e.target.value) })}
                          />
                        </div>
                      )}

                      {(triggerConfig.schedule_type === 'daily' || triggerConfig.schedule_type === 'weekly') && (
                        <div className="space-y-2">
                          <Label>Time of Day</Label>
                          <Input 
                            type="time"
                            value={triggerConfig.schedule_time || '09:00'}
                            onChange={(e) => setTriggerConfig({ ...triggerConfig, schedule_time: e.target.value })}
                          />
                        </div>
                      )}

                      {triggerConfig.schedule_type === 'weekly' && (
                        <div className="space-y-2">
                          <Label>Day of Week</Label>
                          <Select 
                            value={triggerConfig.schedule_day || ''} 
                            onValueChange={(value) => setTriggerConfig({ ...triggerConfig, schedule_day: value })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select day" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="monday">Monday</SelectItem>
                              <SelectItem value="tuesday">Tuesday</SelectItem>
                              <SelectItem value="wednesday">Wednesday</SelectItem>
                              <SelectItem value="thursday">Thursday</SelectItem>
                              <SelectItem value="friday">Friday</SelectItem>
                              <SelectItem value="saturday">Saturday</SelectItem>
                              <SelectItem value="sunday">Sunday</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Inactivity Trigger Config */}
                  {triggerType === 'inactivity' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>Days Without Activity</Label>
                        <Input 
                          type="number" 
                          min="1"
                          placeholder="e.g., 14"
                          value={triggerConfig.inactivity_days || ''}
                          onChange={(e) => setTriggerConfig({ ...triggerConfig, inactivity_days: parseInt(e.target.value) })}
                        />
                        <p className="text-sm text-muted-foreground">
                          Trigger when a claim has no updates, notes, or file uploads for this many days
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Status Change Trigger Config */}
                  {triggerType === 'status_change' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>When Status Changes To</Label>
                        <Select 
                          value={triggerConfig.status || '_any'} 
                          onValueChange={(value) => setTriggerConfig({ ...triggerConfig, status: value === '_any' ? undefined : value, sub_status_id: undefined })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Any status (leave empty)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_any">Any status change</SelectItem>
                            {statuses?.map((status) => (
                              <SelectItem key={status.id} value={status.name}>
                                {status.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      {/* Optional sub-status filter when a specific status is selected */}
                      {triggerConfig.status && (() => {
                        const selectedStatus = statuses?.find(s => s.name === triggerConfig.status);
                        const availableSubs = selectedStatus 
                          ? subStatuses?.filter(s => s.parent_status_id === selectedStatus.id) || []
                          : [];
                        if (availableSubs.length === 0) return null;
                        return (
                          <div className="space-y-2">
                            <Label>And Sub-Step (optional)</Label>
                            <Select 
                              value={triggerConfig.sub_status_id || '_any'} 
                              onValueChange={(value) => setTriggerConfig({ ...triggerConfig, sub_status_id: value === '_any' ? undefined : value })}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Any sub-step" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="_any">Any sub-step</SelectItem>
                                {availableSubs.map((sub) => (
                                  <SelectItem key={sub.id} value={sub.id}>
                                    {sub.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <p className="text-xs text-muted-foreground">Only fire when this specific sub-step is entered</p>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Sub-Status Change Trigger Config */}
                  {triggerType === 'sub_status_change' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>When Sub-Step Changes To</Label>
                        <Select 
                          value={triggerConfig.sub_status_id || '_any'} 
                          onValueChange={(value) => setTriggerConfig({ ...triggerConfig, sub_status_id: value === '_any' ? undefined : value })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Any sub-step (leave empty)" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="_any">Any sub-step change</SelectItem>
                            {subStatuses?.map((sub) => {
                              const parentStatus = statuses?.find(s => s.id === sub.parent_status_id);
                              return (
                                <SelectItem key={sub.id} value={sub.id}>
                                  {parentStatus ? `${parentStatus.name} → ` : ''}{sub.name}
                                </SelectItem>
                              );
                            })}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>
                  )}

                  {triggerType === 'task_completed' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>Task Title Contains (Optional)</Label>
                        <Input 
                          placeholder="e.g., Follow up, Inspection"
                          value={triggerConfig.task_title_pattern || ''}
                          onChange={(e) => setTriggerConfig({ ...triggerConfig, task_title_pattern: e.target.value })}
                        />
                        <p className="text-sm text-muted-foreground">
                          Leave empty to trigger on any task completion, or enter text to match specific tasks
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Inbound Email Trigger Config */}
                  {triggerType === 'inbound_email' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>Email From</Label>
                        <Select 
                          value={triggerConfig.sender_type || 'any'} 
                          onValueChange={(value) => setTriggerConfig({ ...triggerConfig, sender_type: value as any })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select sender type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any">Any Sender</SelectItem>
                            <SelectItem value="insurance">Insurance Company / Adjuster</SelectItem>
                            <SelectItem value="client">Client / Policyholder</SelectItem>
                            <SelectItem value="contractor">Contractor</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-sm text-muted-foreground">
                          Trigger when an inbound email is received from the selected sender type
                        </p>
                      </div>
                    </div>
                  )}

                  {/* Inbound SMS Trigger Config */}
                  {triggerType === 'inbound_sms' && (
                    <div className="space-y-4 pl-4 border-l-2 border-muted">
                      <div className="space-y-2">
                        <Label>SMS From</Label>
                        <Select 
                          value={triggerConfig.sender_type || 'any'} 
                          onValueChange={(value) => setTriggerConfig({ ...triggerConfig, sender_type: value as any })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select sender type" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="any">Any Sender</SelectItem>
                            <SelectItem value="insurance">Insurance Company / Adjuster</SelectItem>
                            <SelectItem value="client">Client / Policyholder</SelectItem>
                            <SelectItem value="contractor">Contractor</SelectItem>
                          </SelectContent>
                        </Select>
                        <p className="text-sm text-muted-foreground">
                          Trigger when an inbound SMS is received from the selected sender type
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {/* Actions Configuration */}
                <div className="space-y-4 border-t pt-4">
                  <h3 className="font-semibold">What actions should be taken?</h3>
                  
                  {/* Added Actions */}
                  {actions.length > 0 && (
                    <div className="space-y-2">
                      {actions.map((action, index) => (
                        <div key={index} className={`flex items-center justify-between p-3 rounded-lg ${editingActionIndex === index ? 'bg-primary/10 border-2 border-primary' : 'bg-muted'}`}>
                          <div className="flex items-center gap-2">
                            {getActionIcon(action.type)}
                            <span className="text-sm">{getActionDescription(action)}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <Button type="button" variant="ghost" size="sm" onClick={() => editAction(index)}>
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button type="button" variant="ghost" size="sm" onClick={() => removeAction(index)}>
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add New Action */}
                  <div className="space-y-4 p-4 border rounded-lg">
                    <div className="space-y-2">
                      <Label>Action Type</Label>
                      <Select 
                        value={currentAction?.type || ''} 
                        onValueChange={(value) => setCurrentAction({ type: value as any, config: {} })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select action type" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="send_email">Send Email</SelectItem>
                          <SelectItem value="send_sms">Send SMS/Text</SelectItem>
                          <SelectItem value="create_task">Create Task</SelectItem>
                          <SelectItem value="send_notification">Send Portal Notification</SelectItem>
                          <SelectItem value="update_claim_status">Change Claim Status</SelectItem>
                          <SelectItem value="call_webhook">Call Webhook (Zapier)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Email Config */}
                    {currentAction?.type === 'send_email' && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Send To (select multiple)</Label>
                          <div className="grid grid-cols-2 gap-2">
                            {[
                              { value: 'policyholder', label: 'Policyholder' },
                              { value: 'adjuster', label: 'Insurance Adjuster' },
                              { value: 'referrer', label: 'Referrer' },
                              { value: 'contractors', label: 'Assigned Contractors' }
                            ].map((recipientType) => (
                              <label key={recipientType.value} className="flex items-center gap-2 text-sm cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={currentAction.config.recipient_types?.includes(recipientType.value as any) || false}
                                  onChange={(e) => {
                                    const types = currentAction.config.recipient_types || [];
                                    const updated = e.target.checked
                                      ? [...types, recipientType.value as any]
                                      : types.filter(t => t !== recipientType.value);
                                    setCurrentAction({
                                      ...currentAction,
                                      config: { ...currentAction.config, recipient_types: updated }
                                    });
                                  }}
                                  className="rounded border-input"
                                />
                                {recipientType.label}
                              </label>
                            ))}
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Additional Email Addresses (optional)</Label>
                          <Input 
                            placeholder="e.g., manager@company.com, team@company.com"
                            value={currentAction.config.manual_emails_text ?? currentAction.config.manual_emails?.join(', ') ?? ''}
                            onChange={(e) => {
                              setCurrentAction({
                                ...currentAction,
                                config: { ...currentAction.config, manual_emails_text: e.target.value }
                              });
                            }}
                          />
                          <p className="text-xs text-muted-foreground">
                            Enter comma-separated email addresses to always include
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>Email Template (optional)</Label>
                          <Select 
                            value={currentAction.config.email_template_id || 'none'} 
                            onValueChange={(value) => {
                              if (value === 'none') {
                                setCurrentAction({
                                  ...currentAction,
                                  config: { 
                                    ...currentAction.config, 
                                    email_template_id: undefined,
                                    subject: '',
                                    message: ''
                                  }
                                });
                              } else {
                                const template = emailTemplates?.find(t => t.id === value);
                                if (template) {
                                  setCurrentAction({
                                    ...currentAction,
                                    config: { 
                                      ...currentAction.config, 
                                      email_template_id: value,
                                      subject: template.subject,
                                      message: template.body
                                    }
                                  });
                                }
                              }
                            }}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select a template or write custom" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">-- No template (custom) --</SelectItem>
                              {emailTemplates?.map((template) => (
                                <SelectItem key={template.id} value={template.id}>
                                  {template.name} {template.category && `(${template.category})`}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            Select a template to auto-fill subject and body, or write custom content below
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>Email Subject</Label>
                          <Input 
                            placeholder="e.g., Claim Status Update - ${claim.claim_number}"
                            value={currentAction.config.subject || ''}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, subject: e.target.value, email_template_id: undefined }
                            })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Email Body</Label>
                          <RichTextEditor
                            placeholder="Use ${field} for merge fields..."
                            rows={4}
                            value={currentAction.config.message || ''}
                            onChange={(value) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, message: value, email_template_id: undefined }
                            })}
                          />
                          <p className="text-xs text-muted-foreground">
                            Available: {'${policyholder}'}, {'${claim.claim_number}'}, {'${claim.status}'}, {'${claim.loss_type}'}
                            {(triggerType === 'inspection_scheduled' || triggerType === 'inspection_upcoming_24h') && (
                              <>
                                <br />
                                Inspection: {'${inspection.date}'}, {'${inspection.time}'}, {'${inspection.type}'}, {'${inspection.inspector}'}
                              </>
                            )}
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>Attach Files From Folders</Label>
                          <div className="grid grid-cols-2 gap-2">
                            {['Carrier Documents', 'Freedom Adjustment Documents', 'Invoicing', 'Certificate of Completion', 'Supporting Evidence', 'Mortgage Documents'].map((folder) => (
                              <label key={folder} className="flex items-center gap-2 text-sm cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={currentAction.config.attachment_folders?.includes(folder) || false}
                                  onChange={(e) => {
                                    const folders = currentAction.config.attachment_folders || [];
                                    const updated = e.target.checked
                                      ? [...folders, folder]
                                      : folders.filter(f => f !== folder);
                                    setCurrentAction({
                                      ...currentAction,
                                      config: { ...currentAction.config, attachment_folders: updated }
                                    });
                                  }}
                                  className="rounded border-input"
                                />
                                {folder}
                              </label>
                            ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Select folders to search for files
                          </p>
                        </div>
                        <div className="space-y-2">
                          <Label>File Name Patterns (optional)</Label>
                          <Input 
                            placeholder="e.g., Contract, Estimate, Invoice"
                            value={currentAction.config.file_name_patterns_text ?? currentAction.config.file_name_patterns?.join(', ') ?? ''}
                            onChange={(e) => {
                              setCurrentAction({
                                ...currentAction,
                                config: { ...currentAction.config, file_name_patterns_text: e.target.value }
                              });
                            }}
                            onBlur={(e) => {
                              const patterns = e.target.value
                                .split(',')
                                .map(p => p.trim())
                                .filter(p => p.length > 0);
                              setCurrentAction({
                                ...currentAction,
                                config: { 
                                  ...currentAction.config, 
                                  file_name_patterns: patterns.length > 0 ? patterns : undefined,
                                  file_name_patterns_text: e.target.value
                                }
                              });
                            }}
                          />
                          <p className="text-xs text-muted-foreground">
                            Comma-separated. Only files containing these words will be attached. Leave empty for all files.
                          </p>
                        </div>
                      </div>
                    )}

                    {/* SMS Config */}
                    {currentAction?.type === 'send_sms' && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Send To</Label>
                          <Select 
                            value={currentAction.config.recipient_type || ''} 
                            onValueChange={(value) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, recipient_type: value as any }
                            })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select recipient" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="policyholder">Policyholder</SelectItem>
                              <SelectItem value="adjuster">Insurance Adjuster</SelectItem>
                              <SelectItem value="contractors">Assigned Contractors</SelectItem>
                              <SelectItem value="claim_staff">Assigned Staff</SelectItem>
                              <SelectItem value="admins">All Admins</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        
                        {/* SMS Template Selection */}
                        {smsTemplates && smsTemplates.length > 0 && (
                          <div className="space-y-2">
                            <Label>Use SMS Template (optional)</Label>
                            <Select 
                              value={currentAction.config.sms_template_id || 'none'} 
                              onValueChange={(value) => {
                                const templateId = value === 'none' ? undefined : value;
                                const template = smsTemplates.find(t => t.id === templateId);
                                setCurrentAction({
                                  ...currentAction,
                                  config: { 
                                    ...currentAction.config, 
                                    sms_template_id: templateId,
                                    message: template ? template.body : currentAction.config.message
                                  }
                                });
                              }}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select a template..." />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">-- Custom Message --</SelectItem>
                                {smsTemplates.map((template) => (
                                  <SelectItem key={template.id} value={template.id}>
                                    {template.name} {template.category && `(${template.category})`}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                        
                        <div className="space-y-2">
                          <Label>Message</Label>
                          <Textarea 
                            placeholder="Use ${field} for merge fields..."
                            rows={3}
                            value={currentAction.config.message || ''}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, message: e.target.value, sms_template_id: undefined }
                            })}
                          />
                          <p className="text-xs text-muted-foreground">
                            Keep under 160 characters for best delivery.
                            {(triggerType === 'inspection_scheduled' || triggerType === 'inspection_upcoming_24h') && (
                              <>
                                {' '}Use {'${inspection.date}'}, {'${inspection.time}'}, {'${inspection.type}'} for inspection details.
                              </>
                            )}
                          </p>
                        </div>
                      </div>
                    )}

                    {/* Task Config */}
                    {currentAction?.type === 'create_task' && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Task Title</Label>
                          <Input 
                            placeholder="e.g., Follow up with policyholder"
                            value={currentAction.config.title || ''}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, title: e.target.value }
                            })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Task Description</Label>
                          <Textarea 
                            placeholder="Task details..."
                            rows={2}
                            value={currentAction.config.description || ''}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, description: e.target.value }
                            })}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <Label>Priority</Label>
                            <Select 
                              value={currentAction.config.priority || 'medium'} 
                              onValueChange={(value) => setCurrentAction({
                                ...currentAction,
                                config: { ...currentAction.config, priority: value as any }
                              })}
                            >
                              <SelectTrigger>
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
                            <Label>Due In (Days)</Label>
                            <Input 
                              type="number"
                              min="0"
                              placeholder="e.g., 3"
                              value={currentAction.config.due_date_offset || ''}
                              onChange={(e) => setCurrentAction({
                                ...currentAction,
                                config: { ...currentAction.config, due_date_offset: parseInt(e.target.value) }
                              })}
                            />
                          </div>
                        </div>
                        <div className="space-y-2">
                          <Label>Day Type</Label>
                          <Select 
                            value={currentAction.config.due_date_type || 'calendar'} 
                            onValueChange={(value) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, due_date_type: value as 'calendar' | 'business' }
                            })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="calendar">Calendar Days</SelectItem>
                              <SelectItem value="business">Business Days (Mon-Fri)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        
                        {/* Assignment Section */}
                        <div className="space-y-2">
                          <Label>Assign To</Label>
                          <Select 
                            value={currentAction.config.assign_to_type || 'none'} 
                            onValueChange={(value) => setCurrentAction({
                              ...currentAction,
                              config: { 
                                ...currentAction.config, 
                                assign_to_type: value as 'none' | 'user' | 'claim_contractor' | 'claim_staff',
                                assign_to_user_id: value === 'none' ? undefined : currentAction.config.assign_to_user_id
                              }
                            })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select assignment type" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Unassigned</SelectItem>
                              <SelectItem value="user">Specific User</SelectItem>
                              <SelectItem value="claim_staff">Claim's Assigned Staff</SelectItem>
                              <SelectItem value="claim_contractor">Claim's Assigned Contractor</SelectItem>
                            </SelectContent>
                          </Select>
                          <p className="text-xs text-muted-foreground">
                            Dynamically assigns to whoever is linked to the claim at execution time
                          </p>
                        </div>

                        {currentAction.config.assign_to_type === 'user' && (
                          <div className="space-y-2">
                            <Label>Select User</Label>
                            <Select 
                              value={currentAction.config.assign_to_user_id || ''} 
                              onValueChange={(value) => setCurrentAction({
                                ...currentAction,
                                config: { ...currentAction.config, assign_to_user_id: value }
                              })}
                            >
                              <SelectTrigger>
                                <SelectValue placeholder="Select a user" />
                              </SelectTrigger>
                              <SelectContent>
                                {users?.map((user) => (
                                  <SelectItem key={user.id} value={user.id}>
                                    {user.full_name || user.email}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Notification Config */}
                    {currentAction?.type === 'send_notification' && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Notification Message</Label>
                          <Textarea 
                            placeholder="Message to send to portal users..."
                            rows={3}
                            value={currentAction.config.message || ''}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, message: e.target.value }
                            })}
                          />
                        </div>
                      </div>
                    )}

                    {/* Status Change Config */}
                    {currentAction?.type === 'update_claim_status' && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Change Status To</Label>
                          <Select 
                            value={currentAction.config.new_status || ''} 
                            onValueChange={(value) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, new_status: value }
                            })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select new status" />
                            </SelectTrigger>
                            <SelectContent>
                              {statuses?.map((status) => (
                                <SelectItem key={status.id} value={status.name}>
                                  {status.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    )}

                    {/* Webhook Config */}
                    {currentAction?.type === 'call_webhook' && (
                      <div className="space-y-4">
                        <div className="space-y-2">
                          <Label>Zapier Webhook URL</Label>
                          <Input 
                            placeholder="https://hooks.zapier.com/hooks/catch/..."
                            value={currentAction.config.webhook_url || ''}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, webhook_url: e.target.value }
                            })}
                          />
                          <p className="text-xs text-muted-foreground">
                            Create a Zap with a Webhooks by Zapier trigger and paste the URL here. The webhook will receive claim data including policyholder info, claim number, and documents.
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            id="webhook_include_files"
                            checked={currentAction.config.webhook_include_files || false}
                            onChange={(e) => setCurrentAction({
                              ...currentAction,
                              config: { ...currentAction.config, webhook_include_files: e.target.checked }
                            })}
                            className="rounded border-input"
                          />
                          <Label htmlFor="webhook_include_files" className="text-sm font-normal cursor-pointer">
                            Include file URLs in webhook payload
                          </Label>
                        </div>
                        <div className="p-3 bg-muted rounded-lg text-sm">
                          <p className="font-medium mb-1">Webhook Payload Includes:</p>
                          <ul className="list-disc list-inside text-muted-foreground space-y-1">
                            <li>Claim details (number, status, loss type)</li>
                            <li>Policyholder info (name, email, address)</li>
                            <li>Insurance company details</li>
                            <li>Trigger data (e.g., new status)</li>
                            {currentAction.config.webhook_include_files && <li>Document file URLs</li>}
                          </ul>
                        </div>
                      </div>
                    )}

                    {currentAction?.type && (
                      <div className="flex gap-2">
                        {editingActionIndex !== null && (
                          <Button type="button" variant="ghost" onClick={cancelEditAction}>
                            Cancel
                          </Button>
                        )}
                        <Button type="button" variant="outline" onClick={saveAction}>
                          <Plus className="h-4 w-4 mr-2" />
                          {editingActionIndex !== null ? 'Update Action' : 'Add Action'}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={(createMutation.isPending || updateMutation.isPending) || actions.length === 0}>
                  {(createMutation.isPending || updateMutation.isPending) && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {editingId ? 'Save Changes' : 'Create Automation'}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Tabs defaultValue="automations">
        <TabsList>
          <TabsTrigger value="automations">Automations</TabsTrigger>
          <TabsTrigger value="history">Execution History</TabsTrigger>
        </TabsList>

        <TabsContent value="automations" className="space-y-4">
          {automations?.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No automations created yet. Click "New Automation" to get started.
              </CardContent>
            </Card>
          )}
          {automations?.map((automation) => (
            <Card key={automation.id}>
              <CardHeader>
                <div className="flex items-start justify-between">
                  <div>
                    <CardTitle>{automation.name}</CardTitle>
                    <CardDescription>{automation.description}</CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Switch
                      checked={automation.is_active}
                      onCheckedChange={(checked) =>
                        toggleMutation.mutate({ id: automation.id, is_active: checked })
                      }
                    />
                    {automation.trigger_type === 'manual' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => manualTriggerMutation.mutate(automation.id)}
                        disabled={!automation.is_active}
                      >
                        <Play className="h-4 w-4" />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => openEditDialog(automation)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => deleteMutation.mutate(automation.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2">
                    <Badge variant="outline" className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {getTriggerDescription(automation)}
                    </Badge>
                    <Badge variant={automation.is_active ? "default" : "secondary"}>
                      {automation.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  
                  {/* Show actions */}
                  {Array.isArray(automation.actions) && automation.actions.length > 0 && (
                    <div className="flex flex-wrap gap-2 pt-2">
                      {(automation.actions as unknown as ActionConfig[]).map((action, index) => (
                        <Badge key={index} variant="secondary" className="flex items-center gap-1">
                          {getActionIcon(action.type)}
                          <span className="text-xs">
                            {action.type === 'send_email' && 'Email'}
                            {action.type === 'send_sms' && 'SMS'}
                            {action.type === 'create_task' && 'Task'}
                            {action.type === 'send_notification' && 'Notification'}
                          </span>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="history" className="space-y-4">
          {executions?.length === 0 && (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                No execution history yet. Automations will appear here when they run.
              </CardContent>
            </Card>
          )}
          {executions?.map((execution: any) => (
            <Card key={execution.id}>
              <CardContent className="pt-6">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{execution.automation?.name}</div>
                    <div className="text-sm text-muted-foreground">
                      {new Date(execution.created_at).toLocaleString()}
                    </div>
                  </div>
                  <Badge
                    variant={
                      execution.status === 'success'
                        ? 'default'
                        : execution.status === 'failed'
                        ? 'destructive'
                        : 'secondary'
                    }
                  >
                    {execution.status}
                  </Badge>
                </div>
                {execution.error_message && (
                  <div className="mt-2 text-sm text-destructive">
                    Error: {execution.error_message}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
    </TabsContent>

        <TabsContent value="task-automations">
          <TaskAutomationsSettings />
        </TabsContent>

        <TabsContent value="global-settings">
          <AutomationGlobalSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
};
