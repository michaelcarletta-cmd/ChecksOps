import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useState, useEffect } from "react";
import { Plus, Send, MessageSquare, Loader2, Edit, Trash2, FileText, Phone, Mail, Users, ArrowUpRight, ArrowDownLeft, Copy, ListTodo, ExternalLink } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { TeamMemberSelect } from "./TeamMemberSelect";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { format } from "date-fns";
import { ClaimEmails } from "./ClaimEmails";
import { ClaimSMS } from "./ClaimSMS";

interface CommunicationEntry {
  id: string;
  communication_date: string;
  communication_type: string;
  direction: string;
  contact_name: string | null;
  contact_title: string | null;
  contact_company: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  employee_id: string | null;
  summary: string;
  promises_made: string | null;
  deadlines_mentioned: string | null;
  follow_up_required: boolean;
  follow_up_date: string | null;
}

const COMM_TYPES = [
  { value: "phone", label: "Phone Call", icon: Phone },
  { value: "email", label: "Email", icon: Mail },
  { value: "letter", label: "Letter/Mail", icon: FileText },
  { value: "in_person", label: "In Person", icon: Users },
  { value: "voicemail", label: "Voicemail", icon: Phone },
];

interface Update {
  id: string;
  content: string;
  created_at: string;
  user_id: string;
  recipients: any;
  profiles: {
    full_name: string | null;
    email: string;
  } | null;
}

interface Claim {
  client_id: string | null;
  referrer_id: string | null;
  claim_contractors: { contractor_id: string }[];
  policyholder_email: string | null;
  policyholder_name: string;
}

export const ClaimNotes = ({ claimId, claim: claimProp, isPortalUser = false }: { claimId: string; claim?: any; isPortalUser?: boolean }) => {
  const [updates, setUpdates] = useState<Update[]>([]);
  const [newUpdate, setNewUpdate] = useState("");
  const [useCustomTimestamp, setUseCustomTimestamp] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const [customTime, setCustomTime] = useState("");
  const [claim, setClaim] = useState<Claim | null>(null);
  const [notifyClient, setNotifyClient] = useState(false);
  const [notifyReferrer, setNotifyReferrer] = useState(false);
  const [notifyContractors, setNotifyContractors] = useState(false);
  const [notifyTeamMembers, setNotifyTeamMembers] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingUpdate, setEditingUpdate] = useState<Update | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Update | null>(null);
  const [createTask, setCreateTask] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [commEmail, setCommEmail] = useState(false);
  const [commPhone, setCommPhone] = useState(false);
  const [taskDueDate, setTaskDueDate] = useState("");
  const [taskPriority, setTaskPriority] = useState("medium");
  const { user, userRole } = useAuth();
  const isStaff = userRole === "admin" || userRole === "staff";

  // Communications Diary state
  const [commEntries, setCommEntries] = useState<CommunicationEntry[]>([]);
  const [commLoading, setCommLoading] = useState(true);
  const [commDialogOpen, setCommDialogOpen] = useState(false);
  const [commFormData, setCommFormData] = useState({
    communication_type: "phone",
    direction: "outbound",
    contact_name: "",
    contact_title: "",
    contact_company: "",
    contact_phone: "",
    contact_email: "",
    employee_id: "",
    summary: "",
    promises_made: "",
    deadlines_mentioned: "",
    follow_up_required: false,
    follow_up_date: "",
  });

  const fetchCommEntries = async () => {
    const { data, error } = await supabase
      .from("claim_communications_diary")
      .select("*")
      .eq("claim_id", claimId)
      .order("communication_date", { ascending: false });

    if (error) {
      console.error("Error fetching communications:", error);
    } else {
      setCommEntries(data || []);
    }
    setCommLoading(false);
  };

  const handleAddCommEntry = async () => {
    if (!commFormData.summary) {
      toast.error("Please provide a summary");
      return;
    }

    const { data: userData } = await supabase.auth.getUser();

    const { error } = await supabase.from("claim_communications_diary").insert({
      claim_id: claimId,
      communication_date: new Date().toISOString(),
      communication_type: commFormData.communication_type,
      direction: commFormData.direction,
      contact_name: commFormData.contact_name || null,
      contact_title: commFormData.contact_title || null,
      contact_company: commFormData.contact_company || null,
      contact_phone: commFormData.contact_phone || null,
      contact_email: commFormData.contact_email || null,
      employee_id: commFormData.employee_id || null,
      summary: commFormData.summary,
      promises_made: commFormData.promises_made || null,
      deadlines_mentioned: commFormData.deadlines_mentioned || null,
      follow_up_required: commFormData.follow_up_required,
      follow_up_date: commFormData.follow_up_date || null,
      created_by: userData.user?.id,
    });

    if (error) {
      toast.error("Failed to add entry");
      console.error(error);
    } else {
      const commType = COMM_TYPES.find(t => t.value === commFormData.communication_type)?.label || commFormData.communication_type;
      const direction = commFormData.direction === "outbound" ? "Outbound" : "Inbound";
      const contactInfo = commFormData.contact_name 
        ? `with ${commFormData.contact_name}${commFormData.contact_company ? ` (${commFormData.contact_company})` : ''}${commFormData.employee_id ? ` [ID: ${commFormData.employee_id}]` : ''}`
        : '';
      
      let noteContent = `📞 ${direction} ${commType} ${contactInfo}\n\n${commFormData.summary}`;
      
      if (commFormData.promises_made) {
        noteContent += `\n\n⚠️ CARRIER PROMISES: ${commFormData.promises_made}`;
      }
      if (commFormData.deadlines_mentioned) {
        noteContent += `\n\n📅 DEADLINES MENTIONED: ${commFormData.deadlines_mentioned}`;
      }

      await supabase.from("claim_updates").insert({
        claim_id: claimId,
        content: noteContent,
        update_type: "communication_log",
        user_id: userData.user?.id,
      });

      toast.success("Communication logged and added to notes");
      setCommDialogOpen(false);
      setCommFormData({
        communication_type: "phone",
        direction: "outbound",
        contact_name: "",
        contact_title: "",
        contact_company: "",
        contact_phone: "",
        contact_email: "",
        employee_id: "",
        summary: "",
        promises_made: "",
        deadlines_mentioned: "",
        follow_up_required: false,
        follow_up_date: "",
      });
      fetchCommEntries();
      fetchUpdates();
    }
  };

  const generateCommTimeline = () => {
    const timeline = commEntries.map(e => {
      const commType = COMM_TYPES.find(t => t.value === e.communication_type);
      return `${format(new Date(e.communication_date), "MM/dd/yyyy HH:mm")} - ${e.direction === "outbound" ? "OUTBOUND" : "INBOUND"} ${commType?.label || e.communication_type}
Contact: ${e.contact_name || "Unknown"}${e.employee_id ? ` (ID: ${e.employee_id})` : ""}${e.contact_company ? ` - ${e.contact_company}` : ""}
Summary: ${e.summary}${e.promises_made ? `\nPromises Made: ${e.promises_made}` : ""}${e.deadlines_mentioned ? `\nDeadlines Mentioned: ${e.deadlines_mentioned}` : ""}
---`;
    }).join("\n\n");

    const fullDoc = `COMMUNICATIONS DIARY
Claim: ${claim?.policyholder_name || claimId}
Generated: ${format(new Date(), "MM/dd/yyyy HH:mm")}

${timeline}`;

    navigator.clipboard.writeText(fullDoc);
    toast.success("Communications timeline copied to clipboard");
  };

  const getCommTypeIcon = (type: string) => {
    const commType = COMM_TYPES.find(t => t.value === type);
    const Icon = commType?.icon || MessageSquare;
    return <Icon className="h-4 w-4" />;
  };

  useEffect(() => {
    fetchUpdates();
    fetchClaim();
    fetchCommEntries();

    const channel = supabase
      .channel("claim-updates-changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "claim_updates",
          filter: `claim_id=eq.${claimId}`,
        },
        () => {
          fetchUpdates();
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [claimId]);

  const fetchClaim = async () => {
    const { data } = await supabase
      .from("claims")
      .select(`
        client_id,
        referrer_id,
        policyholder_email,
        policyholder_name,
        claim_contractors (contractor_id)
      `)
      .eq("id", claimId)
      .single();

    if (data) {
      setClaim(data);
    }
  };

  const fetchUpdates = async () => {
    const { data: updatesData } = await supabase
      .from("claim_updates")
      .select(`
        id,
        content,
        created_at,
        user_id,
        recipients
      `)
      .eq("claim_id", claimId)
      .order("created_at", { ascending: false });

    if (updatesData) {
      const userIds = [...new Set(updatesData.map((u) => u.user_id).filter(Boolean))];
      const { data: profilesData } = await supabase.from("profiles").select("id, full_name, email").in("id", userIds);

      const profilesMap = new Map(profilesData?.map((p) => [p.id, p]) || []);

      const updatesWithProfiles = updatesData.map((update) => ({
        ...update,
        profiles: update.user_id ? profilesMap.get(update.user_id) || null : null,
      }));

      setUpdates(updatesWithProfiles);
    }
  };

  const handleAddUpdate = async () => {
    if (!newUpdate.trim() || !user) return;

    if (useCustomTimestamp && (!customDate || !customTime)) {
      toast.error("Please select both a date and time for the note.");
      return;
    }

    setLoading(true);
    const recipients: string[] = [];

    if (claim) {
      if (notifyClient && claim.client_id) recipients.push(claim.client_id);
      if (notifyReferrer && claim.referrer_id) recipients.push(claim.referrer_id);
      if (notifyContractors) {
        claim.claim_contractors.forEach((cc) => recipients.push(cc.contractor_id));
      }
    }
    
    notifyTeamMembers.forEach((memberId) => {
      if (!recipients.includes(memberId)) {
        recipients.push(memberId);
      }
    });

    let createdAt: string | undefined;
    if (useCustomTimestamp && customDate && customTime) {
      const iso = new Date(`${customDate}T${customTime}:00`).toISOString();
      createdAt = iso;
    }

    const isCommunication = commEmail || commPhone;
    const methods: string[] = [];
    if (commEmail) methods.push('email');
    if (commPhone) methods.push('phone');

    const updateType = isCommunication ? "communication_log" : "note";
    const contentToSave = isCommunication
      ? JSON.stringify({ type: 'communication', methods, text: newUpdate })
      : newUpdate;

    const { data: update, error: updateError } = await supabase
      .from("claim_updates")
      .insert({
        claim_id: claimId,
        content: contentToSave,
        user_id: user.id,
        update_type: updateType,
        recipients: recipients,
        ...(createdAt ? { created_at: createdAt } : {}),
      })
      .select()
      .single();

    if (updateError) {
      toast.error("Failed to add update");
      setLoading(false);
      return;
    }

    if (recipients.length > 0 && update) {
      const notifications = recipients.map((recipient) => ({
        user_id: recipient,
        claim_id: claimId,
        update_id: update.id,
      }));

      await supabase.from("notifications").insert(notifications);
    }

    // Create task if toggled
    if (createTask && taskTitle.trim()) {
      const { error: taskError } = await supabase.from("tasks").insert({
        claim_id: claimId,
        title: taskTitle.trim(),
        description: newUpdate.trim(),
        due_date: taskDueDate || null,
        priority: taskPriority,
        created_by: user.id,
      });

      if (taskError) {
        console.error("Error creating task:", taskError);
        toast.error("Note added but failed to create task");
      } else {
        toast.success("Note added & task created");
      }
    } else {
      toast.success("Update added successfully");
    }

    setNewUpdate("");
    setUseCustomTimestamp(false);
    setCustomDate("");
    setCustomTime("");
    setNotifyClient(false);
    setNotifyReferrer(false);
    setNotifyContractors(false);
    setNotifyTeamMembers([]);
    setCreateTask(false);
    setTaskTitle("");
    setTaskDueDate("");
    setTaskPriority("medium");
    setCommEmail(false);
    setCommPhone(false);
    setLoading(false);
    fetchUpdates();
  };

  const handleEditUpdate = (update: Update) => {
    setEditingUpdate(update);
    setEditContent(update.content);
    setEditDialogOpen(true);
  };

  const handleSaveEdit = async () => {
    if (!editingUpdate || !editContent.trim()) return;

    try {
      const { error } = await supabase
        .from("claim_updates")
        .update({ content: editContent })
        .eq("id", editingUpdate.id);

      if (error) throw error;

      toast.success("Update edited successfully");
      setEditDialogOpen(false);
      setEditingUpdate(null);
      setEditContent("");
      fetchUpdates();
    } catch (error: any) {
      console.error("Error editing update:", error);
      toast.error("Failed to edit update");
    }
  };

  const handleDeleteUpdate = async (updateId: string) => {
    if (!updateId) {
      toast.error("Unable to delete this note. Please refresh and try again.");
      return;
    }

    try {
      const { error } = await supabase
        .from("claim_updates")
        .delete()
        .eq("id", updateId);

      if (error) throw error;

      setUpdates((prev) => prev.filter((update) => update.id !== updateId));
      toast.success("Update deleted successfully");
      fetchUpdates();
    } catch (error: any) {
      console.error("Error deleting update:", error);
      toast.error(error?.message || "Failed to delete update");
    }
  };

  return (
    <>
      <Tabs defaultValue="notes" className="w-full">
        <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1 overflow-x-auto scrollbar-hide mb-6">
          <TabsTrigger value="notes" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            Notes & Updates
          </TabsTrigger>
          {!isPortalUser && (
            <>
              <TabsTrigger value="emails" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap flex items-center gap-2">
                <Mail className="h-4 w-4" />
                Emails
              </TabsTrigger>
              <TabsTrigger value="sms" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap flex items-center gap-2">
                <MessageSquare className="h-4 w-4" />
                SMS / Text
              </TabsTrigger>
            </>
          )}
        </TabsList>

        <TabsContent value="notes" className="space-y-6">
          <div className="space-y-3">
            <Textarea
              placeholder="Add a note or update..."
              value={newUpdate}
              onChange={(e) => setNewUpdate(e.target.value)}
              className="min-h-[100px]"
            />

            <div className="space-y-2">
              <Label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer rounded px-1 py-0.5 hover:bg-muted/50 transition-colors w-fit">
                <Checkbox
                  checked={commEmail}
                  onCheckedChange={(checked) => setCommEmail(checked as boolean)}
                />
                📧 Email made/attempted
              </Label>
              <Label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer rounded px-1 py-0.5 hover:bg-muted/50 transition-colors w-fit">
                <Checkbox
                  checked={commPhone}
                  onCheckedChange={(checked) => setCommPhone(checked as boolean)}
                />
                ☎️ Phone call made/attempted
              </Label>
            </div>

            <div className="grid gap-2 sm:grid-cols-2 items-end">
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    id="custom-timestamp"
                    checked={useCustomTimestamp}
                    onCheckedChange={(checked) => setUseCustomTimestamp(checked as boolean)}
                  />
                  Use custom date & time
                </Label>
                {useCustomTimestamp && (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      type="date"
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                    />
                    <Input
                      type="time"
                      value={customTime}
                      onChange={(e) => setCustomTime(e.target.value)}
                    />
                  </div>
                )}
              </div>

              {/* Create Task Toggle */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    id="create-task"
                    checked={createTask}
                    onCheckedChange={(checked) => setCreateTask(checked as boolean)}
                  />
                  <ListTodo className="h-4 w-4" />
                  Also create a task
                </Label>
                {createTask && (
                  <div className="flex flex-col gap-2 pl-6">
                    <Input
                      placeholder="Task title *"
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                    />
                    <div className="flex flex-col sm:flex-row gap-2">
                      <Input
                        type="date"
                        placeholder="Due date"
                        value={taskDueDate}
                        onChange={(e) => setTaskDueDate(e.target.value)}
                      />
                      <Select value={taskPriority} onValueChange={setTaskPriority}>
                        <SelectTrigger>
                          <SelectValue placeholder="Priority" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                          <SelectItem value="urgent">Urgent</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                )}
              </div>

              <Button
                onClick={handleAddUpdate}
                disabled={loading || !newUpdate.trim() || (createTask && !taskTitle.trim())}
                className="w-full sm:w-auto bg-primary hover:bg-primary/90 justify-center"
              >
                <Send className="h-4 w-4 mr-2" />
                {loading ? "Sending..." : "Add Update"}
              </Button>
            </div>

            {isStaff && claim && (
              <div className="space-y-2 p-3 rounded-lg bg-muted/30">
                <Label className="text-sm font-medium">Notify:</Label>
                <div className="flex flex-wrap gap-4">
                  {(claim.client_id || claim.policyholder_email) && (
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="notify-client"
                        checked={notifyClient}
                        onCheckedChange={(checked) => setNotifyClient(checked as boolean)}
                      />
                      <Label htmlFor="notify-client" className="text-sm cursor-pointer">
                        Client/Policyholder
                      </Label>
                    </div>
                  )}
                  {claim.referrer_id && (
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="notify-referrer"
                        checked={notifyReferrer}
                        onCheckedChange={(checked) => setNotifyReferrer(checked as boolean)}
                      />
                      <Label htmlFor="notify-referrer" className="text-sm cursor-pointer">
                        Referrer
                      </Label>
                    </div>
                  )}
                  {claim.claim_contractors.length > 0 && (
                    <div className="flex items-center space-x-2">
                      <Checkbox
                        id="notify-contractors"
                        checked={notifyContractors}
                        onCheckedChange={(checked) => setNotifyContractors(checked as boolean)}
                      />
                      <Label htmlFor="notify-contractors" className="text-sm cursor-pointer">
                        Contractors
                      </Label>
                    </div>
                  )}
                </div>
                
                <TeamMemberSelect
                  selectedMembers={notifyTeamMembers}
                  onSelectionChange={setNotifyTeamMembers}
                  disabled={loading}
                />
              </div>
            )}
          </div>

          <div className="space-y-4">
            {updates.map((update) => {
              const isCurrentUser = user?.id === update.user_id;
              const authorName = isCurrentUser
                ? "You"
                : update.profiles?.full_name || update.profiles?.email || "Unknown";

              return (
                <div key={update.id} className="flex gap-3 p-4 rounded-lg bg-muted/50 animate-in fade-in duration-150">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs">
                      {authorName.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{authorName}</span>
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(update.created_at), "MMM d, yyyy h:mm a")}
                        </span>
                        {(() => {
                          let commMethods: string[] = [];
                          try {
                            const parsed = JSON.parse(update.content);
                            if (parsed?.type === 'communication' && Array.isArray(parsed.methods)) {
                              commMethods = parsed.methods;
                            }
                          } catch {}
                          return commMethods.length > 0 ? (
                            <>
                              {commMethods.includes('email') && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                                  📧 Email
                                </span>
                              )}
                              {commMethods.includes('phone') && (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300">
                                  ☎️ Phone
                                </span>
                              )}
                            </>
                          ) : null;
                        })()}
                      </div>
                      <div className="flex items-center gap-2">
                        {(isStaff || isCurrentUser) && (
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6"
                              onClick={() => handleEditUpdate(update)}
                            >
                              <Edit className="h-3 w-3" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              onClick={() => handleDeleteUpdate(update.id)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="text-sm text-foreground whitespace-pre-wrap">
                      {(() => {
                        try {
                          const parsed = JSON.parse(update.content);
                          if (parsed?.type === 'communication' && parsed.text) {
                            return parsed.text;
                          }
                        } catch {}
                        return update.content;
                      })()}
                    </p>
                    {update.recipients && update.recipients.length > 0 && isStaff && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Notified {update.recipients.length}{" "}
                        {update.recipients.length === 1 ? "person" : "people"}
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
            {updates.length === 0 && (
              <div className="text-center text-sm text-muted-foreground py-8">
                No updates yet. Add the first update to this claim.
              </div>
            )}
          </div>
        </TabsContent>

        <TabsContent value="communications" className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold flex items-center gap-2">
                <Phone className="h-5 w-5 text-primary" />
                Communications Log
              </h3>
              <p className="text-sm text-muted-foreground">
                Log all adjuster interactions for bad faith documentation (PA/NJ)
              </p>
            </div>
            <div className="flex gap-2">
              {commEntries.length > 0 && (
                <Button variant="outline" size="sm" onClick={generateCommTimeline}>
                  <Copy className="h-4 w-4 mr-1" /> Export Timeline
                </Button>
              )}
              <Dialog open={commDialogOpen} onOpenChange={setCommDialogOpen}>
                <DialogTrigger asChild>
                  <Button size="sm">
                    <Plus className="h-4 w-4 mr-1" /> Log Communication
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-w-lg">
                  <DialogHeader>
                    <DialogTitle>Log Communication</DialogTitle>
                  </DialogHeader>
                  <ScrollArea className="max-h-[70vh]">
                    <div className="space-y-4 pr-4">
                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Type *</Label>
                          <Select
                            value={commFormData.communication_type}
                            onValueChange={(v) => setCommFormData({ ...commFormData, communication_type: v })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {COMM_TYPES.map((type) => (
                                <SelectItem key={type.value} value={type.value}>
                                  {type.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Direction *</Label>
                          <Select
                            value={commFormData.direction}
                            onValueChange={(v) => setCommFormData({ ...commFormData, direction: v })}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="outbound">Outbound (We called/wrote)</SelectItem>
                              <SelectItem value="inbound">Inbound (They called/wrote)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Contact Name</Label>
                          <Input
                            placeholder="John Smith"
                            value={commFormData.contact_name}
                            onChange={(e) => setCommFormData({ ...commFormData, contact_name: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Employee ID</Label>
                          <Input
                            placeholder="EMP12345"
                            value={commFormData.employee_id}
                            onChange={(e) => setCommFormData({ ...commFormData, employee_id: e.target.value })}
                          />
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Title/Role</Label>
                          <Input
                            placeholder="Claims Adjuster"
                            value={commFormData.contact_title}
                            onChange={(e) => setCommFormData({ ...commFormData, contact_title: e.target.value })}
                          />
                        </div>
                        <div className="space-y-2">
                          <Label>Company</Label>
                          <Input
                            placeholder="State Farm"
                            value={commFormData.contact_company}
                            onChange={(e) => setCommFormData({ ...commFormData, contact_company: e.target.value })}
                          />
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label>Summary of Conversation *</Label>
                        <Textarea
                          placeholder="Detailed notes about what was discussed..."
                          className="min-h-[100px]"
                          value={commFormData.summary}
                          onChange={(e) => setCommFormData({ ...commFormData, summary: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Promises Made by Carrier</Label>
                        <Textarea
                          placeholder="Any commitments, timelines, or promises made..."
                          value={commFormData.promises_made}
                          onChange={(e) => setCommFormData({ ...commFormData, promises_made: e.target.value })}
                        />
                      </div>

                      <div className="space-y-2">
                        <Label>Deadlines Mentioned</Label>
                        <Input
                          placeholder="e.g., 'Will have decision by Friday'"
                          value={commFormData.deadlines_mentioned}
                          onChange={(e) => setCommFormData({ ...commFormData, deadlines_mentioned: e.target.value })}
                        />
                      </div>

                      <Button onClick={handleAddCommEntry} className="w-full">
                        Log Communication
                      </Button>
                    </div>
                  </ScrollArea>
                </DialogContent>
              </Dialog>
            </div>
          </div>

          {commLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin h-6 w-6 border-2 border-primary border-t-transparent rounded-full" />
            </div>
          ) : commEntries.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Phone className="h-12 w-12 mx-auto mb-2 opacity-50" />
              <p>No communications logged yet</p>
              <p className="text-sm">Document all interactions for potential bad faith claims</p>
            </div>
          ) : (
            <ScrollArea className="h-[400px]">
              <div className="space-y-4">
                {commEntries.map((entry) => (
                  <div key={entry.id} className="border rounded-lg p-4">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-full ${entry.direction === "outbound" ? "bg-primary/10" : "bg-accent"}`}>
                        {getCommTypeIcon(entry.communication_type)}
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">
                            {COMM_TYPES.find(t => t.value === entry.communication_type)?.label}
                          </span>
                          <Badge variant="outline" className="text-xs">
                            {entry.direction === "outbound" ? (
                              <><ArrowUpRight className="h-3 w-3 mr-1" /> Outbound</>
                            ) : (
                              <><ArrowDownLeft className="h-3 w-3 mr-1" /> Inbound</>
                            )}
                          </Badge>
                          <span className="text-sm text-muted-foreground">
                            {format(new Date(entry.communication_date), "MMM d, yyyy h:mm a")}
                          </span>
                        </div>
                        {entry.contact_name && (
                          <p className="text-sm text-muted-foreground mt-1">
                            Contact: <span className="font-medium">{entry.contact_name}</span>
                            {entry.employee_id && <span> (ID: {entry.employee_id})</span>}
                            {entry.contact_company && <span> — {entry.contact_company}</span>}
                          </p>
                        )}
                        <p className="mt-2">{entry.summary}</p>
                        {entry.promises_made && (
                          <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                            <strong>Promises Made:</strong> {entry.promises_made}
                          </p>
                        )}
                        {entry.deadlines_mentioned && (
                          <p className="text-sm text-blue-700 dark:text-blue-400">
                            <strong>Deadlines:</strong> {entry.deadlines_mentioned}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </TabsContent>

        {!isPortalUser && claimProp && (
          <TabsContent value="emails" className="mt-6">
            <ClaimEmails claimId={claimId} claim={claimProp} />
          </TabsContent>
        )}

        {!isPortalUser && claimProp && (
          <TabsContent value="sms" className="mt-6">
            <ClaimSMS claimId={claimId} policyholderPhone={claimProp.policyholder_phone} />
          </TabsContent>
        )}
      </Tabs>

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Update</DialogTitle>
          </DialogHeader>
          <Textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="min-h-[150px] mt-4"
          />
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} className="bg-primary hover:bg-primary/90">
              Save Changes
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete note?</AlertDialogTitle>
            <AlertDialogDescription>
              This note will be permanently removed from the claim activity history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (deleteTarget) {
                  await handleDeleteUpdate(deleteTarget.id);
                  setDeleteTarget(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
