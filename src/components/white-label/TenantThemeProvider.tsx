import { useEffect } from "react";
import { useTenant } from "@/contexts/TenantContext";

export function TenantThemeProvider({ children }: { children: React.ReactNode }) {
  const { tenant } = useTenant();

  useEffect(() => {
    if (!tenant) return;

    const root = document.documentElement;
    // Convert hex to HSL for CSS custom properties
    const primaryHsl = hexToHsl(tenant.primary_color || "#3B82F6");
    const secondaryHsl = hexToHsl(tenant.secondary_color || "#1E293B");

    root.style.setProperty("--tenant-primary", primaryHsl);
    root.style.setProperty("--tenant-secondary", secondaryHsl);
    root.style.setProperty("--tenant-primary-hex", tenant.primary_color || "#3B82F6");

    return () => {
      root.style.removeProperty("--tenant-primary");
      root.style.removeProperty("--tenant-secondary");
      root.style.removeProperty("--tenant-primary-hex");
    };
  }, [tenant]);

  return <>{children}</>;
}

function hexToHsl(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!result) return "220 70% 50%";

  let r = parseInt(result[1], 16) / 255;
  let g = parseInt(result[2], 16) / 255;
  let b = parseInt(result[3], 16) / 255;

  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return `${Math.round(h * 360)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}
