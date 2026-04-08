import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { Plus, Pencil, Trash2, Search, Phone, Mail } from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";

interface Adjuster {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  phone_extension: string | null;
  company: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
}

export function AdjustersTab() {
  const queryClient = useQueryClient();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAdjuster, setEditingAdjuster] = useState<Adjuster | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    phone_extension: "",
    company: "",
    notes: "",
  });

  const { data: adjusters, isLoading } = useQuery({
    queryKey: ["adjusters-directory"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("adjusters")
        .select("*")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data as Adjuster[];
    },
  });

  const addMutation = useMutation({
    mutationFn: async (data: typeof formData) => {
      const { error } = await supabase.from("adjusters").insert({
        name: data.name,
        email: data.email || null,
        phone: data.phone || null,
        phone_extension: data.phone_extension || null,
        company: data.company || null,
        notes: data.notes || null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adjusters-directory"] });
      toast.success("Adjuster added");
      handleCloseDialog();
    },
    onError: () => toast.error("Failed to add adjuster"),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: typeof formData }) => {
      const { error } = await supabase
        .from("adjusters")
        .update({
          name: data.name,
          email: data.email || null,
          phone: data.phone || null,
          phone_extension: data.phone_extension || null,
          company: data.company || null,
          notes: data.notes || null,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adjusters-directory"] });
      toast.success("Adjuster updated");
      handleCloseDialog();
    },
    onError: () => toast.error("Failed to update adjuster"),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("adjusters")
        .update({ is_active: false })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["adjusters-directory"] });
      toast.success("Adjuster removed");
    },
    onError: () => toast.error("Failed to remove adjuster"),
  });

  const handleCloseDialog = () => {
    setIsDialogOpen(false);
    setEditingAdjuster(null);
    setFormData({ name: "", email: "", phone: "", phone_extension: "", company: "", notes: "" });
  };

  const handleOpenEdit = (adjuster: Adjuster) => {
    setEditingAdjuster(adjuster);
    setFormData({
      name: adjuster.name,
      email: adjuster.email || "",
      phone: adjuster.phone || "",
      phone_extension: adjuster.phone_extension || "",
      company: adjuster.company || "",
      notes: adjuster.notes || "",
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast.error("Name is required");
      return;
    }
    if (editingAdjuster) {
      updateMutation.mutate({ id: editingAdjuster.id, data: formData });
    } else {
      addMutation.mutate(formData);
    }
  };

  const filteredAdjusters = adjusters?.filter(
    (adj) =>
      adj.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      adj.company?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      adj.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>Adjusters Directory</CardTitle>
        <Button onClick={() => setIsDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Add Adjuster
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name, company, or email..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {isLoading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : filteredAdjusters?.length === 0 ? (
          <p className="text-muted-foreground text-center py-8">
            No adjusters found. Add your first adjuster to get started.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Contact</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredAdjusters?.map((adjuster) => (
                <TableRow key={adjuster.id}>
                  <TableCell className="font-medium">{adjuster.name}</TableCell>
                  <TableCell>{adjuster.company || "-"}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1 text-sm">
                      {adjuster.email && (
                        <div className="flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {adjuster.email}
                        </div>
                      )}
                      {adjuster.phone && (
                        <div className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {adjuster.phone}
                          {adjuster.phone_extension && ` ext ${adjuster.phone_extension}`}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleOpenEdit(adjuster)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate(adjuster.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingAdjuster ? "Edit Adjuster" : "Add Adjuster"}
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div>
                <Label>Name *</Label>
                <Input
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                  placeholder="Adjuster name"
                />
              </div>
              <div>
                <Label>Company</Label>
                <Input
                  value={formData.company}
                  onChange={(e) =>
                    setFormData({ ...formData, company: e.target.value })
                  }
                  placeholder="Insurance company"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  type="email"
                  value={formData.email}
                  onChange={(e) =>
                    setFormData({ ...formData, email: e.target.value })
                  }
                  placeholder="email@example.com"
                />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <Label>Phone</Label>
                  <Input
                    value={formData.phone}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        phone: formatPhoneNumber(e.target.value),
                      })
                    }
                    placeholder="555-123-4567"
                  />
                </div>
                <div>
                  <Label>Ext</Label>
                  <Input
                    value={formData.phone_extension}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        phone_extension: e.target.value.replace(/\D/g, "").slice(0, 6),
                      })
                    }
                    placeholder="1234"
                  />
                </div>
              </div>
              <div>
                <Label>Notes</Label>
                <Textarea
                  value={formData.notes}
                  onChange={(e) =>
                    setFormData({ ...formData, notes: e.target.value })
                  }
                  placeholder="Any notes about this adjuster..."
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={handleCloseDialog}>
                Cancel
              </Button>
              <Button onClick={handleSubmit}>
                {editingAdjuster ? "Save Changes" : "Add Adjuster"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
