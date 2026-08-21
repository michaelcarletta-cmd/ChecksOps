import { SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "./AppSidebar";
import { QuickTaskBar } from "./QuickTaskBar";
import { UrgentAlertsBell } from "./UrgentAlertsBell";
import { ReactNode, useEffect } from "react";
import { useLocation } from "react-router-dom";

interface AppLayoutProps {
  children: ReactNode;
}

const AppLayoutContent = ({ children }: AppLayoutProps) => {
  const { setOpenMobile, isMobile } = useSidebar();
  const location = useLocation();

  // Close mobile sidebar sheet on navigation
  useEffect(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [location.pathname, isMobile, setOpenMobile]);

  return (
    <div className="flex min-h-screen w-full bg-background">
      <AppSidebar />
      <div className="flex-1 flex flex-col min-w-0 max-w-full">
        <header className="h-14 border-b border-border/70 bg-background/95 backdrop-blur flex items-center gap-2 px-3 sm:px-4 sticky top-0 z-10 min-w-0">
          <SidebarTrigger className="shrink-0" />
          <div className="ml-1 sm:ml-2 flex items-center gap-4 flex-1 min-w-0 overflow-hidden">
          </div>
          <UrgentAlertsBell />
          <QuickTaskBar />
        </header>
        <main className="flex-1 min-w-0 max-w-full overflow-x-clip px-fluid py-3 md:py-6 animate-fade-in">
          {children}
        </main>
      </div>

    </div>
  );
};

export const AppLayout = ({ children }: AppLayoutProps) => {
  return (
    <SidebarProvider defaultOpen>
      <AppLayoutContent>{children}</AppLayoutContent>
    </SidebarProvider>
  );
};
