import { Navigate } from "react-router-dom";
import { MarketingPageShell } from "@/components/marketing/MarketingPageShell";
import { FounderBlock } from "@/components/marketing/MarketingProof";
import { usePageMeta } from "@/hooks/usePageMeta";
import { FOUNDER } from "@/pages/marketing/marketingProof";

/**
 * /about: the founder's "why I built this" page. It exists only once marketingProof.ts
 * FOUNDER holds the founder's real name, photo, LinkedIn and story; until then /about sends
 * visitors to the home page.
 */
function AboutPage({ name }: { name: string }) {
  usePageMeta({
    path: "/about",
    title: `About ChecksOps - Why ${name} built it`,
    description: `Why ${name} built ChecksOps, the claim check workflow for public adjusting firms and their restoration partners.`,
  });
  return (
    <MarketingPageShell currentPath="/about">
      <main className="py-6">
        <h1 className="sr-only">About ChecksOps</h1>
        <FounderBlock />
      </main>
    </MarketingPageShell>
  );
}

export default function MarketingAbout() {
  if (!FOUNDER) return <Navigate to="/" replace />;
  return <AboutPage name={FOUNDER.name} />;
}
