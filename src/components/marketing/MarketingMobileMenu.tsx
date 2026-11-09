import { Link } from "react-router-dom";
import { ArrowRight, Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

export interface MarketingMenuItem {
  label: string;
  /** In-page anchor ("#workflow") or route ("/claim-check-tracking", "/#workflow"). */
  href: string;
}

const isRoute = (href: string) => href.startsWith("/");

/** Hamburger toggle for the marketing header (phone widths only). 44px tap target. */
export function MarketingMenuButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="md:hidden inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted/50"
      onClick={onToggle}
      aria-label={open ? "Close menu" : "Open menu"}
      aria-expanded={open}
      aria-controls="marketing-mobile-menu"
    >
      {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
    </button>
  );
}

/**
 * The phone-width menu under the marketing header: section links, Sign in
 * and the Book a live demo button. Every row is at least 44px tall.
 */
export function MarketingMobileMenu({
  open,
  onClose,
  items,
  demoHref,
}: {
  open: boolean;
  onClose: () => void;
  items: MarketingMenuItem[];
  /** "#demo" on the home page, "/#demo" elsewhere. */
  demoHref: string;
}) {
  if (!open) return null;
  const rowClass = "flex min-h-[44px] items-center rounded-md px-2 text-base text-muted-foreground hover:bg-muted/40 hover:text-foreground";
  return (
    <div id="marketing-mobile-menu" className="md:hidden border-t border-border/40 bg-background/95 backdrop-blur px-4 py-3">
      <nav className="flex flex-col" aria-label="Main">
        {items.map((item) =>
          isRoute(item.href) ? (
            <Link key={item.href} to={item.href} onClick={onClose} className={rowClass}>
              {item.label}
            </Link>
          ) : (
            <a key={item.href} href={item.href} onClick={onClose} className={rowClass}>
              {item.label}
            </a>
          ),
        )}
        <Link to="/login" onClick={onClose} className={`${rowClass} text-foreground font-medium`}>
          Sign in
        </Link>
      </nav>
      <Button asChild size="lg" className="mt-3 w-full min-h-[44px] text-base">
        {isRoute(demoHref) ? (
          <Link to={demoHref} onClick={onClose}>Book a live demo<ArrowRight className="h-4 w-4 ml-2" /></Link>
        ) : (
          <a href={demoHref} onClick={onClose}>Book a live demo<ArrowRight className="h-4 w-4 ml-2" /></a>
        )}
      </Button>
    </div>
  );
}
