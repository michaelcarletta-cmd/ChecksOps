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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import { Upload, FileText, Trash2, Download, Loader2, Info, Layout, Mail, MessageSquare, ChevronDown, Edit, Save, X, Wand2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SIGNER_DISPLAY_TEMPLATES, DOCUMENT_TYPE_OPTIONS, getFieldTemplateKey } from "@/lib/signer-display-templates";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { EmailTemplatesSettings } from "./EmailTemplatesSettings";
import SMSTemplatesSettings from "./SMSTemplatesSettings";

export const TemplatesSettings = () => {
  const queryClient = useQueryClient();
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [templateForm, setTemplateForm] = useState({
    name: "",
    description: "",
    category: "Contract",
    file: null as File | null,
  });

  const { data: templates, isLoading } = useQuery({
    queryKey: ["document-templates-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_templates")
        .select("*")
        .order("name");
      if (error) throw error;
      return data;
    },
  });


  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!templateForm.file) throw new Error("No file selected");

      // Sanitize filename: remove special characters and replace spaces with underscores
      const sanitizedName = templateForm.file.name
        .replace(/[^a-zA-Z0-9.-]/g, '_')
        .replace(/_+/g, '_');
      const fileName = `${Date.now()}-${sanitizedName}`;
      
      const { error: uploadError } = await supabase.storage
        .from("document-templates")
        .upload(fileName, templateForm.file);

      if (uploadError) throw uploadError;

      const { error: dbError } = await supabase
        .from("document_templates")
        .insert({
          name: templateForm.name,
          description: templateForm.description,
          category: templateForm.category,
          file_path: fileName,
          file_name: templateForm.file.name,
        });

      if (dbError) throw dbError;
    },
    onSuccess: () => {
      toast.success("Template uploaded successfully");
      setIsUploadOpen(false);
      setTemplateForm({ name: "", description: "", category: "Contract", file: null });
      queryClient.invalidateQueries({ queryKey: ["document-templates-all"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (template: any) => {
      // Delete from storage
      await supabase.storage
        .from("document-templates")
        .remove([template.file_path]);

      // Delete from database
      const { error } = await supabase
        .from("document_templates")
        .delete()
        .eq("id", template.id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Template deleted");
      queryClient.invalidateQueries({ queryKey: ["document-templates-all"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });


  const handleDownload = async (template: any) => {
    try {
      const { data, error } = await supabase.storage
        .from("document-templates")
        .download(template.file_path);

      if (error) throw error;

      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = template.file_name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error: any) {
      toast.error(error.message);
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
      <Tabs defaultValue="documents" className="space-y-6">
        <TabsList className="flex flex-col md:flex-row h-auto w-full bg-muted/40 p-2 gap-1">
          <TabsTrigger value="documents" className="w-full md:w-auto justify-start text-base font-medium px-4 flex items-center gap-2">
            <FileText className="h-4 w-4" />
            Document Templates
          </TabsTrigger>
          <TabsTrigger value="email" className="w-full md:w-auto justify-start text-base font-medium px-4 flex items-center gap-2">
            <Mail className="h-4 w-4" />
            Email Templates
          </TabsTrigger>
          <TabsTrigger value="sms" className="w-full md:w-auto justify-start text-base font-medium px-4 flex items-center gap-2">
            <MessageSquare className="h-4 w-4" />
            SMS Templates
          </TabsTrigger>
        </TabsList>

        <TabsContent value="documents" className="space-y-6">
      <Collapsible>
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle className="flex items-center justify-between">
            <span>Template Merge Fields</span>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1">
                Show Fields
                <ChevronDown className="h-3 w-3" />
              </Button>
            </CollapsibleTrigger>
          </AlertTitle>
          <CollapsibleContent>
            <AlertDescription className="mt-2">
              <p className="mb-2 text-sm">Use these fields in your Word templates with dollar sign and curly braces:</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm font-mono">
                <div>{`\${policyholder}`}</div>
                <div>{`\${policy}`}</div>
                <div>{`\${insurance_company}`}</div>
                <div>{`\${address.street}`}</div>
                <div>{`\${address.city}`}</div>
                <div>{`\${claim.loss_date}`}</div>
                <div>{`\${claim.loss_type}`}</div>
                <div>{`\${mortgage_company}`}</div>
                <div>{`\${loan_number}`}</div>
                <div>{`\${ssn_last_four}`}</div>
              </div>
              <p className="mt-3 mb-2 font-medium">Settlement/Accounting Fields:</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm font-mono">
                <div>{`\${settlement.total_rcv}`}</div>
                <div>{`\${settlement.total_net}`}</div>
                <div>{`\${settlement.total_deductible}`}</div>
                <div>{`\${settlement.dwelling_rcv}`}</div>
                <div>{`\${settlement.dwelling_acv}`}</div>
                <div>{`\${settlement.dwelling_net}`}</div>
                <div>{`\${settlement.other_structures_rcv}`}</div>
                <div>{`\${settlement.pwi_rcv}`}</div>
                <div>{`\${settlement.prior_offer}`}</div>
                <div>{`\${settlement.total_checks}`}</div>
                <div>{`\${settlement.outstanding}`}</div>
              </div>
              <p className="mt-3 mb-2 font-medium">Depreciation Fields:</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm font-mono">
                <div>{`\${settlement.dwelling_recoverable_dep}`}</div>
                <div>{`\${settlement.dwelling_non_recoverable_dep}`}</div>
                <div>{`\${settlement.other_structures_recoverable_dep}`}</div>
                <div>{`\${settlement.other_structures_non_recoverable_dep}`}</div>
                <div>{`\${settlement.pwi_recoverable_dep}`}</div>
                <div>{`\${settlement.pwi_non_recoverable_dep}`}</div>
                <div>{`\${settlement.total_recoverable_dep}`}</div>
                <div>{`\${settlement.total_non_recoverable_dep}`}</div>
              </div>
            </AlertDescription>
          </CollapsibleContent>
        </Alert>
      </Collapsible>

      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl md:text-2xl font-bold text-foreground">Document Templates</h2>
          <p className="text-muted-foreground text-sm">Manage templates available across all claims</p>
        </div>
        <Dialog open={isUploadOpen} onOpenChange={setIsUploadOpen}>
          <DialogTrigger asChild>
            <Button>
              <Upload className="h-4 w-4 mr-2" />
              Upload Template
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Upload Document Template</DialogTitle>
              <DialogDescription>
                Upload a Word document (.docx) with merge fields or a PDF document
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Template Name</Label>
                <Input
                  value={templateForm.name}
                  onChange={(e) => setTemplateForm({ ...templateForm, name: e.target.value })}
                  placeholder="e.g., Standard Contract"
                />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  value={templateForm.description}
                  onChange={(e) => setTemplateForm({ ...templateForm, description: e.target.value })}
                  placeholder="Optional description"
                />
              </div>
              <div>
                <Label>Category</Label>
                <Select
                  value={templateForm.category}
                  onValueChange={(value) => setTemplateForm({ ...templateForm, category: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Contract">Contract</SelectItem>
                    <SelectItem value="Invoice">Invoice</SelectItem>
                    <SelectItem value="Letter">Letter</SelectItem>
                    <SelectItem value="Form">Form</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Template File (DOCX or PDF)</Label>
                <Input
                  type="file"
                  accept=".docx,.pdf"
                  onChange={(e) =>
                    setTemplateForm({ ...templateForm, file: e.target.files?.[0] || null })
                  }
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => uploadMutation.mutate()}
                disabled={!templateForm.name || !templateForm.file || uploadMutation.isPending}
              >
                {uploadMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Upload
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All Templates</CardTitle>
          <CardDescription>
            {templates?.length || 0} template(s) available
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Name</TableHead>
                <TableHead className="whitespace-nowrap">Category</TableHead>
                <TableHead className="whitespace-nowrap">File Name</TableHead>
                <TableHead className="whitespace-nowrap">Status</TableHead>
                <TableHead className="text-right whitespace-nowrap">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates?.map((template) => (
                <TableRow key={template.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4 text-muted-foreground" />
                      <div>
                        <div className="font-medium">{template.name}</div>
                        {template.description && (
                          <div className="text-sm text-muted-foreground">
                            {template.description}
                          </div>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{template.category}</Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {template.file_name}
                  </TableCell>
                  <TableCell>
                    <Badge variant={template.is_active ? "default" : "secondary"}>
                      {template.is_active ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleDownload(template)}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => deleteMutation.mutate(template)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

        </TabsContent>

        <TabsContent value="email">
          <EmailTemplatesSettings />
        </TabsContent>

        <TabsContent value="sms">
          <SMSTemplatesSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
};
