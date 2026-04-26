import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Building2, Mail, Phone, User, Plus, Search, Pencil, Globe, Hash, MapPin,
} from "lucide-react";
import { formatPhoneNumber } from "@/lib/utils";

interface MortgageCompany {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  phone_extension: string | null;
  email: string | null;
  loan_number: string | null;
  mortgage_site: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  address_line_4: string | null;
  address_line_5: string | null;
  is_active: boolean;
}

const emptyForm = {
  name: "",
  contact_name: "",
  email: "",
  phone: "",
  phone_extension: "",
  mortgage_site: "",
  address_line_1: "",
  address_line_2: "",
  address_line_3: "",
  address_line_4: "",
  address_line_5: "",
};

interface Props {
  searchQuery?: string;
}

export function MortgageCompaniesDirectory({ searchQuery: externalSearch }: Props) {
  const [companies, setCompanies] = useState<MortgageCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MortgageCompany | null>(null);
  const [form, setForm] = useState({ ...emptyForm });
  const [saving, setSaving] = useState(false);

  const search = (externalSearch ?? "") || localSearch;

  useEffect(() => {
    void fetchCompanies();
  }, []);

  const fetchCompanies = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("mortgage_companies")
      .select(
        "id, name, contact_name, phone, phone_extension, email, loan_number, mortgage_site, address_line_1, address_line_2, address_line_3, address_line_4, address_line_5, is_active"
      )
      .eq("is_active", true)
      .order("name");

    if (error) {
      toast.error("Failed to load mortgage companies");
    } else {
      setCompanies((data || []) as MortgageCompany[]);
    }
    setLoading(false);
  };

  const filtered = useMemo(() => {
    if (!search.trim()) return companies;
    const q = search.toLowerCase();
    return companies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.contact_name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q)
    );
  }, [companies, search]);

  const openNew = () => {
    setEditing(null);
    setForm({ ...emptyForm });
    setDialogOpen(true);
  };

  const openEdit = (c: MortgageCompany) => {
    setEditing(c);
    setForm({
      name: c.name,
      contact_name: c.contact_name || "",
      email: c.email || "",
      phone: c.phone || "",
      phone_extension: c.phone_extension || "",
      mortgage_site: c.mortgage_site || "",
      address_line_1: c.address_line_1 || "",
      address_line_2: c.address_line_2 || "",
      address_line_3: c.address_line_3 || "",
      address_line_4: c.address_line_4 || "",
      address_line_5: c.address_line_5 || "",
    });
    setDialogOpen(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error("Company name is required");
      return;
    }
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      contact_name: form.contact_name.trim() || null,
      phone: form.phone.trim() || null,
      phone_extension: form.phone_extension.trim() || null,
      email: form.email.trim() || null,
      mortgage_site: form.mortgage_site.trim() || null,
      address_line_1: form.address_line_1.trim() || null,
      address_line_2: form.address_line_2.trim() || null,
      address_line_3: form.address_line_3.trim() || null,
      address_line_4: form.address_line_4.trim() || null,
      address_line_5: form.address_line_5.trim() || null,
    };
    const { error } = editing
      ? await supabase.from("mortgage_companies").update(payload).eq("id", editing.id)
      : await supabase.from("mortgage_companies").insert([payload]);

    setSaving(false);
    if (error) {
      toast.error(editing ? "Failed to update company" : "Failed to add company");
      return;
    }
    toast.success(editing ? "Company updated" : "Company added");
    setDialogOpen(false);
    void fetchCompanies();
  };

  return (
    <Card>
      <CardHeader className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Mortgage Companies
          </CardTitle>
          <p className="text-xs text-muted-foreground mt-1">
            Maintain mortgage servicer contacts. Loss drafts auto-link to a directory entry by company name.
          </p>
        </div>
        <Button onClick={openNew} size="sm">
          <Plus className="h-4 w-4 mr-1" />
          Add Company
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {externalSearch === undefined && (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by company, contact, email or phone…"
              value={localSearch}
              onChange={(e) => setLocalSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        )}

        {loading ? (
          <div className="py-12 text-center text-muted-foreground text-sm">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">
            {companies.length === 0
              ? "No mortgage companies yet. Add one to get started."
              : "No companies match your search."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead>Company</TableHead>
                  <TableHead>Contact</TableHead>
                  <TableHead>Phone</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Address</TableHead>
                  <TableHead className="w-[60px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((c) => {
                  const addr = [
                    c.address_line_1,
                    c.address_line_2,
                    c.address_line_3,
                  ]
                    .filter(Boolean)
                    .join(", ");
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          <Building2 className="h-4 w-4 text-muted-foreground" />
                          {c.name}
                        </div>
                        {c.mortgage_site && (
                          <a
                            href={c.mortgage_site}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-primary hover:underline flex items-center gap-1 mt-0.5"
                          >
                            <Globe className="h-2.5 w-2.5" />
                            Portal
                          </a>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.contact_name ? (
                          <span className="flex items-center gap-1.5">
                            <User className="h-3.5 w-3.5 text-muted-foreground" />
                            {c.contact_name}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.phone ? (
                          <a
                            href={`tel:${c.phone.replace(/[^\d+]/g, "")}`}
                            className="flex items-center gap-1.5 hover:underline"
                          >
                            <Phone className="h-3.5 w-3.5 text-muted-foreground" />
                            {c.phone}
                            {c.phone_extension && ` x${c.phone_extension}`}
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm">
                        {c.email ? (
                          <a
                            href={`mailto:${c.email}`}
                            className="flex items-center gap-1.5 hover:underline truncate max-w-[200px]"
                          >
                            <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className="truncate">{c.email}</span>
                          </a>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[220px]">
                        {addr ? (
                          <span className="flex items-start gap-1.5">
                            <MapPin className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                            <span className="line-clamp-2">{addr}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(c)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit Mortgage Company" : "Add Mortgage Company"}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b pb-1">
                Company
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <Label>Company Name *</Label>
                  <Input
                    value={form.name}
                    maxLength={200}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="e.g. Mr. Cooper"
                  />
                </div>
                <div>
                  <Label>Contact Name</Label>
                  <Input
                    value={form.contact_name}
                    maxLength={120}
                    onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                    placeholder="Loss draft dept rep"
                  />
                </div>
                <div>
                  <Label>Email</Label>
                  <Input
                    type="email"
                    value={form.email}
                    maxLength={255}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    placeholder="lossdraft@servicer.com"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="col-span-2">
                    <Label>Phone</Label>
                    <Input
                      type="tel"
                      value={form.phone}
                      onChange={(e) =>
                        setForm({ ...form, phone: formatPhoneNumber(e.target.value) })
                      }
                      placeholder="123-456-7890"
                    />
                  </div>
                  <div>
                    <Label>Ext</Label>
                    <Input
                      value={form.phone_extension}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          phone_extension: e.target.value.replace(/\D/g, "").slice(0, 6),
                        })
                      }
                      placeholder="1234"
                    />
                  </div>
                </div>
                <div className="md:col-span-2">
                  <Label className="flex items-center gap-1.5">
                    <Globe className="h-3 w-3" /> Portal URL
                  </Label>
                  <Input
                    type="url"
                    value={form.mortgage_site}
                    maxLength={500}
                    onChange={(e) => setForm({ ...form, mortgage_site: e.target.value })}
                    placeholder="https://insurance.servicer.com"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b pb-1">
                Address
              </h3>
              <div className="space-y-2">
                <Input
                  value={form.address_line_1}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, address_line_1: e.target.value })}
                  placeholder="Address line 1"
                />
                <Input
                  value={form.address_line_2}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, address_line_2: e.target.value })}
                  placeholder="Address line 2 (suite, attn, etc.)"
                />
                <Input
                  value={form.address_line_3}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, address_line_3: e.target.value })}
                  placeholder="City, State ZIP"
                />
                <Input
                  value={form.address_line_4}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, address_line_4: e.target.value })}
                  placeholder="Address line 4 (optional)"
                />
                <Input
                  value={form.address_line_5}
                  maxLength={200}
                  onChange={(e) => setForm({ ...form, address_line_5: e.target.value })}
                  placeholder="Address line 5 (optional)"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving…" : editing ? "Save Changes" : "Add Company"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
