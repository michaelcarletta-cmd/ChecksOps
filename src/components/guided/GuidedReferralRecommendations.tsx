import { Star, ExternalLink, Phone, Mail, Crown, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useReferralProfessionals, type ProfessionalType } from "@/hooks/useReferralProfessionals";
import type { ReferralAlertType } from "@/hooks/useReferralAlerts";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Props {
  claimId: string;
  alertType: ReferralAlertType;
  claimState: string | null;
}

const ALERT_TO_TYPE: Record<ReferralAlertType, ProfessionalType> = {
  needs_contractor: "contractor",
  needs_public_adjuster: "public_adjuster",
  needs_attorney: "attorney",
};

const TYPE_LABELS: Record<ProfessionalType, string> = {
  contractor: "Contractors",
  public_adjuster: "Public Adjusters",
  attorney: "Attorneys",
};

function formatPhone(phone: string | null) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

export function GuidedReferralRecommendations({ claimId, alertType, claimState }: Props) {
  const professionalType = ALERT_TO_TYPE[alertType];
  const { data: professionals, isLoading } = useReferralProfessionals(professionalType, claimState);
  const { toast } = useToast();

  const handleSelect = async (professionalId: string) => {
    try {
      await supabase.from("referral_recommendations").insert({
        claim_id: claimId,
        professional_id: professionalId,
        recommendation_reason: alertType,
        was_selected: true,
        selected_at: new Date().toISOString(),
      });
      toast({ title: "Professional selected", description: "They will be notified about your claim." });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
        <span className="ml-2 text-sm text-muted-foreground">Finding {TYPE_LABELS[professionalType].toLowerCase()}...</span>
      </div>
    );
  }

  if (!professionals || professionals.length === 0) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No {TYPE_LABELS[professionalType].toLowerCase()} found in your area yet.
            Darwin will continue searching and notify you when options become available.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
        Recommended {TYPE_LABELS[professionalType]}
      </p>
      {professionals.map((pro, index) => (
        <Card key={pro.id} className={`border ${pro.is_premium ? "border-primary/40 bg-primary/5" : "border-border"}`}>
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              {/* Logo or initials */}
              <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center shrink-0 text-sm font-bold text-muted-foreground">
                {pro.logo_url ? (
                  <img src={pro.logo_url} alt="" className="w-10 h-10 rounded-lg object-cover" />
                ) : (
                  pro.name.charAt(0).toUpperCase()
                )}
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-sm text-foreground">{pro.name}</span>
                  {pro.is_premium && (
                    <Badge className="bg-primary/15 text-primary border-primary/30 text-[10px] px-1.5 py-0 gap-0.5">
                      <Crown className="h-2.5 w-2.5" />
                      Featured
                    </Badge>
                  )}
                </div>

                {pro.company && (
                  <p className="text-xs text-muted-foreground">{pro.company}</p>
                )}

                {/* Rating */}
                {pro.rating > 0 && (
                  <div className="flex items-center gap-1 mt-1">
                    <Star className="h-3 w-3 text-amber-500 fill-amber-500" />
                    <span className="text-xs text-foreground font-medium">{Number(pro.rating).toFixed(1)}</span>
                    {pro.reviews_count > 0 && (
                      <span className="text-xs text-muted-foreground">({pro.reviews_count} reviews)</span>
                    )}
                  </div>
                )}

                {/* Specialties */}
                {pro.specialties.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1.5">
                    {pro.specialties.slice(0, 3).map((s) => (
                      <Badge key={s} variant="secondary" className="text-[10px] px-1.5 py-0">
                        {s}
                      </Badge>
                    ))}
                    {pro.specialties.length > 3 && (
                      <span className="text-[10px] text-muted-foreground">+{pro.specialties.length - 3}</span>
                    )}
                  </div>
                )}

                {pro.description && (
                  <p className="text-xs text-muted-foreground mt-1.5 line-clamp-2">{pro.description}</p>
                )}

                {/* Contact + action */}
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => handleSelect(pro.id)}
                  >
                    Select This {professionalType === "contractor" ? "Contractor" : professionalType === "public_adjuster" ? "Public Adjuster" : "Attorney"}
                  </Button>
                  {pro.phone && (
                    <a href={`tel:${pro.phone}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Phone className="h-3 w-3" />
                      {formatPhone(pro.phone)}
                    </a>
                  )}
                  {pro.email && (
                    <a href={`mailto:${pro.email}`} className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Mail className="h-3 w-3" />
                      Email
                    </a>
                  )}
                  {pro.website && (
                    <a href={pro.website} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <ExternalLink className="h-3 w-3" />
                      Website
                    </a>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
