import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Plus, Trash2, GripVertical, ChevronDown, FolderKanban, FileSignature } from "lucide-react";
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

import { ImportSettings } from "@/components/settings/ImportSettings";
import { UserManagementSettings } from "@/components/settings/UserManagementSettings";
import { ProfileSettings } from "@/components/settings/ProfileSettings";
import { AIKnowledgeBaseSettings } from "@/components/settings/AIKnowledgeBaseSettings";
import { CounterArgumentsSettings } from "@/components/settings/CounterArgumentsSettings";
import { QuickBooksSettings } from "@/components/settings/QuickBooksSettings";
import { BackupStatusSettings } from "@/components/settings/BackupStatusSettings";
import { ZapierIntegrationSettings } from "@/components/settings/ZapierIntegrationSettings";
import { OrganizationSettings } from "@/components/settings/OrganizationSettings";
import { CompanyBrandingSettings } from "@/components/settings/CompanyBrandingSettings";
import { AuditLogSettings } from "@/components/settings/AuditLogSettings";
import { RampSettings } from "@/components/settings/RampSettings";
import { useQuery } from "@tanstack/react-query";
import { WorkspaceList } from "@/components/workspaces/WorkspaceList";


import { RDAutomationSettings } from "@/components/settings/RDAutomationSettings";
import { OutlookConnectionSettings } from "@/components/settings/OutlookConnectionSettings";
import { PhoneVerificationSettings } from "@/components/settings/PhoneVerificationSettings";
interface ClaimStatus {
  id: string;
  name: string;
  color: string;
  display_order: number;
  is_active: boolean;
}

interface SortableStatusRowProps {
  status: ClaimStatus;
  onUpdateName: (id: string, name: string) => void;
  onUpdateColor: (id: string, color: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
}

function SortableStatusRow({ status, onUpdateName, onUpdateColor, onDelete, onRefresh }: SortableStatusRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: status.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <TableRow ref={setNodeRef} style={style}>
      <TableCell>
        <div {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing">
          <GripVertical className="h-5 w-5 text-muted-foreground" />
        </div>
      </TableCell>
      <TableCell>
        <Input
          value={status.name}
          onChange={(e) => onUpdateName(status.id, e.target.value)}
          onBlur={onRefresh}
          className="h-11 text-base"
        />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2">
          <Input
            type="color"
            value={status.color}
            onChange={(e) => onUpdateColor(status.id, e.target.value)}
            className="w-12 h-8 p-1 cursor-pointer"
          />
          <span className="text-sm text-muted-foreground">
            {status.color}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onDelete(status.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </TableCell>
    </TableRow>
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
  
  const { toast } = useToast();

  // Check if current user is admin
  const { data: isAdmin } = useQuery({
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
      
      toast({
        title: "Success",
        description: "Color updated",
      });
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Settings</h1>
        <p className="text-muted-foreground">Manage your claim workflow and dropdown options</p>
      </div>

      <Tabs defaultValue="workflow" className="space-y-6">
        <TabsList className="flex flex-col md:flex-row md:flex-wrap h-auto w-full bg-muted/40 p-2 gap-1">
          <TabsTrigger value="profile" className="w-full md:w-auto justify-start text-base font-medium px-4">My Profile</TabsTrigger>
          <TabsTrigger value="workflow" className="w-full md:w-auto justify-start text-base font-medium px-4">Workflow Management</TabsTrigger>
          <TabsTrigger value="users" className="w-full md:w-auto justify-start text-base font-medium px-4">User Management</TabsTrigger>
          <TabsTrigger value="automations" className="w-full md:w-auto justify-start text-base font-medium px-4">Automations</TabsTrigger>
          <TabsTrigger value="ai-knowledge" className="w-full md:w-auto justify-start text-base font-medium px-4">AI Knowledge Base</TabsTrigger>
          
          <TabsTrigger value="organization" className="w-full md:w-auto justify-start text-base font-medium px-4">Organization</TabsTrigger>
          <TabsTrigger value="import" className="w-full md:w-auto justify-start text-base font-medium px-4">Import Data</TabsTrigger>
          {isAdmin && (
            <TabsTrigger value="audit-logs" className="w-full md:w-auto justify-start text-base font-medium px-4">Audit Logs</TabsTrigger>
          )}
          {isAdmin && (
            <TabsTrigger value="backup" className="w-full md:w-auto justify-start text-base font-medium px-4">Backup Status</TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="profile" className="w-full">
          <ProfileSettings />
        </TabsContent>

        <TabsContent value="workflow" className="w-full space-y-4">
          {/* Claim Statuses - Collapsible */}
          <Collapsible open={statusesOpen} onOpenChange={setStatusesOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Claim Statuses</CardTitle>
                      <CardDescription>
                        Customize the status options available for claims ({statuses.length} statuses)
                      </CardDescription>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${statusesOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Status name"
                      value={newStatusName}
                      onChange={(e) => setNewStatusName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && addStatus()}
                      className="h-11 text-base"
                    />
                    <Input
                      type="color"
                      value={newStatusColor}
                      onChange={(e) => setNewStatusColor(e.target.value)}
                      className="w-24 h-11"
                    />
                    <Button onClick={addStatus} className="h-11">
                      <Plus className="h-4 w-4 mr-2" />
                      Add Status
                    </Button>
                  </div>

                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-12"></TableHead>
                          <TableHead>Status Name</TableHead>
                          <TableHead>Color</TableHead>
                          <TableHead className="w-12"></TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
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
                              onDelete={deleteStatus}
                              onRefresh={fetchStatuses}
                            />
                          ))}
                        </SortableContext>
                      </TableBody>
                    </Table>
                  </DndContext>
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Loss Types - Collapsible */}
          <Collapsible open={lossTypesOpen} onOpenChange={setLossTypesOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Loss Types</CardTitle>
                      <CardDescription>
                        Manage the types of losses available for claims
                      </CardDescription>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${lossTypesOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent>
                  <LossTypesSettings embedded />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Custom Fields - Collapsible */}
          <Collapsible open={customFieldsOpen} onOpenChange={setCustomFieldsOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Custom Fields</CardTitle>
                      <CardDescription>
                        Add custom data fields to claim overview pages
                      </CardDescription>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${customFieldsOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent>
                  <CustomFieldsSettings embedded />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Signature Field Templates - Collapsible */}
          <Collapsible open={signatureTemplatesOpen} onOpenChange={setSignatureTemplatesOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileSignature className="h-5 w-5" />
                      <div>
                        <CardTitle>Signature Field Templates</CardTitle>
                        <CardDescription>
                          Define reusable signature, date, and text field layouts for documents
                        </CardDescription>
                      </div>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${signatureTemplatesOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent>
                  <SignatureFieldTemplatesSettings embedded />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>

          {/* Integrations - Collapsible */}
          <Collapsible open={integrationsOpen} onOpenChange={setIntegrationsOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Integrations</CardTitle>
                      <CardDescription>
                        Configure external integrations for your workflow
                      </CardDescription>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${integrationsOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent className="space-y-6">
                  <PhoneVerificationSettings />
                  <OutlookConnectionSettings embedded />
                  <MakeIntegrationSettings embedded />
                  <QuickBooksSettings embedded />
                  {isAdmin && <RampSettings embedded />}
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>

        <TabsContent value="users" className="w-full">
          <UserManagementSettings />
        </TabsContent>

        <TabsContent value="automations" className="w-full space-y-6">
          <AutomationsSettings />
          <RDAutomationSettings />
        </TabsContent>

        <TabsContent value="ai-knowledge" className="w-full space-y-6">
          <AIKnowledgeBaseSettings />
          <CounterArgumentsSettings />
        </TabsContent>

        <TabsContent value="organization" className="w-full space-y-4">
          <OrganizationSettings />
          
          {/* Workspaces - Collapsible */}
          <Collapsible open={workspacesOpen} onOpenChange={setWorkspacesOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FolderKanban className="h-5 w-5" />
                      <div>
                        <CardTitle>Workspaces</CardTitle>
                        <CardDescription>
                          Manage workspaces and linked partner instances
                        </CardDescription>
                      </div>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${workspacesOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent>
                  <WorkspaceList embedded />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
          
          {/* Company Branding - Collapsible */}
          <Collapsible open={companyBrandingOpen} onOpenChange={setCompanyBrandingOpen}>
            <Card>
              <CollapsibleTrigger asChild>
                <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle>Company Branding</CardTitle>
                      <CardDescription>
                        Configure company information, letterhead, and integrations
                      </CardDescription>
                    </div>
                    <ChevronDown className={`h-5 w-5 transition-transform ${companyBrandingOpen ? 'rotate-180' : ''}`} />
                  </div>
                </CardHeader>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <CardContent>
                  <CompanyBrandingSettings />
                </CardContent>
              </CollapsibleContent>
            </Card>
          </Collapsible>
        </TabsContent>

        <TabsContent value="import" className="w-full">
          <ImportSettings />
        </TabsContent>


        {isAdmin && (
          <TabsContent value="audit-logs" className="w-full">
            <AuditLogSettings />
          </TabsContent>
        )}

        {isAdmin && (
          <TabsContent value="backup" className="w-full">
            <BackupStatusSettings />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}