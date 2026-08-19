import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, FileSignature, ChevronDown, ChevronUp, Save } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SettingsHero } from "./SettingsHero";
import { SectionCard } from "./SectionCard";

interface FieldMeta {
  display_label: string;
  display_help_text: string;
  display_section?: string;
  display_order?: number;
}

interface Preset {
  id: string;
  document_type: string;
  label: string;
  description: string | null;
  fields: Record<string, FieldMeta>;
  created_at: string;
}

interface SignaturePresetsSettingsProps {
  embedded?: boolean;
}

const FIELD_TYPE_ICONS: Record<string, string> = {
  signature: "✍️",
  text: "📝",
  date: "📅",
  checkbox: "☑️",
};

function getFieldTypeFromKey(key: string): string {
  return key.replace(/_\d+$/, "");
}

export function SignaturePresetsSettings({ embedded }: SignaturePresetsSettingsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedPreset, setExpandedPreset] = useState<string | null>(null);
  const [editingPreset, setEditingPreset] = useState<Preset | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newType, setNewType] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [addFieldKey, setAddFieldKey] = useState("");

  const { data: presets = [], isLoading } = useQuery({
    queryKey: ["signature-document-presets"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_document_presets")
        .select("id, document_type, label, description, fields, created_at")
        .order("label");
      if (error) throw error;
      return (data ?? []) as unknown as Preset[];
    },
    staleTime: 1000 * 60 * 5,
    refetchOnWindowFocus: false,
  });

  const saveMutation = useMutation({
    mutationFn: async (preset: Preset) => {
      const { error } = await supabase
        .from("signature_document_presets")
        .update({
          label: preset.label,
          description: preset.description,
          fields: preset.fields as any,
          updated_at: new Date().toISOString(),
        })
        .eq("id", preset.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["signature-document-presets"] });
      toast({ title: "Saved", description: "Preset updated successfully" });
      setEditingPreset(null);
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const addMutation = useMutation({
    mutationFn: async () => {
      const docType = newType.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");
      const { error } = await supabase.from("signature_document_presets").insert({
        document_type: docType,
        label: newLabel,
        description: newDescription || null,
        fields: {
          signature_1: {
            display_label: "Signature",
            display_help_text: "Sign here.",
            display_section: "Signatures",
            display_order: 1,
          },
          date_1: {
            display_label: "Date Signed",
            display_help_text: "Enter the date signed.",
            display_section: "Signatures",
            display_order: 2,
          },
        },
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["signature-document-presets"] });
      toast({ title: "Created", description: "New document type preset added" });
      setShowAddDialog(false);
      setNewType("");
      setNewLabel("");
      setNewDescription("");
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("signature_document_presets").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["signature-document-presets"] });
      toast({ title: "Deleted", description: "Preset removed" });
    },
    onError: (err: any) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function startEditing(preset: Preset) {
    setEditingPreset(JSON.parse(JSON.stringify(preset)));
  }

  function updateField(key: string, field: string, value: string | number) {
    if (!editingPreset) return;
    setEditingPreset({
      ...editingPreset,
      fields: {
        ...(editingPreset.fields || {}),
        [key]: {
          ...((editingPreset.fields || {})[key]),
          [field]: value,
        },
      },
    });
  }

  function removeField(key: string) {
    if (!editingPreset) return;
    const newFields = { ...(editingPreset.fields || {}) };
    delete newFields[key];
    setEditingPreset({ ...editingPreset, fields: newFields });
  }

  function addFieldToEditing() {
    if (!editingPreset || !addFieldKey) return;
    const fieldType = getFieldTypeFromKey(addFieldKey);
    const icon = FIELD_TYPE_ICONS[fieldType] || "📝";
    const maxOrder = Math.max(0, ...Object.values(editingPreset.fields || {}).map((f) => f.display_order || 0));
    setEditingPreset({
      ...editingPreset,
      fields: {
        ...(editingPreset.fields || {}),
        [addFieldKey]: {
          display_label: `${icon} New ${fieldType} field`,
          display_help_text: "",
          display_section: "General",
          display_order: maxOrder + 1,
        },
      },
    });
    setAddFieldKey("");
  }

  const content = (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          These presets define the labels and help text signers see when signing documents. When you select a document type during signature request creation, these labels are applied automatically.
        </p>
        <Button size="sm" onClick={() => setShowAddDialog(true)} className="shrink-0">
          <Plus className="h-4 w-4 mr-1" />
          Add Type
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {presets.map((preset) => {
            const isExpanded = expandedPreset === preset.id;
            const isEditing = editingPreset?.id === preset.id;
            const safeFields = (isEditing ? editingPreset!.fields : preset.fields) || {};
            const fieldKeys = Object.keys(safeFields);

            return (
              <Collapsible
                key={preset.id}
                open={isExpanded}
                onOpenChange={(open) => {
                  setExpandedPreset(open ? preset.id : null);
                  if (!open) setEditingPreset(null);
                }}
              >
                <div className="border rounded-lg overflow-hidden">
                  <CollapsibleTrigger asChild>
                    <button className="flex items-center justify-between w-full p-3 hover:bg-muted/50 transition-colors text-left">
                      <div className="flex items-center gap-2">
                        <FileSignature className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium text-sm">{preset.label}</span>
                        <Badge variant="secondary" className="text-xs">
                          {fieldKeys.length} fields
                        </Badge>
                      </div>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                          {preset.document_type}
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-muted-foreground" />
                        )}
                      </div>
                    </button>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="border-t px-3 py-3 space-y-3 bg-muted/20">
                      {/* Preset header info */}
                      {isEditing ? (
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Display Name</Label>
                            <Input
                              value={editingPreset!.label}
                              onChange={(e) =>
                                setEditingPreset({ ...editingPreset!, label: e.target.value })
                              }
                              className="h-8 text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Description</Label>
                            <Input
                              value={editingPreset!.description || ""}
                              onChange={(e) =>
                                setEditingPreset({
                                  ...editingPreset!,
                                  description: e.target.value,
                                })
                              }
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{preset.description}</p>
                      )}

                      {/* Fields list */}
                      <div className="space-y-2">
                        <Label className="text-xs font-semibold">Signer-Facing Fields</Label>
                        {fieldKeys
                          .sort((a, b) => {
                            const fa = safeFields[a];
                            const fb = safeFields[b];
                            return (fa?.display_order || 0) - (fb?.display_order || 0);
                          })
                          .map((key) => {
                            const field = safeFields[key];
                            const fieldType = getFieldTypeFromKey(key);
                            const icon = FIELD_TYPE_ICONS[fieldType] || "📝";

                            return (
                              <div
                                key={key}
                                className="border rounded-md p-2 bg-background space-y-1.5"
                              >
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-sm">{icon}</span>
                                    <Badge variant="outline" className="text-xs font-mono">
                                      {key}
                                    </Badge>
                                  </div>
                                  {isEditing && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-6 w-6 p-0 text-destructive"
                                      onClick={() => removeField(key)}
                                    >
                                      <Trash2 className="h-3 w-3" />
                                    </Button>
                                  )}
                                </div>
                                {isEditing ? (
                                  <div className="space-y-1.5">
                                    <div>
                                      <Label className="text-xs text-muted-foreground">
                                        Label shown to signer
                                      </Label>
                                      <Input
                                        value={field.display_label}
                                        onChange={(e) =>
                                          updateField(key, "display_label", e.target.value)
                                        }
                                        className="h-7 text-xs"
                                      />
                                    </div>
                                    <div>
                                      <Label className="text-xs text-muted-foreground">
                                        Help text
                                      </Label>
                                      <Textarea
                                        value={field.display_help_text}
                                        onChange={(e) =>
                                          updateField(key, "display_help_text", e.target.value)
                                        }
                                        className="text-xs min-h-[40px] resize-none"
                                        rows={2}
                                      />
                                    </div>
                                    <div className="grid grid-cols-2 gap-1.5">
                                      <div>
                                        <Label className="text-xs text-muted-foreground">
                                          Section
                                        </Label>
                                        <Input
                                          value={field.display_section || ""}
                                          onChange={(e) =>
                                            updateField(key, "display_section", e.target.value)
                                          }
                                          className="h-7 text-xs"
                                        />
                                      </div>
                                      <div>
                                        <Label className="text-xs text-muted-foreground">
                                          Order
                                        </Label>
                                        <Input
                                          type="number"
                                          value={field.display_order || 0}
                                          onChange={(e) =>
                                            updateField(
                                              key,
                                              "display_order",
                                              parseInt(e.target.value) || 0
                                            )
                                          }
                                          className="h-7 text-xs"
                                        />
                                      </div>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="text-xs">
                                    <p className="font-medium">{field.display_label}</p>
                                    <p className="text-muted-foreground">{field.display_help_text}</p>
                                    {field.display_section && (
                                      <Badge variant="secondary" className="mt-1 text-[10px]">
                                        {field.display_section}
                                      </Badge>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                      </div>

                      {/* Add field (editing mode) */}
                      {isEditing && (
                        <div className="flex gap-1.5">
                          <Input
                            value={addFieldKey}
                            onChange={(e) => setAddFieldKey(e.target.value)}
                            placeholder="e.g. signature_3, text_2"
                            className="h-7 text-xs flex-1"
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs"
                            onClick={addFieldToEditing}
                            disabled={!addFieldKey}
                          >
                            <Plus className="h-3 w-3 mr-1" />
                            Add
                          </Button>
                        </div>
                      )}

                      {/* Actions */}
                      <div className="flex items-center gap-2 pt-1">
                        {isEditing ? (
                          <>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              onClick={() => saveMutation.mutate(editingPreset!)}
                              disabled={saveMutation.isPending}
                            >
                              <Save className="h-3 w-3 mr-1" />
                              {saveMutation.isPending ? "Saving..." : "Save"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => setEditingPreset(null)}
                            >
                              Cancel
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 text-xs"
                              onClick={() => startEditing(preset)}
                            >
                              <Pencil className="h-3 w-3 mr-1" />
                              Edit Labels
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs text-destructive"
                              onClick={() => deleteMutation.mutate(preset.id)}
                            >
                              <Trash2 className="h-3 w-3 mr-1" />
                              Delete
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            );
          })}
        </div>
      )}

      {/* Add new document type dialog */}
      <Dialog open={showAddDialog} onOpenChange={setShowAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Document Type Preset</DialogTitle>
            <DialogDescription>
              Create a new document type with default signer-facing labels.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Display Name</Label>
              <Input
                value={newLabel}
                onChange={(e) => {
                  setNewLabel(e.target.value);
                  if (!newType) {
                    setNewType(e.target.value);
                  }
                }}
                placeholder="e.g. Proof of Loss, Affidavit"
              />
            </div>
            <div>
              <Label>Type Key</Label>
              <Input
                value={newType}
                onChange={(e) => setNewType(e.target.value)}
                placeholder="Auto-generated from name"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                Used internally. Lowercase, underscores only.
              </p>
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Input
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                placeholder="Brief description of this document type"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAddDialog(false)}>
              Cancel
            </Button>
            <Button onClick={() => addMutation.mutate()} disabled={!newLabel || addMutation.isPending}>
              {addMutation.isPending ? "Creating..." : "Create Preset"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  if (embedded) return content;
 
  return (
    <div className="space-y-6 max-w-7xl mx-auto">
      <SettingsHero
        title="Signature Presets"
        description="Manage the default labels and help text shown to signers for each document type."
        badge="Workflow Presets"
        icon={<FileSignature className="h-4 w-4 text-primary" />}
      />

      <SectionCard
        title="Document Presets"
        accent="bg-gradient-to-r from-primary/60 to-primary/10"
        icon={<FileSignature className="h-4 w-4 text-primary" />}
        description="Manage how signature fields appear to your clients."
      >
        {content}
      </SectionCard>
    </div>
  );
}
