import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Mail, Trash2, Pencil, Loader2, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MergeFieldButtons } from "@/components/MergeFieldButtons";
import { TemplatePreview } from "@/components/settings/TemplatePreview";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  body: string;
  description: string | null;
  category: string | null;
  is_active: boolean;
  created_at: string;
}

export const EmailTemplatesSettings = () => {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [deleteTemplateId, setDeleteTemplateId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    subject: "",
    body: "",
    description: "",
    category: "General",
  });
  const emailBodyRef = useRef<HTMLTextAreaElement>(null);
  const insertBodyAtCursor = useCallback((field: string) => {
    const ta = emailBodyRef.current;
    if (ta) {
      const start = ta.selectionStart ?? form.body.length;
      const end = ta.selectionEnd ?? form.body.length;
      const newBody = form.body.slice(0, start) + field + form.body.slice(end);
      setForm(f => ({ ...f, body: newBody }));
      requestAnimationFrame(() => { ta.focus(); const p = start + field.length; ta.setSelectionRange(p, p); });
    } else { setForm(f => ({ ...f, body: f.body + field })); }
  }, [form.body]);

  const { data: templates, isLoading } = useQuery({
    queryKey: ["email-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("email_templates")
        .select("*")
        .order("name");
      if (error) throw error;
      return data as EmailTemplate[];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (template: typeof form) => {
      const { error } = await supabase.from("email_templates").insert({
        name: template.name,
        subject: template.subject,
        body: template.body,
        description: template.description || null,
        category: template.category,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Email template created");
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (error: any) => toast.error(error.message),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, template }: { id: string; template: typeof form }) => {
      const { error } = await supabase
        .from("email_templates")
        .update({
          name: template.name,
          subject: template.subject,
          body: template.body,
          description: template.description || null,
          category: template.category,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Email template updated");
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (error: any) => toast.error(error.message),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("email_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Email template deleted");
      setDeleteTemplateId(null);
      queryClient.invalidateQueries({ queryKey: ["email-templates"] });
    },
    onError: (error: any) => toast.error(error.message),
  });

  const resetForm = () => {
    setIsDialogOpen(false);
    setEditingTemplate(null);
    setForm({ name: "", subject: "", body: "", description: "", category: "General" });
  };

  const openEditDialog = (template: EmailTemplate) => {
    setEditingTemplate(template);
    setForm({
      name: template.name,
      subject: template.subject,
      body: template.body,
      description: template.description || "",
      category: template.category || "General",
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.subject || !form.body) {
      toast.error("Please fill in all required fields");
      return;
    }
    if (editingTemplate) {
      updateMutation.mutate({ id: editingTemplate.id, template: form });
    } else {
      createMutation.mutate(form);
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
      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Email Template Merge Fields</AlertTitle>
        <AlertDescription>
          <p className="mb-2 font-medium">Claim Fields:</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs font-mono mb-3">
            <div>{`{claim.policyholder_name}`}</div>
            <div>{`{claim.claim_number}`}</div>
            <div>{`{claim.status}`}</div>
            <div>{`{claim.loss_type}`}</div>
            <div>{`{claim.loss_date}`}</div>
            <div>{`{claim.policy_number}`}</div>
            <div>{`{claim.insurance_company}`}</div>
          </div>
          <p className="mb-2 font-medium">Settlement/Accounting Fields:</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs font-mono">
            <div>{`{settlement.dwelling_rcv}`}</div>
            <div>{`{settlement.dwelling_acv}`}</div>
            <div>{`{settlement.dwelling_net}`}</div>
            <div>{`{settlement.dwelling_deductible}`}</div>
            <div>{`{settlement.other_structures_rcv}`}</div>
            <div>{`{settlement.other_structures_net}`}</div>
            <div>{`{settlement.pwi_rcv}`}</div>
            <div>{`{settlement.pwi_net}`}</div>
            <div>{`{settlement.total_rcv}`}</div>
            <div>{`{settlement.total_net}`}</div>
            <div>{`{settlement.prior_offer}`}</div>
          </div>
          <p className="mt-3 mb-2 font-medium">Depreciation Fields:</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-1 text-xs font-mono">
            <div>{`{settlement.dwelling_recoverable_dep}`}</div>
            <div>{`{settlement.dwelling_non_recoverable_dep}`}</div>
            <div>{`{settlement.other_structures_recoverable_dep}`}</div>
            <div>{`{settlement.other_structures_non_recoverable_dep}`}</div>
            <div>{`{settlement.pwi_recoverable_dep}`}</div>
            <div>{`{settlement.pwi_non_recoverable_dep}`}</div>
            <div>{`{settlement.total_recoverable_dep}`}</div>
            <div>{`{settlement.total_non_recoverable_dep}`}</div>
          </div>
        </AlertDescription>
      </Alert>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-foreground">Email Templates</h2>
          <p className="text-muted-foreground text-sm">Create reusable email templates for claims and automations</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={(open) => open ? setIsDialogOpen(true) : resetForm()}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Template
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>{editingTemplate ? "Edit Email Template" : "Create Email Template"}</DialogTitle>
                <DialogDescription>
                  Create a reusable email template with merge fields
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4 py-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Template Name *</Label>
                    <Input
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g., 7-Day Follow-up"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Category</Label>
                    <Select value={form.category} onValueChange={(v) => setForm({ ...form, category: v })}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="General">General</SelectItem>
                        <SelectItem value="Follow-up">Follow-up</SelectItem>
                        <SelectItem value="Status Update">Status Update</SelectItem>
                        <SelectItem value="Welcome">Welcome</SelectItem>
                        <SelectItem value="Reminder">Reminder</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Description</Label>
                  <Input
                    value={form.description}
                    onChange={(e) => setForm({ ...form, description: e.target.value })}
                    placeholder="Brief description of when to use this template"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Email Subject *</Label>
                  <Input
                    value={form.subject}
                    onChange={(e) => setForm({ ...form, subject: e.target.value })}
                    placeholder="e.g., Update on Your Claim #${claim.claim_number}"
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Email Body *</Label>
                    <MergeFieldButtons onInsert={insertBodyAtCursor} />
                  </div>
                  <Textarea
                    ref={emailBodyRef}
                    value={form.body}
                    onChange={(e) => setForm({ ...form, body: e.target.value })}
                    placeholder="Dear ${policyholder},&#10;&#10;We wanted to provide you with an update..."
                    className="min-h-[200px]"
                  />
                </div>
                {(form.body || form.subject) && (
                  <div className="space-y-3">
                    {form.subject && (
                      <TemplatePreview text={form.subject} label="Subject Preview" />
                    )}
                    {form.body && (
                      <TemplatePreview text={form.body} label="Body Preview" />
                    )}
                  </div>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={resetForm}>
                  Cancel
                </Button>
                <Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
                  {(createMutation.isPending || updateMutation.isPending) && (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  )}
                  {editingTemplate ? "Save Changes" : "Create Template"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <div className="grid gap-4">
        {templates?.length === 0 && (
          <Card>
            <CardContent className="py-8 text-center text-muted-foreground">
              <Mail className="h-12 w-12 mx-auto mb-4 opacity-20" />
              <p>No email templates yet</p>
              <p className="text-sm mt-2">Create templates to streamline your email communications</p>
            </CardContent>
          </Card>
        )}
        {templates?.map((template) => (
          <Card key={template.id}>
            <CardHeader>
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Mail className="h-4 w-4 text-muted-foreground" />
                    <CardTitle className="text-lg">{template.name}</CardTitle>
                  </div>
                  {template.description && (
                    <CardDescription>{template.description}</CardDescription>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{template.category || "General"}</Badge>
                  <Button size="sm" variant="outline" onClick={() => openEditDialog(template)}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button size="sm" variant="destructive" onClick={() => setDeleteTemplateId(template.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="font-medium text-muted-foreground">Subject: </span>
                  <span>{template.subject}</span>
                </div>
                <div>
                  <span className="font-medium text-muted-foreground">Body: </span>
                  <span className="text-muted-foreground line-clamp-2">{template.body}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <AlertDialog open={!!deleteTemplateId} onOpenChange={() => setDeleteTemplateId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Email Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this email template? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTemplateId && deleteMutation.mutate(deleteTemplateId)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};
