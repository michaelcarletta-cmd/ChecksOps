import { useState, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Plus, Trash2, GripVertical, ChevronDown, FolderKanban, FileSignature, ListTree, HelpCircle, Sparkles, TrendingUp, ShieldCheck, Cog, UserCog, Mail, Database, History, Bell, Activity, Cloud, Key, Share2, Receipt, Users, BarChart3 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { SectionCard } from "@/components/settings/SectionCard";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { LossTypesSettings } from "@/components/settings/LossTypesSettings";
import { AutomationsSettings } from "@/components/settings/AutomationsSettings";
import { CustomFieldsSettings } from "@/components/settings/CustomFieldsSettings";
import { SignaturePresetsSettings } from "@/components/settings/SignaturePresetsSettings";
// Moov settings hidden
import { usePaymentRail } from "@/hooks/usePaymentRail";
import { ReferralSettings } from "@/components/settings/ReferralSettings";
import { AdminReferralDashboard } from "@/components/settings/AdminReferralDashboard";


import { ImportSettings } from "@/components/settings/ImportSettings";
import { UserManagementSettings } from "@/components/settings/UserManagementSettings";
import { ProfileSettings } from "@/components/settings/ProfileSettings";
import { CheckCenterHelpPanel } from "@/components/check-review/CheckCenterHelp";
import { AIKnowledgeBaseSettings } from "@/components/settings/AIKnowledgeBaseSettings";
import { CounterArgumentsSettings } from "@/components/settings/CounterArgumentsSettings";
import { QuickBooksSettings } from "@/components/settings/QuickBooksSettings";
import { BackupStatusSettings } from "@/components/settings/BackupStatusSettings";
import { ZapierIntegrationSettings } from "@/components/settings/ZapierIntegrationSettings";
import { OrganizationSettings } from "@/components/settings/OrganizationSettings";
import { CompanyBrandingSettings } from "@/components/settings/CompanyBrandingSettings";
import { EmailSenderSettings } from "@/components/settings/EmailSenderSettings";
import { TenantEmailHealthPanel } from "@/components/settings/TenantEmailHealthPanel";
import { AuditLogSettings } from "@/components/settings/AuditLogSettings";
import { NotificationDeliveryLogView } from "@/components/settings/NotificationDeliveryLogView";
import StatusUrgencyNotificationsSettings from "@/components/settings/StatusUrgencyNotificationsSettings";
import { JobNimbusSyncDiagnostics } from "@/components/settings/JobNimbusSyncDiagnostics";
import { TenantManagement } from "@/components/settings/TenantManagement";
import { TeamCapsSettings } from "@/components/settings/TeamCapsSettings";
import { UsageLogTab } from "@/components/payments/UsageLogTab";
import { useTenant } from "@/contexts/TenantContext";


import { useQuery } from "@tanstack/react-query";
import { WorkspaceList } from "@/components/workspaces/WorkspaceList";

import { RDAutomationSettings } from "@/components/settings/RDAutomationSettings";
import { OutlookConnectionSettings } from "@/components/settings/OutlookConnectionSettings";
import { PhoneVerificationSettings } from "@/components/settings/PhoneVerificationSettings";
import { CheckAltSettings } from "@/components/settings/CheckAltSettings";
import { SHOW_CHECKALT } from "@/lib/depositRails";

interface ClaimStatus {
  id: string;
  name: string;
  color: string;
  gradient: string | null;
  display_order: number;
  is_active: boolean;
}

interface SubStatus {
  id: string;
  parent_status_id: string;
  name: string;
  display_order: number;
  is_active: boolean;
}

interface SortableStatusRowProps {
  status: ClaimStatus;
  onUpdateName: (id: string, name: string) => void;
  onUpdateColor: (id: string, color: string) => void;
  onUpdateGradient: (id: string, gradient: string | null) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

function SortableSubStatusItem({ sub, index, onUpdateName, onDelete }: { sub: SubStatus; index: number; onUpdateName: (id: string, name: string) => void; onDelete: (id: string) => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sub.id });
  const style = { transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 };
  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 bg-muted/40 rounded px-2 py-1.5">
      <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing flex-shrink-0">
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <span className="text-xs text-muted-foreground w-5 text-center">{index + 1}.</span>
      <Input
        value={sub.name}
        onChange={(e) => onUpdateName(sub.id, e.target.value)}
        className="h-7 text-xs flex-1 bg-transparent border-none focus-visible:ring-1"
      />
      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onDelete(sub.id)}>
        <Trash2 className="h-3 w-3 text-muted-foreground" />
      </Button>
    </div>
  );
}

function SubStatusSortableList({ subStatuses, setSubStatuses, onUpdateName, onDelete }: { subStatuses: SubStatus[]; setSubStatuses: React.Dispatch<React.SetStateAction<SubStatus[]>>; onUpdateName: (id: string, name: string) => void; onDelete: (id: string) => void }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = subStatuses.findIndex(s => s.id === active.id);
    const newIndex = subStatuses.findIndex(s => s.id === over.id);
    const reordered = arrayMove(subStatuses, oldIndex, newIndex);
    setSubStatuses(reordered);
    const updates = reordered.map((s, i) =>
      supabase.from("claim_sub_statuses").update({ display_order: i }).eq("id", s.id)
    );
    await Promise.all(updates);
  };

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={subStatuses.map(s => s.id)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1">
          {subStatuses.map((sub, idx) => (
            <SortableSubStatusItem key={sub.id} sub={sub} index={idx} onUpdateName={onUpdateName} onDelete={onDelete} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}


const PRESET_GRADIENTS = [
  // Blues & Purples
  { label: "Ocean", value: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)" },
  { label: "Sky", value: "linear-gradient(135deg, #89f7fe 0%, #66a6ff 100%)" },
  { label: "Berry", value: "linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)" },
  { label: "Royal", value: "linear-gradient(135deg, #6a11cb 0%, #2575fc 100%)" },
  { label: "Indigo", value: "linear-gradient(135deg, #4338ca 0%, #818cf8 100%)" },
  { label: "Violet", value: "linear-gradient(135deg, #7c3aed 0%, #c084fc 100%)" },
  // Reds & Pinks
  { label: "Sunset", value: "linear-gradient(135deg, #f093fb 0%, #f5576c 100%)" },
  { label: "Fire", value: "linear-gradient(135deg, #f12711 0%, #f5af19 100%)" },
  { label: "Rose", value: "linear-gradient(135deg, #ee9ca7 0%, #ffdde1 100%)" },
  { label: "Cherry", value: "linear-gradient(135deg, #eb3349 0%, #f45c43 100%)" },
  { label: "Coral", value: "linear-gradient(135deg, #ff6a88 0%, #ff99ac 100%)" },
  // Greens & Teals
  { label: "Emerald", value: "linear-gradient(135deg, #11998e 0%, #38ef7d 100%)" },
  { label: "Mint", value: "linear-gradient(135deg, #0cebeb 0%, #20e3b2 100%)" },
  { label: "Forest", value: "linear-gradient(135deg, #134e5e 0%, #71b280 100%)" },
  { label: "Lime", value: "linear-gradient(135deg, #56ab2f 0%, #a8e063 100%)" },
  // Warm tones
  { label: "Gold", value: "linear-gradient(135deg, #f7971e 0%, #ffd200 100%)" },
  { label: "Amber", value: "linear-gradient(135deg, #f09819 0%, #edde5d 100%)" },
  { label: "Peach", value: "linear-gradient(135deg, #ffecd2 0%, #fcb69f 100%)" },
  { label: "Bronze", value: "linear-gradient(135deg, #b8860b 0%, #daa520 100%)" },
  // Neutrals & Dark
  { label: "Slate", value: "linear-gradient(135deg, #868f96 0%, #596164 100%)" },
  { label: "Steel", value: "linear-gradient(135deg, #2c3e50 0%, #4ca1af 100%)" },
  { label: "Charcoal", value: "linear-gradient(135deg, #232526 0%, #414345 100%)" },
  { label: "Midnight", value: "linear-gradient(135deg, #0f0c29 0%, #302b63 100%)" },
];

function SortableStatusRow({ status, onUpdateName, onUpdateColor, onUpdateGradient, onDelete, onRefresh }: SortableStatusRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.id });

  const [useGradient, setUseGradient] = useState(!!status.gradient);
  const [customGradient, setCustomGradient] = useState(status.gradient || "");
  const [colorOpen, setColorOpen] = useState(false);
  const [subStatusesOpen, setSubStatusesOpen] = useState(false);
  const [subStatuses, setSubStatuses] = useState<SubStatus[]>([]);
  const [newSubName, setNewSubName] = useState("");
  const [loadingSubs, setLoadingSubs] = useState(false);
  const { toast } = useToast();

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const bgStyle = status.gradient
    ? { background: status.gradient }
    : { backgroundColor: status.color };

  const fetchSubStatuses = async () => {
    setLoadingSubs(true);
    const { data, error } = await supabase
      .from("claim_sub_statuses")
      .select("*")
      .eq("parent_status_id", status.id)
      .order("display_order");
    if (!error) setSubStatuses(data || []);
    setLoadingSubs(false);
  };

  const addSubStatus = async () => {
    const name = newSubName.trim();
    if (!name) return;
    const maxOrder = subStatuses.length > 0 ? Math.max(...subStatuses.map(s => s.display_order)) + 1 : 0;
    const { error } = await supabase
      .from("claim_sub_statuses")
      .insert({ parent_status_id: status.id, name, display_order: maxOrder });
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      setNewSubName("");
      fetchSubStatuses();
    }
  };

  const deleteSubStatus = async (id: string) => {
    const { error } = await supabase.from("claim_sub_statuses").delete().eq("id", id);
    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } else {
      fetchSubStatuses();
    }
  };

  const updateSubName = async (id: string, name: string) => {
    await supabase.from("claim_sub_statuses").update({ name }).eq("id", id);
    setSubStatuses(prev => prev.map(s => s.id === id ? { ...s, name } : s));
  };

  useEffect(() => {
    if (subStatusesOpen) fetchSubStatuses();
  }, [subStatusesOpen]);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border rounded-lg p-3 mb-2 bg-card space-y-2"
    >
      <div className="flex items-center gap-2">
        <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing flex-shrink-0">
          <GripVertical className="h-4 w-4 text-muted-foreground" />
        </div>
        <div
          className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold text-white shadow-sm flex-shrink-0"
          style={bgStyle}
        >
          {status.name}
        </div>
        <div className="flex-1" />
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs gap-1"
          onClick={() => setSubStatusesOpen(!subStatusesOpen)}
        >
          <ListTree className="h-3 w-3" />
          {subStatusesOpen ? "Hide" : "Sub-steps"}
          {subStatuses.length > 0 && !subStatusesOpen && (
            <span className="ml-1 text-[10px] bg-primary/10 text-primary rounded-full px-1.5">{subStatuses.length}</span>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs gap-1"
          onClick={() => setColorOpen(!colorOpen)}
        >
          <div className="w-3 h-3 rounded-full border flex-shrink-0" style={bgStyle} />
          {colorOpen ? "Hide" : "Color"}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 flex-shrink-0"
          onClick={() => onDelete(status.id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <Input
        value={status.name}
        onChange={(e) => onUpdateName(status.id, e.target.value)}
        onBlur={onRefresh}
        className="h-8 text-sm"
        placeholder="Status name"
      />

      {/* Sub-statuses panel */}
      {subStatusesOpen && (
        <div className="space-y-2 pt-2 border-t">
          <p className="text-xs font-medium text-muted-foreground">Sub-steps for "{status.name}" (drag to reorder)</p>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Inspection, Prepare Estimate..."
              value={newSubName}
              onChange={(e) => setNewSubName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addSubStatus()}
              className="h-8 text-sm flex-1"
            />
            <Button onClick={addSubStatus} size="sm" className="h-8 whitespace-nowrap">
              <Plus className="h-3.5 w-3.5 mr-1" />
              Add
            </Button>
          </div>
          {loadingSubs ? (
            <p className="text-xs text-muted-foreground">Loading...</p>
          ) : subStatuses.length === 0 ? (
            <p className="text-xs text-muted-foreground italic">No sub-steps yet. Add steps that happen within this status.</p>
          ) : (
            <SubStatusSortableList
              subStatuses={subStatuses}
              setSubStatuses={setSubStatuses}
              onUpdateName={updateSubName}
              onDelete={deleteSubStatus}
            />
          )}
        </div>
      )}

      {colorOpen && (
        <div className="space-y-2 pt-1 border-t">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name={`colorMode-${status.id}`}
                checked={!useGradient}
                onChange={() => {
                  setUseGradient(false);
                  onUpdateGradient(status.id, null);
                }}
                className="accent-primary"
              />
              Solid
            </label>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input
                type="radio"
                name={`colorMode-${status.id}`}
                checked={useGradient}
                onChange={() => {
                  setUseGradient(true);
                  if (!customGradient) {
                    const preset = PRESET_GRADIENTS[0].value;
                    setCustomGradient(preset);
                    onUpdateGradient(status.id, preset);
                  } else {
                    onUpdateGradient(status.id, customGradient);
                  }
                }}
                className="accent-primary"
              />
              Gradient
            </label>
          </div>

          {!useGradient ? (
            <div className="flex items-center gap-2">
              <Input
                type="color"
                value={status.color}
                onChange={(e) => onUpdateColor(status.id, e.target.value)}
                className="w-10 h-8 p-1 cursor-pointer"
              />
              <span className="text-xs text-muted-foreground font-mono">{status.color}</span>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="grid grid-cols-12 gap-1">
                {PRESET_GRADIENTS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    title={preset.label}
                    onClick={() => {
                      setCustomGradient(preset.value);
                      onUpdateGradient(status.id, preset.value);
                    }}
                    className={`w-full aspect-square rounded-full border-2 transition-all ${
                      customGradient === preset.value ? "border-primary scale-110 ring-2 ring-primary/30" : "border-transparent hover:border-border"
                    }`}
                    style={{ background: preset.value }}
                  />
                ))}
              </div>
              <Input
                value={customGradient}
                onChange={(e) => setCustomGradient(e.target.value)}
                onBlur={() => onUpdateGradient(status.id, customGradient)}
                placeholder="linear-gradient(135deg, #color1, #color2)"
                className="h-7 text-xs font-mono"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const [statuses, setStatuses] = useState<ClaimStatus[]>([]);
  const [newStatusName, setNewStatusName] = useState("");
  const [newStatusColor, setNewStatusColor] = useState("#3B82F6");
  const [statusesOpen, setStatusesOpen] = useState(false);
  const [lossTypesOpen, setLossTypesOpen] = useState(false);
  const [customFieldsOpen, setCustomFieldsOpen] = useState(false);
  const [integrationsOpen, setIntegrationsOpen] = useState(false);
  const [companyBrandingOpen, setCompanyBrandingOpen] = useState(false);
  const [workspacesOpen, setWorkspacesOpen] = useState(false);
  const [sigPresetsOpen, setSigPresetsOpen] = useState(false);
  
  const [searchParams] = useSearchParams();
  const [activeTab, setActiveTab] = useState(searchParams.get("tab") || "workflow");
  
  const { toast } = useToast();
  const { tenant } = useTenant();

  useEffect(() => {
    const tab = searchParams.get("tab");
    const section = searchParams.get("section");
    
    if (tab) {
      setActiveTab(tab);
      if (tab === "organization" || section === "branding") {
        setCompanyBrandingOpen(true);
      }
    } else if (section === "branding") {
      setActiveTab("organization");
      setCompanyBrandingOpen(true);
    }
  }, [searchParams]);


  // Check if current user is admin
  const { data: isAdmin, isLoading: isAdminLoading } = useQuery({
    queryKey: ["is-admin-settings"],
    queryFn: async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return false;
      
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .eq("role", "admin")
        .maybeSingle();
      
      return !!data;
    },
  });

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  useEffect(() => {
    fetchStatuses();
  }, []);

  const fetchStatuses = async () => {
    try {
      const { data, error } = await supabase
        .from("claim_statuses")
        .select("*")
        .order("display_order");

      if (error) throw error;
      setStatuses(data || []);
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const addStatus = async () => {
    const trimmedName = newStatusName.trim();
    const nameToUse = trimmedName || "New Status";

    try {
      const maxOrder = Math.max(...statuses.map((s) => s.display_order), 0);

      const { data, error } = await supabase
        .from("claim_statuses")
        .insert({
          name: nameToUse,
          color: newStatusColor,
          display_order: maxOrder + 1,
        })
        .select();

      if (error) throw error;

      toast({
        title: "Success",
        description: "Status added successfully",
      });

      setNewStatusName("");
      setNewStatusColor("#3B82F6");
      fetchStatuses();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message || "Failed to add status",
        variant: "destructive",
      });
    }
  };

  const deleteStatus = async (id: string) => {
    try {
      const { error } = await supabase
        .from("claim_statuses")
        .delete()
        .eq("id", id);

      if (error) throw error;

      toast({
        title: "Success",
        description: "Status deleted successfully",
      });

      fetchStatuses();
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const updateStatusName = async (id: string, newName: string) => {
    try {
      const { error } = await supabase
        .from("claim_statuses")
        .update({ name: newName })
        .eq("id", id);

      if (error) throw error;

      setStatuses(statuses.map(s => s.id === id ? { ...s, name: newName } : s));
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const updateStatusColor = async (id: string, newColor: string) => {
    try {
      const { error } = await supabase
        .from("claim_statuses")
        .update({ color: newColor })
        .eq("id", id);

      if (error) throw error;

      setStatuses(statuses.map(s => s.id === id ? { ...s, color: newColor } : s));
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const updateStatusGradient = async (id: string, gradient: string | null) => {
    try {
      const { error } = await supabase
        .from("claim_statuses")
        .update({ gradient })
        .eq("id", id);

      if (error) throw error;

      setStatuses(statuses.map(s => s.id === id ? { ...s, gradient } : s));
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;

    if (!over || active.id === over.id) return;

    const oldIndex = statuses.findIndex((s) => s.id === active.id);
    const newIndex = statuses.findIndex((s) => s.id === over.id);

    const newStatuses = arrayMove(statuses, oldIndex, newIndex);
    setStatuses(newStatuses);

    try {
      const updates = newStatuses.map((status, index) => ({
        id: status.id,
        display_order: index,
      }));

      for (const update of updates) {
        const { error } = await supabase
          .from("claim_statuses")
          .update({ display_order: update.display_order })
          .eq("id", update.id);

        if (error) throw error;
      }

      toast({
        title: "Success",
        description: "Status order updated",
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
      fetchStatuses();
    }
  };

  if (isAdminLoading) {
    return (
      <div className="space-y-6">
        {/* Hero Section Placeholder */}
        <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 md:p-6 animate-pulse">
          <div className="h-32 w-full" />
        </div>
        <div className="flex items-center justify-center py-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Hero Section - WalletOps Style */}
      <div className="relative overflow-hidden rounded-xl border border-primary/20 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 md:p-6">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-primary/20 blur-3xl" />
        <div className="relative flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="space-y-2 min-w-0">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary" />
              <span className="text-xs font-bold uppercase tracking-widest text-primary">System Configuration</span>
            </div>
            <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Settings</h1>
            <p className="text-sm text-muted-foreground max-w-md">
              Manage your claim workflow, organization identity, and system integrations
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <div className="rounded-lg border border-primary/20 bg-background/40 backdrop-blur-sm p-3 min-w-[140px]">
              <div className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
                <TrendingUp className="h-3 w-3" /> Status
              </div>
              <div className="mt-1 text-xl font-semibold">Live</div>
            </div>
          </div>
        </div>

        <div className="absolute top-4 right-4 md:top-6 md:right-6">
          <Dialog>
            <DialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-primary bg-background/40 backdrop-blur-sm"
                aria-label="Open ChecksOps Guide"
                title="ChecksOps Guide — Help"
              >
                <HelpCircle className="h-5 w-5" />
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
              <CheckCenterHelpPanel />
            </DialogContent>
          </Dialog>
        </div>
      </div>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="flex flex-row md:flex-wrap h-auto w-full bg-muted/20 p-1.5 gap-1 border-border/50">
          <TabsTrigger value="profile" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <UserCog className="h-4 w-4" />
            My Profile
          </TabsTrigger>
          
          <TabsTrigger value="workflow" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Cog className="h-4 w-4" />
            Workflow
          </TabsTrigger>
          <TabsTrigger value="users" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Users className="h-4 w-4" />
            Users
          </TabsTrigger>
          <TabsTrigger value="usage" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <BarChart3 className="h-4 w-4" />
            Usage
          </TabsTrigger>
          <TabsTrigger value="automations" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Activity className="h-4 w-4" />
            Automations
          </TabsTrigger>
          <TabsTrigger value="ai-knowledge" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Knowledge
          </TabsTrigger>
          
          <TabsTrigger value="organization" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <ShieldCheck className="h-4 w-4" />
            Company Settings
          </TabsTrigger>
          <TabsTrigger value="import" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Database className="h-4 w-4" />
            Import
          </TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="audit-logs" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <History className="h-4 w-4" />
              Audit Logs
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="notification-logs" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Bell className="h-4 w-4" />
              Notifications
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="urgency-alerts" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Activity className="h-4 w-4 text-orange-500" />
              Urgency
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="jn-diagnostics" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Activity className="h-4 w-4" />
              JN Sync
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="backup" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Cloud className="h-4 w-4 text-sky-500" />
              Backup
            </TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="white-label" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <ShieldCheck className="h-4 w-4 text-violet-500" />
              White-Label
            </TabsTrigger>
          )}
          {isAdmin && SHOW_CHECKALT && (
            <TabsTrigger value="checkalt" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
              <Receipt className="h-4 w-4 text-emerald-500" />
              Deposits
            </TabsTrigger>
          )}
          <TabsTrigger value="referrals" className="gap-2 px-4 py-2 text-sm font-medium transition-all data-[state=active]:bg-background data-[state=active]:shadow-sm">
            <Share2 className="h-4 w-4" />
            Referrals
          </TabsTrigger>
        </TabsList>


        {SHOW_CHECKALT && (
          <TabsContent value="checkalt" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <CheckAltSettings />
            </div>
          </TabsContent>
        )}


        {/* ActumSettings hidden */}

        <TabsContent value="profile" className="w-full focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">

            <ProfileSettings />
          </div>
        </TabsContent>

        <TabsContent value="referrals" className="w-full focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12">
            <ReferralSettings />
            <AdminReferralDashboard />
          </div>
        </TabsContent>

        <TabsContent value="workflow" className="w-full space-y-6 focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12">


          {/* Claim Statuses - Collapsible */}
          <Collapsible open={statusesOpen} onOpenChange={setStatusesOpen}>
            <SectionCard
              title="Claim Statuses"
              icon={<ListTree className="h-4 w-4 text-primary" />}
              accent="bg-gradient-to-r from-primary/60 to-primary/10"
              description={`Customize the status options available for claims (${statuses.length} statuses)`}
              collapsible={{
                open: statusesOpen,
                onOpenChange: setStatusesOpen
              }}
            >
              <CollapsibleContent>
                <div className="space-y-4 pt-2">
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Input
                      placeholder="Status name"
                      value={newStatusName}
                      onChange={(e) => setNewStatusName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addStatus()}
                      className="h-10 text-sm flex-1"
                    />
                    <div className="flex gap-2">
                      <Input
                        type="color"
                        value={newStatusColor}
                        onChange={(e) => setNewStatusColor(e.target.value)}
                        className="w-14 h-10 p-1"
                      />
                      <Button onClick={addStatus} className="h-10 whitespace-nowrap">
                        <Plus className="h-4 w-4 mr-1" />
                        Add
                      </Button>
                    </div>
                  </div>

                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext
                      items={statuses.map(s => s.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      {statuses.map((status) => (
                        <SortableStatusRow
                          key={status.id}
                          status={status}
                          onUpdateName={updateStatusName}
                          onUpdateColor={updateStatusColor}
                          onUpdateGradient={updateStatusGradient}
                          onDelete={deleteStatus}
                          onRefresh={fetchStatuses}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                </div>
              </CollapsibleContent>
            </SectionCard>
          </Collapsible>

          {/* Loss Types - Collapsible */}
          <Collapsible open={lossTypesOpen} onOpenChange={setLossTypesOpen}>
            <SectionCard
              title="Loss Types"
              icon={<Database className="h-4 w-4 text-sky-500" />}
              accent="bg-gradient-to-r from-sky-500/60 to-sky-500/10"
              description="Manage the types of losses available for claims"
              collapsible={{
                open: lossTypesOpen,
                onOpenChange: setLossTypesOpen
              }}
            >
              <CollapsibleContent>
                <div className="pt-2">
                  <LossTypesSettings embedded />
                </div>
              </CollapsibleContent>
            </SectionCard>
          </Collapsible>

          {/* Custom Fields - Collapsible */}
          <Collapsible open={customFieldsOpen} onOpenChange={setCustomFieldsOpen}>
            <SectionCard
              title="Custom Fields"
              icon={<Plus className="h-4 w-4 text-emerald-500" />}
              accent="bg-gradient-to-r from-emerald-500/60 to-emerald-500/10"
              description="Add custom data fields to claim overview pages"
              collapsible={{
                open: customFieldsOpen,
                onOpenChange: setCustomFieldsOpen
              }}
            >
              <CollapsibleContent>
                <div className="pt-2">
                  <CustomFieldsSettings embedded />
                </div>
              </CollapsibleContent>
            </SectionCard>
          </Collapsible>

          {/* Signature Document Presets - Collapsible */}
          <Collapsible open={sigPresetsOpen} onOpenChange={setSigPresetsOpen}>
            <SectionCard
              title="Signature Document Presets"
              icon={<FileSignature className="h-4 w-4 text-violet-500" />}
              accent="bg-gradient-to-r from-violet-500/60 to-violet-500/10"
              description="Default labels and help text shown to signers per document type"
              collapsible={{
                open: sigPresetsOpen,
                onOpenChange: setSigPresetsOpen
              }}
            >
              <CollapsibleContent>
                <div className="pt-2">
                  <SignaturePresetsSettings embedded />
                </div>
              </CollapsibleContent>
            </SectionCard>
          </Collapsible>

          <Collapsible open={integrationsOpen} onOpenChange={setIntegrationsOpen}>
            <SectionCard
              title="Integrations"
              icon={<Share2 className="h-4 w-4 text-primary" />}
              accent="bg-gradient-to-r from-primary/60 to-primary/10"
              description="Configure external integrations for your workflow"
              collapsible={{
                open: integrationsOpen,
                onOpenChange: setIntegrationsOpen
              }}
            >
              <CollapsibleContent>
                <div className="space-y-6 pt-2">
                  <PhoneVerificationSettings />
                  <OutlookConnectionSettings embedded />
                  <ZapierIntegrationSettings embedded />
                  <QuickBooksSettings embedded />
                  {/* ActumSettings integration hidden */}
                  
                </div>
              </CollapsibleContent>
            </SectionCard>
          </Collapsible>
          </div>
        </TabsContent>


        <TabsContent value="users" className="w-full space-y-6 focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12">
            <UserManagementSettings />
            {tenant && (
              <TeamCapsSettings 
                vendorCap={tenant.vendor_cap ?? 5}
                salesRepCap={tenant.sales_rep_cap ?? 5}
                subcontractorCap={tenant.subcontractor_cap ?? 5}
                tenantId={tenant.id}
                onUpdate={() => {}} 
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="usage" className="w-full focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">

            <UsageLogTab />
          </div>
        </TabsContent>


        <TabsContent value="automations" className="w-full space-y-6 focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12">

          <AutomationsSettings />
          <RDAutomationSettings />
          </div>
        </TabsContent>


        <TabsContent value="ai-knowledge" className="w-full space-y-6 focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12">

          <AIKnowledgeBaseSettings />
          <CounterArgumentsSettings />
          </div>
        </TabsContent>


        <TabsContent value="organization" className="w-full space-y-6 focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6 pb-12">

            <OrganizationSettings />
            <CompanyBrandingSettings />
            <EmailSenderSettings />
            <TenantEmailHealthPanel />
            
            {/* Workspaces - Collapsible */}
            <Collapsible open={workspacesOpen} onOpenChange={setWorkspacesOpen}>
              <SectionCard
                title="Partner Workspaces"
                icon={<FolderKanban className="h-4 w-4 text-orange-500" />}
                accent="bg-gradient-to-r from-orange-500/60 to-orange-500/10"
                description="Manage linked partner instances and cross-tenant collaboration"
                collapsible={{
                  open: workspacesOpen,
                  onOpenChange: setWorkspacesOpen
                }}
              >
                <div className="pt-2">
                  <WorkspaceList embedded />
                </div>
              </SectionCard>
            </Collapsible>
          </div>
        </TabsContent>


        <TabsContent value="import" className="w-full focus-visible:outline-none">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
            <ImportSettings />
          </div>
        </TabsContent>



        {isAdmin && (
          <TabsContent value="audit-logs" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <AuditLogSettings />
            </div>
          </TabsContent>

        )}

        {isAdmin && (
          <TabsContent value="notification-logs" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <NotificationDeliveryLogView />
            </div>
          </TabsContent>

        )}

        {isAdmin && (
          <TabsContent value="urgency-alerts" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <StatusUrgencyNotificationsSettings />
            </div>
          </TabsContent>

        )}

        {isAdmin && (
          <TabsContent value="jn-diagnostics" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <JobNimbusSyncDiagnostics />
            </div>
          </TabsContent>

        )}

        {isAdmin && (
          <TabsContent value="backup" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <BackupStatusSettings />
            </div>
          </TabsContent>

        )}
        {isAdmin && (
          <TabsContent value="white-label" className="w-full focus-visible:outline-none">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-12">
              <TenantManagement />
            </div>
          </TabsContent>

        )}
      </Tabs>
    </div>
  );
}