import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Plus, Trash2, GripVertical, Loader2, Pencil } from "lucide-react";

interface CustomFieldsSettingsProps {
  embedded?: boolean;
}

export const CustomFieldsSettings = ({ embedded = false }: CustomFieldsSettingsProps) => {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingField, setEditingField] = useState<any>(null);
  const [fieldForm, setFieldForm] = useState({
    label: "",
    name: "",
    field_type: "text",
    options: [] as string[],
    is_required: false,
    visible_on_statuses: [] as string[],
  });
  const [optionInput, setOptionInput] = useState("");

  const { data: claimStatuses } = useQuery({
    queryKey: ["claim-statuses-for-fields"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_statuses")
        .select("id, name")
        .eq("is_active", true)
        .order("display_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: customFields, isLoading } = useQuery({
    queryKey: ["custom-fields"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_fields")
        .select("*")
        .order("display_order");
      if (error) throw error;
      return data;
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("custom_fields").insert({
        label: fieldForm.label,
        name: fieldForm.name || fieldForm.label.toLowerCase().replace(/\s+/g, '_'),
        field_type: fieldForm.field_type,
        options: fieldForm.options,
        is_required: fieldForm.is_required,
        visible_on_statuses: fieldForm.visible_on_statuses.length > 0 ? fieldForm.visible_on_statuses : null,
        display_order: (customFields?.length || 0) + 1,
      } as any);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Custom field created");
      setIsDialogOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["custom-fields"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!editingField) return;
      const { error } = await supabase
        .from("custom_fields")
        .update({
          label: fieldForm.label,
          name: fieldForm.name || fieldForm.label.toLowerCase().replace(/\s+/g, '_'),
          field_type: fieldForm.field_type,
          options: fieldForm.options,
          is_required: fieldForm.is_required,
          visible_on_statuses: fieldForm.visible_on_statuses.length > 0 ? fieldForm.visible_on_statuses : null,
        } as any)
        .eq("id", editingField.id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Custom field updated");
      setIsEditDialogOpen(false);
      setEditingField(null);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["custom-fields"] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("custom_fields")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Custom field deleted");
      queryClient.invalidateQueries({ queryKey: ["custom-fields"] });
    },
  });

  const toggleActiveMutation = useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const { error } = await supabase
        .from("custom_fields")
        .update({ is_active })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["custom-fields"] });
    },
  });

  const resetForm = () => {
    setFieldForm({
      label: "",
      name: "",
      field_type: "text",
      options: [],
      is_required: false,
      visible_on_statuses: [],
    });
    setOptionInput("");
  };

  const handleEditField = (field: any) => {
    setEditingField(field);
    setFieldForm({
      label: field.label,
      name: field.name,
      field_type: field.field_type,
      options: field.options || [],
      is_required: field.is_required,
      visible_on_statuses: field.visible_on_statuses || [],
    });
    setIsEditDialogOpen(true);
  };

  const addOption = () => {
    if (optionInput.trim()) {
      setFieldForm({
        ...fieldForm,
        options: [...fieldForm.options, optionInput.trim()],
      });
      setOptionInput("");
    }
  };

  const removeOption = (index: number) => {
    setFieldForm({
      ...fieldForm,
      options: fieldForm.options.filter((_, i) => i !== index),
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  const fieldFormContent = (
    <div className="space-y-4">
      <div>
        <Label>Field Label</Label>
        <Input
          value={fieldForm.label}
          onChange={(e) => setFieldForm({ ...fieldForm, label: e.target.value })}
          placeholder="e.g., Project Manager"
        />
      </div>
      <div>
        <Label>Field Type</Label>
        <Select
          value={fieldForm.field_type}
          onValueChange={(value) =>
            setFieldForm({ ...fieldForm, field_type: value })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="text">Text (Single Line)</SelectItem>
            <SelectItem value="textarea">Text Area (Multi-line)</SelectItem>
            <SelectItem value="select">Dropdown</SelectItem>
            <SelectItem value="number">Number</SelectItem>
            <SelectItem value="date">Date</SelectItem>
            <SelectItem value="checkbox">Checkbox</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {fieldForm.field_type === "select" && (
        <div>
          <Label>Dropdown Options</Label>
          <div className="flex gap-2 mb-2">
            <Input
              value={optionInput}
              onChange={(e) => setOptionInput(e.target.value)}
              placeholder="Add option"
              onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addOption())}
            />
            <Button type="button" onClick={addOption}>
              Add
            </Button>
          </div>
          <div className="space-y-1">
            {fieldForm.options.map((option, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-2 bg-muted rounded"
              >
                <span>{option}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeOption(index)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Switch
          checked={fieldForm.is_required}
          onCheckedChange={(checked) =>
            setFieldForm({ ...fieldForm, is_required: checked })
          }
        />
        <Label>Required field</Label>
      </div>

      <div>
        <Label>Show on Claim Statuses</Label>
        <p className="text-xs text-muted-foreground mb-2">
          Leave empty to show on all statuses. Select specific statuses to only show this field when a claim is in one of those statuses.
        </p>
        <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto border rounded-md p-3">
          {claimStatuses?.map((status) => (
            <div key={status.id} className="flex items-center gap-2">
              <Checkbox
                id={`status-${status.id}`}
                checked={fieldForm.visible_on_statuses.includes(status.name)}
                onCheckedChange={(checked) => {
                  if (checked) {
                    setFieldForm({
                      ...fieldForm,
                      visible_on_statuses: [...fieldForm.visible_on_statuses, status.name],
                    });
                  } else {
                    setFieldForm({
                      ...fieldForm,
                      visible_on_statuses: fieldForm.visible_on_statuses.filter((s) => s !== status.name),
                    });
                  }
                }}
              />
              <Label htmlFor={`status-${status.id}`} className="text-sm font-normal cursor-pointer">
                {status.name}
              </Label>
            </div>
          ))}
        </div>
        {fieldForm.visible_on_statuses.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {fieldForm.visible_on_statuses.map((s) => (
              <Badge key={s} variant="secondary" className="text-xs">
                {s}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const tableContent = (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-12"></TableHead>
          <TableHead>Label</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Visible On</TableHead>
          <TableHead>Required</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {customFields?.map((field) => (
          <TableRow key={field.id}>
            <TableCell>
              <GripVertical className="h-4 w-4 text-muted-foreground" />
            </TableCell>
            <TableCell className="font-medium">{field.label}</TableCell>
            <TableCell>
              <Badge variant="outline">
                {field.field_type === 'text' && 'Text'}
                {field.field_type === 'textarea' && 'Text Area'}
                {field.field_type === 'select' && 'Dropdown'}
                {field.field_type === 'number' && 'Number'}
                {field.field_type === 'date' && 'Date'}
                {field.field_type === 'checkbox' && 'Checkbox'}
              </Badge>
            </TableCell>
            <TableCell>
              {field.is_required ? (
                <Badge variant="destructive">Required</Badge>
              ) : (
                <Badge variant="secondary">Optional</Badge>
              )}
            </TableCell>
            <TableCell>
              <Switch
                checked={field.is_active}
                onCheckedChange={(checked) =>
                  toggleActiveMutation.mutate({ id: field.id, is_active: checked })
                }
              />
            </TableCell>
            <TableCell className="text-right">
              <div className="flex justify-end gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleEditField(field)}
                >
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => deleteMutation.mutate(field.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );

  if (embedded) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Field
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl">
              <DialogHeader>
                <DialogTitle>Create Custom Field</DialogTitle>
                <DialogDescription>
                  Add a new field that will appear on all claim overview pages
                </DialogDescription>
              </DialogHeader>
              {fieldFormContent}
              <DialogFooter>
                <Button
                  onClick={() => createMutation.mutate()}
                  disabled={!fieldForm.label || createMutation.isPending}
                >
                  {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  Create Field
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {tableContent}

        {/* Edit Dialog */}
        <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Edit Custom Field</DialogTitle>
              <DialogDescription>
                Update the field settings
              </DialogDescription>
            </DialogHeader>
            {fieldFormContent}
            <DialogFooter>
              <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => updateMutation.mutate()}
                disabled={!fieldForm.label || updateMutation.isPending}
              >
                {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Save Changes
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-foreground">Custom Fields</h2>
          <p className="text-muted-foreground">Add custom data fields to claim overview pages</p>
        </div>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Field
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create Custom Field</DialogTitle>
              <DialogDescription>
                Add a new field that will appear on all claim overview pages
              </DialogDescription>
            </DialogHeader>
            {fieldFormContent}
            <DialogFooter>
              <Button
                onClick={() => createMutation.mutate()}
                disabled={!fieldForm.label || createMutation.isPending}
              >
                {createMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Create Field
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Custom Fields</CardTitle>
          <CardDescription>
            {customFields?.length || 0} custom field(s) configured
          </CardDescription>
        </CardHeader>
        <CardContent>
          {tableContent}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Custom Field</DialogTitle>
            <DialogDescription>
              Update the field settings
            </DialogDescription>
          </DialogHeader>
          {fieldFormContent}
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsEditDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => updateMutation.mutate()}
              disabled={!fieldForm.label || updateMutation.isPending}
            >
              {updateMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};