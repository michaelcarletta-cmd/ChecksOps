import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CheckOpsLogo } from "@/components/marketing/CheckOpsLogo";
import { MarketingMenuButton, MarketingMobileMenu } from "@/components/marketing/MarketingMobileMenu";
import { COMPARISON_LINKS } from "@/pages/marketing/marketingPages";
import { useNavItemsWithBlog } from "@/hooks/useBlogArticles";

const NAV_ITEMS = [
  { label: "Capabilities", href: "/#capabilities" },
  { label: "Workflow", href: "/#workflow" },
  { label: "Security", href: "/#security" },
];

/**
 * Header and footer for the secondary marketing pages (/vs/..., /claim-check-tracking, /blog).
 * Same nav, mobile menu and footer links as the iink comparison page.
 */
export function MarketingPageShell({
  currentPath,
  footerNote,
  children,
}: {
  currentPath: string;
  footerNote?: string;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const navItems = useNavItemsWithBlog(NAV_ITEMS);
  return (
    <div className="min-h-screen max-w-full overflow-x-hidden bg-background text-foreground">
      <header className="sticky top-0 z-50 border-b border-border/40 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto max-w-7xl px-4 md:px-6 h-14 flex items-center justify-between">
          <Link to="/" className="flex items-center min-h-[44px]">
            <CheckOpsLogo className="text-foreground h-9 sm:h-10" />
          </Link>
          <nav className="hidden md:flex items-center gap-6 text-sm text-muted-foreground">
            {navItems.map((item) => (
              <Link key={item.href} to={item.href} className="hover:text-foreground transition-colors">{item.label}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link to="/login"><LogIn className="h-4 w-4 mr-1.5" />Sign in</Link>
            </Button>
            <Button asChild size="sm" className="h-11 sm:h-9">
              <Link to="/#demo">Book a demo</Link>
            </Button>
            <MarketingMenuButton open={menuOpen} onToggle={() => setMenuOpen(!menuOpen)} />
          </div>
        </div>
        <MarketingMobileMenu open={menuOpen} onClose={() => setMenuOpen(false)} items={navItems} demoHref="/#demo" />
      </header>

      {children}

      <footer className="border-t border-border/40">
        <div className="mx-auto max-w-7xl px-4 md:px-6 py-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} ChecksOps</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 [&>a]:inline-flex [&>a]:items-center [&>a]:min-h-[44px] sm:[&>a]:min-h-0">
            <Link to="/" className="hover:text-foreground">Home</Link>
            {COMPARISON_LINKS.filter((l) => l.to !== currentPath).map((l) => (
              <Link key={l.to} to={l.to} className="hover:text-foreground">{l.label}</Link>
            ))}
            <Link to="/privacy-notice" className="hover:text-foreground">Privacy Notice</Link>
            <Link to="/terms" className="hover:text-foreground">Terms of Service</Link>
          </nav>
        </div>
        <p className="mx-auto max-w-4xl px-4 pb-6 text-center text-[11px] leading-relaxed text-muted-foreground">
          {footerNote ? `${footerNote} ` : ""}ChecksOps is workflow software, not a bank, lender, escrow
          service, or payment processor.
        </p>
      </footer>
    </div>
  );
}
