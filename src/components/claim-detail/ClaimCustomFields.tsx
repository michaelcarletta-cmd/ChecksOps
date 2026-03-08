import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Save } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

interface ClaimCustomFieldsProps {
  claimId: string;
  claimStatus?: string;
}

export function ClaimCustomFields({ claimId, claimStatus }: ClaimCustomFieldsProps) {
  const queryClient = useQueryClient();
  const [fieldValues, setFieldValues] = useState<Record<string, any>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const { data: customFields } = useQuery({
    queryKey: ["custom-fields"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("custom_fields")
        .select("*")
        .eq("is_active", true)
        .order("display_order");
      if (error) throw error;
      return data;
    },
  });

  const { data: existingValues } = useQuery({
    queryKey: ["claim-custom-field-values", claimId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("claim_custom_field_values")
        .select("*")
        .eq("claim_id", claimId);
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (existingValues) {
      const values: Record<string, any> = {};
      existingValues.forEach((val) => {
        values[val.custom_field_id] = val.value;
      });
      setFieldValues(values);
    }
  }, [existingValues]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const updates = Object.entries(fieldValues).map(([fieldId, value]) => ({
        claim_id: claimId,
        custom_field_id: fieldId,
        value: value?.toString() || null,
      }));

      for (const update of updates) {
        const { error } = await supabase
          .from("claim_custom_field_values")
          .upsert(update, { onConflict: "claim_id,custom_field_id" });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Custom fields saved");
      setHasChanges(false);
      queryClient.invalidateQueries({ queryKey: ["claim-custom-field-values", claimId] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const handleValueChange = (fieldId: string, value: any) => {
    setFieldValues((prev) => ({ ...prev, [fieldId]: value }));
    setHasChanges(true);
  };

  const renderField = (field: any) => {
    const value = fieldValues[field.id];

    switch (field.field_type) {
      case "text":
        return (
          <Input
            value={value || ""}
            onChange={(e) => handleValueChange(field.id, e.target.value)}
            placeholder={field.label}
          />
        );

      case "textarea":
        return (
          <Textarea
            value={value || ""}
            onChange={(e) => handleValueChange(field.id, e.target.value)}
            placeholder={field.label}
            rows={3}
          />
        );

      case "select":
        return (
          <Select
            value={value || ""}
            onValueChange={(val) => handleValueChange(field.id, val)}
          >
            <SelectTrigger>
              <SelectValue placeholder={`Select ${field.label}`} />
            </SelectTrigger>
            <SelectContent>
              {field.options?.map((option: string) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        );

      case "number":
        return (
          <Input
            type="number"
            value={value || ""}
            onChange={(e) => handleValueChange(field.id, e.target.value)}
            placeholder={field.label}
          />
        );

      case "date":
        return (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className={cn(
                  "w-full justify-start text-left font-normal",
                  !value && "text-muted-foreground"
                )}
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {value ? format(new Date(value), "PPP") : <span>Pick a date</span>}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={value ? new Date(value) : undefined}
                onSelect={(date) => handleValueChange(field.id, date?.toISOString())}
                initialFocus
                className={cn("p-3 pointer-events-auto")}
              />
            </PopoverContent>
          </Popover>
        );

      case "checkbox":
        return (
          <div className="flex items-center gap-2">
            <Checkbox
              checked={value === "true"}
              onCheckedChange={(checked) =>
                handleValueChange(field.id, checked ? "true" : "false")
              }
            />
            <Label>{field.label}</Label>
          </div>
        );

      default:
        return null;
    }
  };

  // Filter fields by claim status visibility
  const visibleFields = customFields?.filter((field: any) => {
    if (!field.visible_on_statuses || field.visible_on_statuses.length === 0) {
      return true; // null/empty = show on all statuses
    }
    return claimStatus && field.visible_on_statuses.includes(claimStatus);
  });

  if (!visibleFields || visibleFields.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Additional Information</CardTitle>
          {hasChanges && (
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
            >
              <Save className="h-4 w-4 mr-2" />
              Save Changes
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 md:grid-cols-2">
          {visibleFields.map((field: any) => (
            <div key={field.id} className="space-y-2">
              <Label>
                {field.label}
                {field.is_required && <span className="text-destructive ml-1">*</span>}
              </Label>
              {renderField(field)}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
