import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import {
  Building2, Mail, Phone, User, Plus, Search, Pencil, Globe, MapPin,
} from "lucide-react";
import {
  MortgageCompanyEditorDialog,
  type MortgageCompanyRecord,
} from "./MortgageCompanyEditorDialog";

interface Props {
  searchQuery?: string;
}

export function MortgageCompaniesDirectory({ searchQuery: externalSearch }: Props) {
  const [companies, setCompanies] = useState<MortgageCompanyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<MortgageCompanyRecord | null>(null);

  const search = (externalSearch ?? "") || localSearch;

  useEffect(() => {
    void fetchCompanies();
  }, []);

  const fetchCompanies = async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from("mortgage_companies")
      .select(
        "id, name, contact_name, phone, phone_extension, email, mortgage_site, address_line_1, address_line_2, address_line_3, address_line_4, address_line_5, is_active"
      )
      .eq("is_active", true)
      .order("name");

    if (error) {
      toast.error("Failed to load mortgage companies");
    } else {
      setCompanies((data || []) as MortgageCompanyRecord[]);
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
    setDialogOpen(true);
  };

  const openEdit = (c: MortgageCompanyRecord) => {
    setEditing(c);
    setDialogOpen(true);
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
            Source of truth for mortgage servicer contacts. Loss drafts auto-link by name —
            updates here flow to every claim instantly.
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
                  const addr = [c.address_line_1, c.address_line_2, c.address_line_3]
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
                            <Globe className="h-2.5 w-2.5" /> Portal
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

      <MortgageCompanyEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        company={editing}
        onSaved={() => void fetchCompanies()}
      />
    </Card>
  );
}
