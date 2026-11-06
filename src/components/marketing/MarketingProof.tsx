import { Linkedin } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  EXTERNAL_SIGNALS,
  FOUNDER,
  TESTIMONIALS,
  USAGE_STATS,
  USAGE_STATS_UPDATED_ON,
} from "@/pages/marketing/marketingProof";

/**
 * Proof sections for the home page. Each one renders nothing until its list in
 * src/pages/marketing/marketingProof.ts holds real entries.
 */

export function TestimonialWall() {
  if (TESTIMONIALS.length === 0) return null;
  return (
    <section id="customers" className="border-t border-border/40">
      <div className="mx-auto max-w-7xl px-4 md:px-6 py-16 md:py-20">
        <Badge variant="outline" className="mb-4">Customers</Badge>
        <h2 className="text-3xl md:text-4xl font-bold tracking-tight">What firms say after switching.</h2>
        <div className="mt-10 grid md:grid-cols-3 gap-4">
          {TESTIMONIALS.map((t) => (
            <Card key={`${t.name}-${t.firm}`} className="border-border/50 bg-card/60">
              <CardContent className="p-6">
                <p className="text-sm leading-relaxed">“{t.quote}”</p>
                <div className="mt-4 flex items-center gap-3">
                  {t.photoUrl && <img src={t.photoUrl} alt={t.name} className="h-10 w-10 rounded-full object-cover" />}
                  <div>
                    <p className="text-sm font-semibold">{t.name}</p>
                    <p className="text-xs text-muted-foreground">{t.role}, {t.firm}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </section>
  );
}

export function ExternalSignalStrip() {
  const dated = EXTERNAL_SIGNALS.filter((s) => s.date);
  if (dated.length === 0) return null;
  return (
    <section className="border-t border-border/40 bg-card/20">
      <div className="mx-auto max-w-7xl px-4 md:px-6 py-8 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm text-muted-foreground">
        {dated.map((s) => (
          <a key={s.url} href={s.url} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
            <span className="font-semibold text-foreground">{s.source}</span>: {s.text} <span className="text-xs">({s.date})</span>
          </a>
        ))}
      </div>
    </section>
  );
}

export function UsageStatStrip() {
  if (USAGE_STATS.length === 0 || !USAGE_STATS_UPDATED_ON) return null;
  return (
    <section className="border-b border-border/40 bg-card/30">
      <div className="mx-auto max-w-7xl px-4 md:px-6 py-8">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 text-center">
          {USAGE_STATS.map((s) => (
            <div key={s.label}>
              <p className="text-2xl md:text-3xl font-bold">{s.value}</p>
              <p className="text-xs text-muted-foreground mt-1">{s.label}</p>
            </div>
          ))}
        </div>
        <p className="mt-4 text-center text-[11px] text-muted-foreground">Updated {USAGE_STATS_UPDATED_ON}</p>
      </div>
    </section>
  );
}

export function FounderBlock() {
  if (!FOUNDER) return null;
  const f = FOUNDER;
  return (
    <section id="founder" className="border-t border-border/40">
      <div className="mx-auto max-w-4xl px-4 md:px-6 py-16 md:py-20 grid sm:grid-cols-[auto_1fr] gap-8 items-start">
        <img src={f.photoUrl} alt={f.name} className="h-28 w-28 rounded-full object-cover" />
        <div>
          <Badge variant="outline" className="mb-4">Why we built ChecksOps</Badge>
          <p className="text-base text-muted-foreground leading-relaxed">{f.story}</p>
          <p className="mt-4 text-sm font-semibold">{f.name}</p>
          <p className="text-xs text-muted-foreground">{f.role}</p>
          <a href={f.linkedInUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-xs text-primary hover:underline">
            <Linkedin className="h-3.5 w-3.5" /> LinkedIn
          </a>
        </div>
      </div>
    </section>
  );
}

/** Footer line naming the founder, once FOUNDER is filled in. */
export function FounderFooterLink() {
  if (!FOUNDER) return null;
  return (
    <a href={FOUNDER.linkedInUrl} target="_blank" rel="noopener noreferrer" className="hover:text-foreground">
      Founded by {FOUNDER.name}
    </a>
  );
}
