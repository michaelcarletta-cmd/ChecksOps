import { useEffect, useState } from "react";
import { AlertTriangle, Info, RefreshCw, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useActivePlatformAnnouncements, type PlatformAnnouncement } from "@/hooks/usePlatformAnnouncements";

const DISMISS_KEY = "checksops.dismissed-announcements";

function readDismissed(): string[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISS_KEY) || "[]");
  } catch {
    return [];
  }
}

function formatWindow(a: PlatformAnnouncement): string | null {
  if (!a.scheduled_start) return null;
  const start = new Date(a.scheduled_start);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  const startText = start.toLocaleString(undefined, opts);
  if (!a.scheduled_end) return startText;
  const end = new Date(a.scheduled_end);
  const sameDay = start.toDateString() === end.toDateString();
  const endText = end.toLocaleString(
    undefined,
    sameDay ? { hour: "numeric", minute: "2-digit" } : opts
  );
  return `${startText} – ${endText}`;
}

const TONE: Record<PlatformAnnouncement["severity"], { wrap: string; Icon: typeof Info }> = {
  info: { wrap: "bg-primary/10 border-primary/30 text-foreground", Icon: Info },
  maintenance: { wrap: "bg-amber-500/10 border-amber-500/40 text-foreground", Icon: Wrench },
  critical: { wrap: "bg-destructive/10 border-destructive/40 text-foreground", Icon: AlertTriangle },
};

/**
 * Global platform-wide announcement strip.
 * Shown to every user on every page (including tenant white-label apps)
 * so scheduled maintenance can be communicated ahead of time.
 */
export function PlatformAnnouncementBanner() {
  const { data: announcements = [] } = useActivePlatformAnnouncements();
  const [dismissed, setDismissed] = useState<string[]>(readDismissed);

  useEffect(() => {
    localStorage.setItem(DISMISS_KEY, JSON.stringify(dismissed));
  }, [dismissed]);

  const visible = announcements.filter(
    (a) => !(a.severity !== "critical" && dismissed.includes(`${a.id}:${a.updated_at}`))
  );
  if (visible.length === 0) return null;

  const hardRefresh = () => {
    // Drop cached assets so tenants pick up the new build immediately.
    const reload = () => window.location.reload();
    if (typeof caches !== "undefined") {
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).finally(reload);
    } else {
      reload();
    }

  };

  return (
    <div className="w-full">
      {visible.map((a) => {
        const tone = TONE[a.severity] ?? TONE.info;
        const windowText = formatWindow(a);
        return (
          <div key={a.id} className={`w-full border-b px-3 py-2 md:px-5 ${tone.wrap}`}>
            <div className="mx-auto flex max-w-7xl items-start gap-2.5">
              <tone.Icon className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <div className="min-w-0 flex-1 space-y-0.5">
                <p className="text-xs font-semibold leading-snug md:text-sm">
                  {a.title}
                  {windowText && (
                    <span className="ml-2 font-normal text-muted-foreground">{windowText}</span>
                  )}
                </p>
                <p className="text-[11px] leading-snug text-muted-foreground md:text-xs break-words">
                  {a.message}
                </p>
                {a.refresh_instructions && (
                  <p className="text-[11px] leading-snug text-muted-foreground md:text-xs break-words">
                    {a.refresh_instructions}
                  </p>
                )}
              </div>
              <div className="flex flex-shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-[11px]"
                  onClick={hardRefresh}
                  title="Reload the platform to pick up the latest update"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Refresh</span>
                </Button>
                {a.severity !== "critical" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setDismissed((d) => [...d, `${a.id}:${a.updated_at}`])}
                    title="Dismiss"
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
