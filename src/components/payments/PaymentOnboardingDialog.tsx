import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Plus, Trash2, ShieldCheck } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useProviderProfile } from "@/hooks/useProviderProfile";


const BUSINESS_TYPES: { value: string; label: string }[] = [
  { value: "privateCorporation", label: "LLC / Private corporation" },
  { value: "soleProprietorship", label: "Sole proprietorship" },
  { value: "partnership", label: "Partnership" },
  { value: "publicCorporation", label: "Public corporation" },
  { value: "incorporatedNonProfit", label: "Incorporated non-profit" },
  { value: "unincorporatedNonProfit", label: "Unincorporated non-profit" },
  { value: "unincorporatedAssociation", label: "Unincorporated association" },
  { value: "trust", label: "Trust" },
];

interface Address {
  addressLine1: string;
  addressLine2: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
}

const emptyAddress = (): Address => ({
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateOrProvince: "",
  postalCode: "",
});

interface Person {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  jobTitle: string;
  ssn: string;
  birthDate: string;
  address: Address;
  isController: boolean;
  isOwner: boolean;
  ownershipPercentage: string;
}

const emptyPerson = (isController: boolean): Person => ({
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  jobTitle: isController ? "Owner" : "",
  ssn: "",
  birthDate: "",
  address: emptyAddress(),
  isController,
  isOwner: true,
  ownershipPercentage: "",
});

function AddressFields({
  value,
  onChange,
  idPrefix,
}: {
  value: Address;
  onChange: (next: Address) => void;
  idPrefix: string;
}) {
  const set = (k: keyof Address, v: string) => onChange({ ...value, [k]: v });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-6 gap-3">
      <div className="sm:col-span-4 space-y-1.5">
        <Label htmlFor={`${idPrefix}-line1`} className="text-xs">Street address</Label>
        <Input id={`${idPrefix}-line1`} value={value.addressLine1} onChange={(e) => set("addressLine1", e.target.value)} />
      </div>
      <div className="sm:col-span-2 space-y-1.5">
        <Label htmlFor={`${idPrefix}-line2`} className="text-xs">Suite (optional)</Label>
        <Input id={`${idPrefix}-line2`} value={value.addressLine2} onChange={(e) => set("addressLine2", e.target.value)} />
      </div>
      <div className="sm:col-span-3 space-y-1.5">
        <Label htmlFor={`${idPrefix}-city`} className="text-xs">City</Label>
        <Input id={`${idPrefix}-city`} value={value.city} onChange={(e) => set("city", e.target.value)} />
      </div>
      <div className="sm:col-span-1 space-y-1.5">
        <Label htmlFor={`${idPrefix}-state`} className="text-xs">State</Label>
        <Input id={`${idPrefix}-state`} maxLength={2} value={value.stateOrProvince} onChange={(e) => set("stateOrProvince", e.target.value.toUpperCase())} />
      </div>
      <div className="sm:col-span-2 space-y-1.5">
        <Label htmlFor={`${idPrefix}-zip`} className="text-xs">ZIP</Label>
        <Input id={`${idPrefix}-zip`} inputMode="numeric" maxLength={5} value={value.postalCode} onChange={(e) => set("postalCode", e.target.value)} />
      </div>
    </div>
  );
}

interface Props {
  tenantId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmitted: () => void;
  defaults?: { legalBusinessName?: string; email?: string; phone?: string };
}

/**
 * Collects everything the payment provider needs to verify a business, entirely
 * inside ChecksOps. Nothing here sends the tenant to a hosted signup page.
 */
export function PaymentOnboardingDialog({ tenantId, open, onOpenChange, onSubmitted, defaults }: Props) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [legalBusinessName, setLegalBusinessName] = useState(defaults?.legalBusinessName ?? "");
  const [doingBusinessAs, setDoingBusinessAs] = useState("");
  const [businessType, setBusinessType] = useState("privateCorporation");
  const [ein, setEin] = useState("");
  const [email, setEmail] = useState(defaults?.email ?? "");
  const [phone, setPhone] = useState(defaults?.phone ?? "");
  const [website, setWebsite] = useState("");
  const [description, setDescription] = useState("");
  const [address, setAddress] = useState<Address>(emptyAddress());
  const [people, setPeople] = useState<Person[]>([emptyPerson(true)]);

  // Anything the provider already holds is prefilled, so a tenant who has
  // onboarded before is never asked to retype their business details.
  const { data: providerProfile } = useProviderProfile(open ? tenantId : null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    if (!open) { setHydrated(false); return; }
    const biz = providerProfile?.business;
    if (!biz || hydrated) return;
    setHydrated(true);
    setLegalBusinessName((v) => v || biz.legalBusinessName);
    setDoingBusinessAs((v) => v || biz.doingBusinessAs);
    if (biz.businessType) setBusinessType(biz.businessType);
    setEmail((v) => v || biz.email);
    setPhone((v) => v || biz.phone);
    setWebsite((v) => v || biz.website.replace(/^https?:\/\//, ""));
    setDescription((v) => v || biz.description);
    setAddress((a) =>
      a.addressLine1
        ? a
        : {
            addressLine1: biz.address.addressLine1 ?? "",
            addressLine2: biz.address.addressLine2 ?? "",
            city: biz.address.city ?? "",
            stateOrProvince: biz.address.stateOrProvince ?? "",
            postalCode: biz.address.postalCode ?? "",
          },
    );
    if (providerProfile?.representatives.length) {
      setPeople(
        providerProfile.representatives.map((r) => ({
          firstName: r.firstName,
          lastName: r.lastName,
          email: r.email,
          phone: r.phone,
          jobTitle: r.jobTitle || "Owner",
          ssn: "",
          birthDate: "",
          address: {
            addressLine1: r.address.addressLine1 ?? "",
            addressLine2: r.address.addressLine2 ?? "",
            city: r.address.city ?? "",
            stateOrProvince: r.address.stateOrProvince ?? "",
            postalCode: r.address.postalCode ?? "",
          },
          isController: r.isController,
          isOwner: r.isOwner,
          ownershipPercentage: r.ownershipPercentage,
        })),
      );
    }
  }, [open, providerProfile, hydrated]);

  const setPerson = (i: number, next: Partial<Person>) =>
    setPeople((prev) => prev.map((p, idx) => (idx === i ? { ...p, ...next } : p)));


  async function handleSubmit() {
    setSaving(true);
    try {
      const body = {
        tenant_id: tenantId,
        business: {
          legalBusinessName,
          doingBusinessAs,
          businessType,
          ein,
          email,
          phone,
          website,
          description,
          address,
        },
        representatives: people.map((p) => ({
          firstName: p.firstName,
          lastName: p.lastName,
          email: p.email,
          phone: p.phone,
          jobTitle: p.jobTitle,
          ssn: p.ssn,
          birthDate: p.birthDate,
          address: p.address,
          isController: p.isController,
          isOwner: p.isOwner,
          ownershipPercentage: p.ownershipPercentage ? Number(p.ownershipPercentage) : 0,
        })),
      };

      const { data, error } = await supabase.functions.invoke("moov-account-onboard", { body });
      if (error) {
        let message = error.message ?? "Submission failed";
        try {
          const parsed = await (error as any).context?.json?.();
          if (parsed?.error) message = parsed.error;
        } catch { /* keep original */ }
        throw new Error(message);
      }
      if ((data as any)?.error) throw new Error((data as any).error);

      toast({
        title: "Details submitted",
        description: "Your information was sent for verification. Status updates automatically.",
      });
      onOpenChange(false);
      onSubmitted();
    } catch (e: any) {
      toast({ title: "Couldn't submit details", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-primary" /> Payment Account Verification
          </DialogTitle>
          <DialogDescription className="text-xs">
            Required by federal banking rules before your organization can move money. Your details are
            transmitted securely and are never stored in ChecksOps.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-3">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Business</h4>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="legal-name" className="text-xs">Legal business name</Label>
                <Input id="legal-name" value={legalBusinessName} onChange={(e) => setLegalBusinessName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="dba" className="text-xs">Doing business as (optional)</Label>
                <Input id="dba" value={doingBusinessAs} onChange={(e) => setDoingBusinessAs(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Business type</Label>
                <Select value={businessType} onValueChange={setBusinessType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {BUSINESS_TYPES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ein" className="text-xs">EIN (9 digits)</Label>
                <Input id="ein" inputMode="numeric" value={ein} onChange={(e) => setEin(e.target.value)} placeholder="12-3456789" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="biz-email" className="text-xs">Business email</Label>
                <Input id="biz-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="biz-phone" className="text-xs">Business phone</Label>
                <Input id="biz-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="website" className="text-xs">Website</Label>
                <Input id="website" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="example.com" />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="desc" className="text-xs">What the business does (if no website)</Label>
                <Textarea id="desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
              </div>
            </div>
            <AddressFields value={address} onChange={setAddress} idPrefix="biz" />
          </section>

          <Separator />

          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Controller &amp; owners
                </h4>
                <p className="text-[11px] text-muted-foreground">
                  Add the person who controls the business, plus anyone owning 25% or more.
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setPeople((prev) => [...prev, emptyPerson(false)])}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add person
              </Button>
            </div>

            {people.map((p, i) => (
              <div key={i} className="rounded-md border p-3 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium">
                    {p.isController ? "Controller" : `Owner ${i + 1}`}
                  </p>
                  {i > 0 && (
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setPeople((prev) => prev.filter((_, idx) => idx !== i))}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">First name</Label>
                    <Input value={p.firstName} onChange={(e) => setPerson(i, { firstName: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Last name</Label>
                    <Input value={p.lastName} onChange={(e) => setPerson(i, { lastName: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Email</Label>
                    <Input type="email" value={p.email} onChange={(e) => setPerson(i, { email: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Phone</Label>
                    <Input inputMode="tel" value={p.phone} onChange={(e) => setPerson(i, { phone: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Job title</Label>
                    <Input value={p.jobTitle} onChange={(e) => setPerson(i, { jobTitle: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Date of birth</Label>
                    <Input type="date" value={p.birthDate} onChange={(e) => setPerson(i, { birthDate: e.target.value })} />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Social Security number</Label>
                    <Input
                      inputMode="numeric"
                      autoComplete="off"
                      value={p.ssn}
                      onChange={(e) => setPerson(i, { ssn: e.target.value })}
                      placeholder="123-45-6789"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Ownership %</Label>
                    <Input
                      inputMode="numeric"
                      value={p.ownershipPercentage}
                      onChange={(e) => setPerson(i, { ownershipPercentage: e.target.value })}
                      placeholder="100"
                    />
                  </div>
                </div>

                <AddressFields
                  value={p.address}
                  onChange={(next) => setPerson(i, { address: next })}
                  idPrefix={`rep-${i}`}
                />

                <div className="flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={p.isController}
                      onCheckedChange={(v) =>
                        setPeople((prev) =>
                          prev.map((row, idx) => ({ ...row, isController: idx === i ? !!v : false })),
                        )
                      }
                    />
                    Controls the business
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    <Checkbox
                      checked={p.isOwner}
                      onCheckedChange={(v) => setPerson(i, { isOwner: !!v })}
                    />
                    Owns 25% or more
                  </label>
                </div>
              </div>
            ))}
          </section>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" className="h-8 text-xs" onClick={handleSubmit} disabled={saving}>
              {saving ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Submitting…</> : "Submit for verification"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
