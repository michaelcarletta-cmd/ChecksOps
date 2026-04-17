import { useState, useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, X, ArrowRight, Lightbulb, XCircle, AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

interface DarwinNudge {
  id: string;
  warning_type: string;
  severity: string;
  title: string;
  message: string;
  suggested_action: string | null;
}

interface DarwinInlineNudgesProps {
  claimId: string;
  context: 'email_composer' | 'package_builder' | 'overview' | 'general';
  maxNudges?: number;
  className?: string;
}

export const DarwinInlineNudges = ({ 
  claimId, 
  context, 
  maxNudges = 2,
  className 
}: DarwinInlineNudgesProps) => {
  const queryClient = useQueryClient();
  const [nudges, setNudges] = useState<DarwinNudge[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  useEffect(() => {
    loadNudges();
  }, [claimId, context]);

  const loadNudges = async () => {
    // Get active warnings for this claim that haven't been dismissed or resolved
    const { data, error } = await supabase
      .from('claim_warnings_log')
      .select('*')
      .eq('claim_id', claimId)
      .eq('is_dismissed', false)
      .eq('is_resolved', false)
      .order('created_at', { ascending: false })
      .limit(10);

    if (data && !error) {
      // Filter by relevance to context
      let relevant = data;
      
      if (context === 'email_composer') {
        // Show communication-related warnings
        relevant = data.filter((n: any) => 
          n.warning_type?.includes('deadline') || 
          n.warning_type?.includes('carrier') ||
          n.warning_type?.includes('communication')
        );
      } else if (context === 'package_builder') {
        // Show evidence and documentation warnings
        relevant = data.filter((n: any) => 
          n.warning_type?.includes('evidence') || 
          n.warning_type?.includes('documentation') ||
          n.warning_type?.includes('coverage')
        );
      }

      // If no context-specific nudges, show highest severity ones
      if (relevant.length === 0) {
        relevant = data.filter((n: any) => 
          n.severity === 'critical' || n.severity === 'high'
        );
      }

      setNudges(relevant.slice(0, maxNudges) as DarwinNudge[]);
    }
  };

  const handleDismiss = async (nudgeId: string) => {
    setDismissed(prev => new Set([...prev, nudgeId]));
    
    // Update in database
    const { error } = await supabase
      .from('claim_warnings_log')
      .update({ 
        is_dismissed: true, 
        dismissed_at: new Date().toISOString() 
      })
      .eq('id', nudgeId);

    if (error) {
      setDismissed(prev => {
        const next = new Set(prev);
        next.delete(nudgeId);
        return next;
      });
      return;
    }

    setNudges(prev => prev.filter((nudge) => nudge.id !== nudgeId));
    queryClient.invalidateQueries({ queryKey: ["claim-nudges-summary"] });
  };

  const getSeverityStyles = (severity: string) => {
    switch (severity?.toLowerCase()) {
      case 'critical':
        return 'border-destructive bg-destructive/10 text-foreground [&_svg]:text-destructive';
      case 'high':
        return 'border-warning bg-warning/10 text-foreground [&_svg]:text-warning';
      case 'medium':
        return 'border-warning/70 bg-warning/5 text-foreground [&_svg]:text-warning';
      default:
        return 'border-primary bg-primary/10 text-foreground [&_svg]:text-primary';
    }
  };

  const getSeverityIcon = (severity: string) => {
    switch (severity?.toLowerCase()) {
      case 'critical':
        return <XCircle className="h-4 w-4" />;
      case 'high':
        return <AlertTriangle className="h-4 w-4" />;
      case 'medium':
        return <AlertCircle className="h-4 w-4" />;
      default:
        return <Lightbulb className="h-4 w-4" />;
    }
  };

  const visibleNudges = nudges.filter(n => !dismissed.has(n.id));

  if (visibleNudges.length === 0) return null;

  return (
    <div className={`space-y-2 ${className || ''}`}>
      {visibleNudges.map(nudge => (
        <Alert 
          key={nudge.id} 
          className={`relative pr-10 ${getSeverityStyles(nudge.severity)}`}
        >
          <div className="flex items-start gap-2">
            {getSeverityIcon(nudge.severity)}
            <div className="flex-1 min-w-0">
              <AlertTitle className="text-sm font-medium">{nudge.title}</AlertTitle>
              <AlertDescription className="text-xs mt-1">
                {nudge.message}
                {nudge.suggested_action && (
                  <span className="flex items-center gap-1 mt-1 font-medium">
                    <ArrowRight className="h-3 w-3" />
                    {nudge.suggested_action}
                  </span>
                )}
              </AlertDescription>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="absolute top-2 right-2 h-6 w-6 opacity-60 hover:opacity-100"
            onClick={() => handleDismiss(nudge.id)}
          >
            <X className="h-3 w-3" />
          </Button>
        </Alert>
      ))}
    </div>
  );
};
