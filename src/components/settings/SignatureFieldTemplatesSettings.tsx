import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { Plus, Trash2, Edit, FileSignature, Upload, Loader2, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { FieldPlacementEditor } from "@/components/claim-detail/FieldPlacementEditor";

interface SignatureFieldTemplatesSettingsProps {
  embedded?: boolean;
}

export function SignatureFieldTemplatesSettings({ embedded = false }: SignatureFieldTemplatesSettingsProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<any>(null);
  const [newTemplateName, setNewTemplateName] = useState("");
  const [newTemplateDescription, setNewTemplateDescription] = useState("");
  const [samplePdfUrl, setSamplePdfUrl] = useState<string | null>(null);
  const [placedFields, setPlacedFields] = useState<any[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  const { data: templates, isLoading } = useQuery({
    queryKey: ["signature-field-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_field_templates")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!newTemplateName.trim()) throw new Error("Template name is required");
      if (placedFields.length === 0) throw new Error("Please place at least one field");

      const { data: { user } } = await supabase.auth.getUser();
      
      const { error } = await supabase
        .from("signature_field_templates")
        .insert({
          name: newTemplateName.trim(),
          description: newTemplateDescription.trim() || null,
          field_data: placedFields,
          created_by: user?.id,
        });
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Template created successfully" });
      setIsCreateOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["signature-field-templates"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to create template", description: error.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingTemplate) throw new Error("No template selected");
      if (!newTemplateName.trim()) throw new Error("Template name is required");

      const updateData: any = {
        name: newTemplateName.trim(),
        description: newTemplateDescription.trim() || null,
        updated_at: new Date().toISOString(),
      };

      // Only update field_data if we have placed fields (meaning PDF was loaded)
      if (placedFields.length > 0) {
        updateData.field_data = placedFields;
      }

      const { error } = await supabase
        .from("signature_field_templates")
        .update(updateData)
        .eq("id", editingTemplate.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Template updated successfully" });
      setIsEditOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["signature-field-templates"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to update template", description: error.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("signature_field_templates")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Template deleted" });
      queryClient.invalidateQueries({ queryKey: ["signature-field-templates"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to delete template", description: error.message, variant: "destructive" });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, isActive }: { id: string; isActive: boolean }) => {
      const { error } = await supabase
        .from("signature_field_templates")
        .update({ is_active: isActive })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["signature-field-templates"] });
    },
  });

  const resetForm = () => {
    setNewTemplateName("");
    setNewTemplateDescription("");
    setSamplePdfUrl(null);
    setPlacedFields([]);
    setEditingTemplate(null);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.type !== "application/pdf") {
      toast({ title: "Please upload a PDF file", variant: "destructive" });
      return;
    }

    setIsUploading(true);
    try {
      // Sanitize filename - remove special characters and spaces
      const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const fileName = `temp-signature-templates/${Date.now()}-${sanitizedName}`;
      const { error: uploadError } = await supabase.storage
        .from("claim-files")
        .upload(fileName, file);

      if (uploadError) throw uploadError;

      // Get signed URL
      const { data: urlData } = await supabase.storage
        .from("claim-files")
        .createSignedUrl(fileName, 3600);

      if (urlData?.signedUrl) {
        setSamplePdfUrl(urlData.signedUrl);
        toast({ title: "PDF uploaded! Now place your signature fields." });
      }
    } catch (error: any) {
      toast({ title: "Upload failed", description: error.message, variant: "destructive" });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const openEditDialog = (template: any) => {
    setEditingTemplate(template);
    setNewTemplateName(template.name);
    setNewTemplateDescription(template.description || "");
    setPlacedFields(template.field_data || []);
    setSamplePdfUrl(null);
    setIsEditOpen(true);
  };

  const getFieldTypeCounts = (fieldData: any[]) => {
    const counts: Record<string, number> = {};
    fieldData?.forEach(field => {
      counts[field.type] = (counts[field.type] || 0) + 1;
    });
    return counts;
  };

  const content = (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <p className="text-sm text-muted-foreground">
          Create reusable signature field layouts for your documents.
        </p>
        <Dialog open={isCreateOpen} onOpenChange={(open) => { setIsCreateOpen(open); if (!open) resetForm(); }}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="w-4 h-4 mr-2" />
              New Template
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Create Signature Field Template</DialogTitle>
              <DialogDescription>
                Upload a sample PDF and visually place signature, date, and text fields.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Template Name *</Label>
                  <Input
                    value={newTemplateName}
                    onChange={(e) => setNewTemplateName(e.target.value)}
                    placeholder="e.g., Standard Contract Layout"
                  />
                </div>
                <div>
                  <Label>Description</Label>
                  <Input
                    value={newTemplateDescription}
                    onChange={(e) => setNewTemplateDescription(e.target.value)}
                    placeholder="Optional description"
                  />
                </div>
              </div>

              {!samplePdfUrl ? (
                <div className="border-2 border-dashed rounded-lg p-8 text-center">
                  <FileSignature className="w-12 h-12 mx-auto mb-4 text-muted-foreground" />
                  <p className="text-muted-foreground mb-4">
                    Upload a sample PDF to place signature fields
                  </p>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <Button
                    variant="outline"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Uploading...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 mr-2" />
                        Upload PDF
                      </>
                    )}
                  </Button>
                </div>
              ) : (
                <div>
                  <div className="flex justify-between items-center mb-2">
                    <Label>Place Signature Fields</Label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSamplePdfUrl(null);
                        setPlacedFields([]);
                      }}
                    >
                      Upload Different PDF
                    </Button>
                  </div>
                  <FieldPlacementEditor
                    documentUrl={samplePdfUrl}
                    onFieldsChange={setPlacedFields}
                    signerCount={2}
                  />
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => { setIsCreateOpen(false); resetForm(); }}>
                Cancel
              </Button>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={createMutation.isPending || !newTemplateName.trim() || placedFields.length === 0}
              >
                {createMutation.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create Template"
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditOpen} onOpenChange={(open) => { setIsEditOpen(open); if (!open) resetForm(); }}>
        <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Template</DialogTitle>
            <DialogDescription>
              Update the template name or upload a new PDF to modify field placements.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Template Name *</Label>
                <Input
                  value={newTemplateName}
                  onChange={(e) => setNewTemplateName(e.target.value)}
                />
              </div>
              <div>
                <Label>Description</Label>
                <Input
                  value={newTemplateDescription}
                  onChange={(e) => setNewTemplateDescription(e.target.value)}
                />
              </div>
            </div>

            {editingTemplate && !samplePdfUrl && (
              <div className="space-y-4">
                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground mb-2">
                    Current fields: {editingTemplate.field_data?.length || 0} placed
                  </p>
                  <div className="flex flex-wrap gap-2 mb-4">
                    {Object.entries(getFieldTypeCounts(editingTemplate.field_data || [])).map(([type, count]) => (
                      <Badge key={type} variant="secondary">
                        {type}: {count as number}
                      </Badge>
                    ))}
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf"
                    onChange={handleFileUpload}
                    className="hidden"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isUploading}
                  >
                    {isUploading ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4 mr-2" />
                    )}
                    Upload PDF to Edit Fields
                  </Button>
                </div>

                {/* Inline display label editing for existing fields */}
                {(editingTemplate.field_data?.length || 0) > 0 && (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">Signer-Facing Labels</p>
                    <p className="text-xs text-muted-foreground">
                      Edit what the signer sees for each field. These are display-only and do not affect field IDs or submission.
                    </p>
                    {(editingTemplate.field_data as any[]).map((field: any, idx: number) => (
                      <div key={field.id || idx} className="border rounded-lg p-3 space-y-2 bg-background">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline" className="text-xs capitalize">{field.type}</Badge>
                          <span className="text-xs text-muted-foreground">Page {field.page ?? 1}</span>
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">Display Label</Label>
                            <Input
                              value={field.display_label || ""}
                              onChange={(e) => {
                                const updated = [...editingTemplate.field_data as any[]];
                                updated[idx] = { ...updated[idx], display_label: e.target.value || undefined };
                                setEditingTemplate({ ...editingTemplate, field_data: updated });
                                setPlacedFields(updated);
                              }}
                              placeholder="e.g., Owner Signature"
                              className="h-8 text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">Section Group</Label>
                            <Input
                              value={field.display_section || ""}
                              onChange={(e) => {
                                const updated = [...editingTemplate.field_data as any[]];
                                updated[idx] = { ...updated[idx], display_section: e.target.value || undefined };
                                setEditingTemplate({ ...editingTemplate, field_data: updated });
                                setPlacedFields(updated);
                              }}
                              placeholder="e.g., Signatures"
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">Help Text</Label>
                          <Input
                            value={field.display_help_text || ""}
                            onChange={(e) => {
                              const updated = [...editingTemplate.field_data as any[]];
                              updated[idx] = { ...updated[idx], display_help_text: e.target.value || undefined };
                              setEditingTemplate({ ...editingTemplate, field_data: updated });
                              setPlacedFields(updated);
                            }}
                            placeholder="e.g., Sign here to approve the contract terms."
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {samplePdfUrl && (
              <FieldPlacementEditor
                documentUrl={samplePdfUrl}
                onFieldsChange={setPlacedFields}
                signerCount={2}
              />
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => { setIsEditOpen(false); resetForm(); }}>
              Cancel
            </Button>
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={updateMutation.isPending || !newTemplateName.trim()}
            >
              {updateMutation.isPending ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : templates && templates.length > 0 ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Fields</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-24">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {templates.map((template) => {
              const fieldCounts = getFieldTypeCounts(template.field_data as any[] || []);
              return (
                <TableRow key={template.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{template.name}</p>
                      {template.description && (
                        <p className="text-sm text-muted-foreground">{template.description}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {Object.entries(fieldCounts).map(([type, count]) => (
                        <Badge key={type} variant="outline" className="text-xs">
                          {type}: {count as number}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleActiveMutation.mutate({ id: template.id, isActive: !template.is_active })}
                    >
                      <Badge variant={template.is_active ? "default" : "secondary"}>
                        {template.is_active ? "Active" : "Inactive"}
                      </Badge>
                    </Button>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(template.created_at!).toLocaleDateString()}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => openEditDialog(template)}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => deleteMutation.mutate(template.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <div className="text-center py-8 text-muted-foreground">
          <FileSignature className="w-12 h-12 mx-auto mb-4 opacity-50" />
          <p>No signature field templates yet</p>
          <p className="text-sm">Create a template to define reusable field layouts</p>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return content;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="w-5 h-5" />
          Signature Field Templates
        </CardTitle>
        <CardDescription>
          Define where signature, date, and text fields should appear on your documents
        </CardDescription>
      </CardHeader>
      <CardContent>{content}</CardContent>
    </Card>
  );
}
