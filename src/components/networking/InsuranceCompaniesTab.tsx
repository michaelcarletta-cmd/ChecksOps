import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toast } from "sonner";
import { Building, Mail, Phone, Plus, Search, Pencil } from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";

interface InsuranceCompany {
  id: string;
  name: string;
  phone: string | null;
  phone_extension: string | null;
  email: string | null;
  is_active: boolean;
}

export const InsuranceCompaniesTab = () => {
  const [companies, setCompanies] = useState<InsuranceCompany[]>([]);
  const [filteredCompanies, setFilteredCompanies] = useState<InsuranceCompany[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<InsuranceCompany | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    phone: "",
    phone_extension: "",
  });

  useEffect(() => {
    fetchCompanies();
  }, []);

  useEffect(() => {
    const filtered = companies.filter((company) => {
      const searchLower = searchQuery.toLowerCase();
      return (
        company.name.toLowerCase().includes(searchLower) ||
        company.email?.toLowerCase().includes(searchLower) ||
        company.phone?.toLowerCase().includes(searchLower)
      );
    });
    setFilteredCompanies(filtered);
  }, [companies, searchQuery]);

  const fetchCompanies = async () => {
    const { data, error } = await supabase
      .from("insurance_companies")
      .select("*")
      .order("name");

    if (error) {
      toast.error("Failed to fetch insurance companies");
      return;
    }

    setCompanies(data || []);
  };

  const handleOpenDialog = (company?: InsuranceCompany) => {
    if (company) {
      setEditingCompany(company);
      setFormData({
        name: company.name,
        email: company.email || "",
        phone: company.phone || "",
        phone_extension: company.phone_extension || "",
      });
    } else {
      setEditingCompany(null);
      setFormData({ name: "", email: "", phone: "", phone_extension: "" });
    }
    setDialogOpen(true);
  };

  const handleSaveCompany = async () => {
    if (!formData.name.trim()) {
      toast.error("Company name is required");
      return;
    }

    if (editingCompany) {
      const { error } = await supabase
        .from("insurance_companies")
        .update({
          name: formData.name,
          phone: formData.phone || null,
          phone_extension: formData.phone_extension || null,
          email: formData.email || null,
        })
        .eq("id", editingCompany.id);

      if (error) {
        toast.error("Failed to update company");
        return;
      }
      toast.success("Company updated");
    } else {
      const { error } = await supabase
        .from("insurance_companies")
        .insert([{
          name: formData.name,
          phone: formData.phone || null,
          phone_extension: formData.phone_extension || null,
          email: formData.email || null,
        }]);

      if (error) {
        toast.error("Failed to add company");
        return;
      }
      toast.success("Company added");
    }

    setDialogOpen(false);
    setEditingCompany(null);
    setFormData({ name: "", email: "", phone: "", phone_extension: "" });
    fetchCompanies();
  };

  return (
    <Card>
      <CardHeader className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <CardTitle>Insurance Companies</CardTitle>
        <Button onClick={() => handleOpenDialog()}>
          <Plus className="h-4 w-4 mr-2" />
          Add Company
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by company name, email, or phone..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        {filteredCompanies.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground">
            {companies.length === 0 ? "No insurance companies found" : "No companies match your search"}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[500px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="whitespace-nowrap">Company Name</TableHead>
                  <TableHead className="whitespace-nowrap">Email</TableHead>
                  <TableHead className="whitespace-nowrap">Phone</TableHead>
                  <TableHead className="w-[50px]"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredCompanies.map((company) => (
                  <TableRow key={company.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <Building className="h-4 w-4 text-muted-foreground" />
                        {company.name}
                      </div>
                    </TableCell>
                    <TableCell>
                      {company.email ? (
                        <div className="flex items-center gap-2">
                          <Mail className="h-4 w-4 text-muted-foreground" />
                          {company.email}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {company.phone ? (
                        <div className="flex items-center gap-2">
                          <Phone className="h-4 w-4 text-muted-foreground" />
                          {company.phone}
                          {company.phone_extension && ` ext ${company.phone_extension}`}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => handleOpenDialog(company)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCompany ? "Edit" : "Add"} Insurance Company</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Company Name *</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                placeholder="Enter company name"
              />
            </div>
            <div>
              <Label>Email</Label>
              <Input
                type="email"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                placeholder="Enter email"
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="col-span-2">
                <Label>Phone</Label>
                <Input
                  type="tel"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: formatPhoneNumber(e.target.value) })}
                  placeholder="123-456-7890"
                />
              </div>
              <div>
                <Label>Ext</Label>
                <Input
                  value={formData.phone_extension}
                  onChange={(e) => setFormData({ ...formData, phone_extension: e.target.value.replace(/\D/g, "").slice(0, 6) })}
                  placeholder="1234"
                />
              </div>
            </div>
            <Button onClick={handleSaveCompany} className="w-full">
              {editingCompany ? "Save Changes" : "Add Company"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
};
