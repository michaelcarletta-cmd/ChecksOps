import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, MessageSquare } from "lucide-react";
import { MergeFieldButtons } from "@/components/MergeFieldButtons";

interface SMSTemplate {
  id: string;
  name: string;
  body: string;
  description: string | null;
  category: string | null;
  is_active: boolean;
  created_at: string;
}

const CATEGORIES = ["Reminders", "Follow-ups", "Notifications", "Requests", "Updates", "Other"];

// Merge fields now come from the shared MergeFieldButtons component

export default function SMSTemplatesSettings() {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<SMSTemplate | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    body: "",
    description: "",
    category: "Other",
  });

  const { data: templates, isLoading } = useQuery({
    queryKey: ["sms-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("sms_templates")
        .select("*")
        .order("category", { ascending: true })
        .order("name", { ascending: true });
      if (error) throw error;
      return data as SMSTemplate[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from("sms_templates").insert(data);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      toast.success("SMS template created");
      resetForm();
    },
    onError: (error) => toast.error("Failed to create template: " + error.message),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, ...data }: { id: string } & typeof formData) => {
      const { error } = await supabase.from("sms_templates").update(data).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      toast.success("SMS template updated");
      resetForm();
    },
    onError: (error) => toast.error("Failed to update template: " + error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("sms_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
      toast.success("SMS template deleted");
    },
    onError: (error) => toast.error("Failed to delete template: " + error.message),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase.from("sms_templates").update({ is_active }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sms-templates"] });
    },
    onError: (error) => toast.error("Failed to update template: " + error.message),
  });

  const resetForm = () => {
    setFormData({ name: "", body: "", description: "", category: "Other" });
    setEditingTemplate(null);
    setIsDialogOpen(false);
  };

  const handleEdit = (template: SMSTemplate) => {
    setEditingTemplate(template);
    setFormData({
      name: template.name,
      body: template.body,
      description: template.description || "",
      category: template.category || "Other",
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, ...formData });
    } else {
      createMutation.mutate(formData);
    }
  };

  const insertMergeField = (field: string) => {
    const textarea = smsBodyRef.current;
    if (textarea) {
      const start = textarea.selectionStart ?? formData.body.length;
      const end = textarea.selectionEnd ?? formData.body.length;
      const newBody = formData.body.slice(0, start) + field + formData.body.slice(end);
      setFormData((prev) => ({ ...prev, body: newBody }));
      requestAnimationFrame(() => {
        textarea.focus();
        const newPos = start + field.length;
        textarea.setSelectionRange(newPos, newPos);
      });
    } else {
      setFormData((prev) => ({ ...prev, body: prev.body + field }));
    }
  };

  const groupedTemplates = templates?.reduce((acc, template) => {
    const cat = template.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(template);
    return acc;
  }, {} as Record<string, SMSTemplate[]>);

  if (isLoading) {
    return <div className="text-muted-foreground">Loading templates...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-medium">SMS Templates</h3>
          <p className="text-sm text-muted-foreground">Create reusable SMS message templates with merge fields.</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => resetForm()}>
              <Plus className="h-4 w-4 mr-2" />
              New Template
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>{editingTemplate ? "Edit Template" : "New SMS Template"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="name">Template Name</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData((prev) => ({ ...prev, name: e.target.value }))}
                    placeholder="e.g., Appointment Reminder"
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="category">Category</Label>
                  <Select
                    value={formData.category}
                    onValueChange={(value) => setFormData((prev) => ({ ...prev, category: value }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map((cat) => (
                        <SelectItem key={cat} value={cat}>
                          {cat}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Description (optional)</Label>
                <Input
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData((prev) => ({ ...prev, description: e.target.value }))}
                  placeholder="Brief description of when to use this template"
                />
              </div>
              <div className="space-y-2">
                  <div className="flex items-center justify-between">
                  <Label htmlFor="body">Message Body</Label>
                  <MergeFieldButtons onInsert={(field) => insertMergeField(field)} />
                </div>
                <Textarea
                  ref={smsBodyRef}
                  id="body"
                  value={formData.body}
                  onChange={(e) => setFormData((prev) => ({ ...prev, body: e.target.value }))}
                  placeholder="Enter your SMS message..."
                  rows={4}
                  required
                />
                <p className="text-xs text-muted-foreground">
                  {formData.body.length} characters (SMS limit: 160 per segment)
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {editingTemplate ? "Update" : "Create"} Template
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {Object.entries(groupedTemplates || {}).map(([category, categoryTemplates]) => (
        <div key={category} className="space-y-3">
          <h4 className="text-sm font-medium text-muted-foreground">{category}</h4>
          <div className="grid gap-3">
            {categoryTemplates.map((template) => (
              <Card key={template.id} className={!template.is_active ? "opacity-60" : ""}>
                <CardHeader className="py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <MessageSquare className="h-4 w-4 text-muted-foreground" />
                      <CardTitle className="text-sm font-medium">{template.name}</CardTitle>
                      {template.description && (
                        <span className="text-xs text-muted-foreground">— {template.description}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={template.is_active}
                        onCheckedChange={(checked) =>
                          toggleActiveMutation.mutate({ id: template.id, is_active: checked })
                        }
                      />
                      <Button variant="ghost" size="icon" onClick={() => handleEdit(template)}>
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (confirm("Delete this template?")) {
                            deleteMutation.mutate(template.id);
                          }
                        }}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="py-2">
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">{template.body}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      ))}

      {(!templates || templates.length === 0) && (
        <div className="text-center py-8 text-muted-foreground">
          No SMS templates yet. Create one to get started.
        </div>
      )}
    </div>
  );
}
