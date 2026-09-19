import { Badge } from "@/components/ui/badge";
import { moovEnvironmentLabel, normalizeMoovEnvironment, type MoovEnvironment } from "@/lib/moovEnvironment";

const TONE: Record<MoovEnvironment, string> = {
  sandbox: "border-amber-500/50 text-amber-600 bg-amber-500/10 font-bold tracking-widest",
  production: "border-emerald-500/40 text-emerald-600 bg-emerald-500/5",
};

export function MoovEnvironmentBadge({
  environment,
  className = "",
}: {
  environment?: string | null;
  className?: string;
}) {
  const env = normalizeMoovEnvironment(environment);
  return (
    <Badge variant="outline" className={`text-[10px] ${TONE[env]} ${className}`.trim()}>
      {moovEnvironmentLabel(env)}
    </Badge>
  );
}
