import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { 
  Plus, 
  Trash2, 
  Edit2, 
  Award, 
  Calendar, 
  AlertTriangle, 
  CheckCircle, 
  Loader2,
  GraduationCap,
  X
} from "lucide-react";
import { format, differenceInDays, parseISO } from "date-fns";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

interface License {
  id: string;
  user_id: string;
  license_type: string;
  license_number: string;
  license_state: string;
  issue_date: string | null;
  expiration_date: string | null;
  ce_credits_required: number | null;
  ce_credits_completed: number | null;
  ce_renewal_date: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

const LICENSE_TYPES = [
  "Public Adjuster",
  "Contractor",
  "Roofing Contractor",
  "General Contractor",
  "Insurance Agent",
  "Real Estate",
  "Other"
];

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY"
];

export function LicensesSettings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingLicense, setEditingLicense] = useState<License | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  
  const [formData, setFormData] = useState({
    license_type: "Public Adjuster",
    license_number: "",
    license_state: "",
    issue_date: "",
    expiration_date: "",
    ce_credits_required: "",
    ce_credits_completed: "",
    ce_renewal_date: "",
    notes: ""
  });

  const { data: licenses, isLoading } = useQuery({
    queryKey: ["user-licenses", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("user_licenses")
        .select("*")
        .eq("user_id", user.id)
        .order("expiration_date", { ascending: true });
      
      if (error) throw error;
      return data as License[];
    },
    enabled: !!user
  });

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<License>) => {
      if (!user) throw new Error("Not authenticated");
      
      const licenseData = {
        user_id: user.id,
        license_type: data.license_type,
        license_number: data.license_number,
        license_state: data.license_state,
        issue_date: data.issue_date || null,
        expiration_date: data.expiration_date || null,
        ce_credits_required: data.ce_credits_required || null,
        ce_credits_completed: data.ce_credits_completed || 0,
        ce_renewal_date: data.ce_renewal_date || null,
        notes: data.notes || null,
        is_active: true
      };

      if (editingLicense) {
        const { error } = await supabase
          .from("user_licenses")
          .update(licenseData)
          .eq("id", editingLicense.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from("user_licenses")
          .insert(licenseData);
        if (error) throw error;
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-licenses"] });
      toast.success(editingLicense ? "License updated" : "License added");
      handleCloseDialog();
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to save license");
    }
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("user_licenses")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-licenses"] });
      toast.success("License removed");
      setDeletingId(null);
    },
    onError: (error: any) => {
      toast.error(error.message || "Failed to delete license");
    }
  });

  const handleOpenDialog = (license?: License) => {
    if (license) {
      setEditingLicense(license);
      setFormData({
        license_type: license.license_type,
        license_number: license.license_number,
        license_state: license.license_state,
        issue_date: license.issue_date || "",
        expiration_date: license.expiration_date || "",
        ce_credits_required: license.ce_credits_required?.toString() || "",
        ce_credits_completed: license.ce_credits_completed?.toString() || "",
        ce_renewal_date: license.ce_renewal_date || "",
        notes: license.notes || ""
      });
    } else {
      setEditingLicense(null);
      setFormData({
        license_type: "Public Adjuster",
        license_number: "",
        license_state: "",
        issue_date: "",
        expiration_date: "",
        ce_credits_required: "",
        ce_credits_completed: "",
        ce_renewal_date: "",
        notes: ""
      });
    }
    setDialogOpen(true);
  };

  const handleCloseDialog = () => {
    setDialogOpen(false);
    setEditingLicense(null);
  };

  const handleSubmit = () => {
    if (!formData.license_number || !formData.license_state) {
      toast.error("License number and state are required");
      return;
    }

    saveMutation.mutate({
      license_type: formData.license_type,
      license_number: formData.license_number,
      license_state: formData.license_state,
      issue_date: formData.issue_date || null,
      expiration_date: formData.expiration_date || null,
      ce_credits_required: formData.ce_credits_required ? parseInt(formData.ce_credits_required) : null,
      ce_credits_completed: formData.ce_credits_completed ? parseInt(formData.ce_credits_completed) : 0,
      ce_renewal_date: formData.ce_renewal_date || null,
      notes: formData.notes || null
    } as Partial<License>);
  };

  const getExpirationStatus = (expirationDate: string | null) => {
    if (!expirationDate) return null;
    
    const days = differenceInDays(parseISO(expirationDate), new Date());
    
    if (days < 0) {
      return { status: "expired", label: "Expired", color: "bg-red-500", days: Math.abs(days) };
    } else if (days <= 30) {
      return { status: "critical", label: `${days} days`, color: "bg-red-500", days };
    } else if (days <= 60) {
      return { status: "warning", label: `${days} days`, color: "bg-yellow-500", days };
    } else if (days <= 90) {
      return { status: "upcoming", label: `${days} days`, color: "bg-orange-500", days };
    }
    return { status: "ok", label: `${days} days`, color: "bg-green-500", days };
  };

  const getCEStatus = (required: number | null, completed: number | null) => {
    if (!required || required === 0) return null;
    const pct = ((completed || 0) / required) * 100;
    if (pct >= 100) return { status: "complete", pct: 100 };
    if (pct >= 75) return { status: "good", pct };
    if (pct >= 50) return { status: "warning", pct };
    return { status: "behind", pct };
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Award className="h-5 w-5" />
                Professional Licenses
              </CardTitle>
              <CardDescription>
                Track your licenses, expiration dates, and CE credits
              </CardDescription>
            </div>
            <Button onClick={() => handleOpenDialog()} size="sm">
              <Plus className="h-4 w-4 mr-2" />
              Add License
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {!licenses || licenses.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Award className="h-12 w-12 mx-auto mb-4 opacity-50" />
              <p>No licenses added yet</p>
              <Button 
                variant="outline" 
                onClick={() => handleOpenDialog()} 
                className="mt-4"
              >
                <Plus className="h-4 w-4 mr-2" />
                Add Your First License
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              {licenses.map((license) => {
                const expStatus = getExpirationStatus(license.expiration_date);
                const ceStatus = getCEStatus(license.ce_credits_required, license.ce_credits_completed);
                
                return (
                  <div 
                    key={license.id} 
                    className="flex items-start justify-between p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors"
                  >
                    <div className="space-y-2 flex-1">
                      <div className="flex items-center gap-3">
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">{license.license_state}</Badge>
                          <span className="font-semibold">{license.license_number}</span>
                        </div>
                        <Badge variant="secondary">{license.license_type}</Badge>
                      </div>
                      
                      <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground">
                        {license.expiration_date && (
                          <div className="flex items-center gap-1.5">
                            <Calendar className="h-3.5 w-3.5" />
                            <span>Expires: {format(parseISO(license.expiration_date), "MMM d, yyyy")}</span>
                            {expStatus && (
                              <Badge 
                                className={`${expStatus.color} text-white text-xs ml-1`}
                              >
                                {expStatus.status === "expired" ? `${expStatus.days}d overdue` : expStatus.label}
                              </Badge>
                            )}
                          </div>
                        )}
                        
                        {license.ce_credits_required && (
                          <div className="flex items-center gap-1.5">
                            <GraduationCap className="h-3.5 w-3.5" />
                            <span>
                              CE: {license.ce_credits_completed || 0}/{license.ce_credits_required}
                            </span>
                            {ceStatus && (
                              <Badge 
                                variant={ceStatus.status === "complete" ? "default" : "secondary"}
                                className="text-xs"
                              >
                                {Math.round(ceStatus.pct)}%
                              </Badge>
                            )}
                          </div>
                        )}
                      </div>
                      
                      {license.notes && (
                        <p className="text-xs text-muted-foreground italic mt-1">{license.notes}</p>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2 ml-4">
                      <Button 
                        variant="ghost" 
                        size="icon" 
                        onClick={() => handleOpenDialog(license)}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="icon"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeletingId(license.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
              
              {/* Expiration Warnings Summary */}
              {licenses.some(l => {
                const status = getExpirationStatus(l.expiration_date);
                return status && (status.status === "expired" || status.status === "critical" || status.status === "warning");
              }) && (
                <div className="mt-4 p-4 rounded-lg bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-800">
                  <div className="flex items-center gap-2 text-yellow-800 dark:text-yellow-200">
                    <AlertTriangle className="h-4 w-4" />
                    <span className="font-medium text-sm">License Renewal Reminders</span>
                  </div>
                  <ul className="mt-2 space-y-1 text-sm text-yellow-700 dark:text-yellow-300">
                    {licenses
                      .filter(l => {
                        const status = getExpirationStatus(l.expiration_date);
                        return status && (status.status === "expired" || status.status === "critical" || status.status === "warning");
                      })
                      .map(l => {
                        const status = getExpirationStatus(l.expiration_date)!;
                        return (
                          <li key={l.id}>
                            • {l.license_state} {l.license_type} ({l.license_number}): {status.status === "expired" ? "EXPIRED" : `Expires in ${status.days} days`}
                          </li>
                        );
                      })}
                  </ul>
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editingLicense ? "Edit License" : "Add License"}</DialogTitle>
            <DialogDescription>
              {editingLicense ? "Update your license information" : "Add a new professional license to track"}
            </DialogDescription>
          </DialogHeader>
          
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>License Type *</Label>
                <Select 
                  value={formData.license_type} 
                  onValueChange={(v) => setFormData(prev => ({ ...prev, license_type: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LICENSE_TYPES.map(type => (
                      <SelectItem key={type} value={type}>{type}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              <div className="space-y-2">
                <Label>State *</Label>
                <Select 
                  value={formData.license_state} 
                  onValueChange={(v) => setFormData(prev => ({ ...prev, license_state: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select state" />
                  </SelectTrigger>
                  <SelectContent>
                    {US_STATES.map(state => (
                      <SelectItem key={state} value={state}>{state}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>License Number *</Label>
              <Input
                value={formData.license_number}
                onChange={(e) => setFormData(prev => ({ ...prev, license_number: e.target.value }))}
                placeholder="PA-12345"
              />
            </div>
            
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Issue Date</Label>
                <Input
                  type="date"
                  value={formData.issue_date}
                  onChange={(e) => setFormData(prev => ({ ...prev, issue_date: e.target.value }))}
                />
              </div>
              
              <div className="space-y-2">
                <Label>Expiration Date</Label>
                <Input
                  type="date"
                  value={formData.expiration_date}
                  onChange={(e) => setFormData(prev => ({ ...prev, expiration_date: e.target.value }))}
                />
              </div>
            </div>
            
            <div className="border-t pt-4">
              <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                <GraduationCap className="h-4 w-4" />
                Continuing Education
              </h4>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label>Credits Required</Label>
                  <Input
                    type="number"
                    value={formData.ce_credits_required}
                    onChange={(e) => setFormData(prev => ({ ...prev, ce_credits_required: e.target.value }))}
                    placeholder="24"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>Credits Completed</Label>
                  <Input
                    type="number"
                    value={formData.ce_credits_completed}
                    onChange={(e) => setFormData(prev => ({ ...prev, ce_credits_completed: e.target.value }))}
                    placeholder="0"
                  />
                </div>
                
                <div className="space-y-2">
                  <Label>CE Due Date</Label>
                  <Input
                    type="date"
                    value={formData.ce_renewal_date}
                    onChange={(e) => setFormData(prev => ({ ...prev, ce_renewal_date: e.target.value }))}
                  />
                </div>
              </div>
            </div>
            
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={formData.notes}
                onChange={(e) => setFormData(prev => ({ ...prev, notes: e.target.value }))}
                placeholder="Any additional notes about this license..."
                rows={2}
              />
            </div>
          </div>
          
          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDialog}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingLicense ? "Update" : "Add License"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <Dialog open={!!deletingId} onOpenChange={() => setDeletingId(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete License?</DialogTitle>
            <DialogDescription>
              This will permanently remove this license from your profile.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeletingId(null)}>Cancel</Button>
            <Button 
              variant="destructive" 
              onClick={() => deletingId && deleteMutation.mutate(deletingId)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
