import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Building2, Mail, Phone, Globe, MapPin, Search, User, Loader2 } from "lucide-react";

interface MortgageCompany {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  phone_extension: string | null;
  email: string | null;
  mortgage_site: string | null;
  address_line_1: string | null;
  address_line_2: string | null;
  address_line_3: string | null;
  address_line_4: string | null;
  address_line_5: string | null;
}

function formatAddress(c: MortgageCompany) {
  return [c.address_line_1, c.address_line_2, c.address_line_3, c.address_line_4, c.address_line_5]
    .filter((l) => l && l.trim())
    .join(", ");
}

export function MortgageOpsDirectory() {
  const [companies, setCompanies] = useState<MortgageCompany[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("mortgage_companies")
        .select(
          "id, name, contact_name, phone, phone_extension, email, mortgage_site, address_line_1, address_line_2, address_line_3, address_line_4, address_line_5"
        )
        .eq("is_active", true)
        .order("name");
      if (error) {
        toast.error("Failed to load mortgage directory");
      } else {
        setCompanies((data || []) as MortgageCompany[]);
      }
      setLoading(false);
    })();
  }, []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return companies;
    return companies.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.contact_name?.toLowerCase().includes(q) ||
        c.email?.toLowerCase().includes(q) ||
        c.phone?.toLowerCase().includes(q) ||
        formatAddress(c).toLowerCase().includes(q)
    );
  }, [companies, search]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="h-5 w-5" />
            Mortgage Directory
            <Badge variant="secondary" className="ml-1">{companies.length}</Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Phone numbers, emails, and mailing addresses for the mortgage companies we work with.
          </p>
        </CardHeader>
        <CardContent>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by company, contact, phone, email, or address…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9"
            />
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No mortgage companies match your search.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {filtered.map((c) => {
            const address = formatAddress(c);
            return (
              <Card key={c.id}>
                <CardHeader className="pb-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Building2 className="h-4 w-4 text-primary" />
                    {c.name}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  {c.contact_name && (
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <span>{c.contact_name}</span>
                    </div>
                  )}
                  {c.phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-4 w-4 text-muted-foreground" />
                      <a href={`tel:${c.phone}`} className="hover:underline">
                        {c.phone}
                        {c.phone_extension ? ` ext. ${c.phone_extension}` : ""}
                      </a>
                    </div>
                  )}
                  {c.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <a href={`mailto:${c.email}`} className="hover:underline break-all">
                        {c.email}
                      </a>
                    </div>
                  )}
                  {c.mortgage_site && (
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4 text-muted-foreground" />
                      <a
                        href={c.mortgage_site.startsWith("http") ? c.mortgage_site : `https://${c.mortgage_site}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline break-all"
                      >
                        {c.mortgage_site}
                      </a>
                    </div>
                  )}
                  {address && (
                    <div className="flex items-start gap-2">
                      <MapPin className="h-4 w-4 text-muted-foreground mt-0.5" />
                      <a
                        href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="hover:underline"
                      >
                        {address}
                      </a>
                    </div>
                  )}
                  {!c.phone && !c.email && !address && (
                    <p className="text-xs text-muted-foreground italic">No contact details on file.</p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
