import { useState, useEffect, useCallback } from "react";
import { Brain, X, ChevronDown, ChevronUp, AlertTriangle, Lightbulb, TrendingUp, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

interface DarwinSecondBrainProps {
  claimId: string;
  claim: any;
  currentContext?: 'email_composer' | 'package_builder' | 'overview' | 'files' | 'general';
}

interface SecondBrainNudge {
  id: string;
  type: 'warning' | 'opportunity' | 'insight' | 'precedent';
  severity: 'critical' | 'high' | 'medium' | 'low';
  title: string;
  message: string;
  action?: string;
  precedentClaimIds?: string[];
  context: string;
}

export const DarwinSecondBrain = ({ claimId, claim, currentContext = 'general' }: DarwinSecondBrainProps) => {
  const [isExpanded, setIsExpanded] = useState(true);
  const [isMinimized, setIsMinimized] = useState(false);
  const [nudges, setNudges] = useState<SecondBrainNudge[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [isVisible, setIsVisible] = useState(true);

  // Load nudges from claim_warnings_log
  const loadNudges = useCallback(async () => {
    const { data, error } = await supabase
      .from('claim_warnings_log')
      .select('*')
      .eq('claim_id', claimId)
      .eq('is_dismissed', false)
      .eq('is_resolved', false)
      .order('created_at', { ascending: false })
      .limit(10);

    if (data && !error) {
      // Transform and filter by context
      const transformed: SecondBrainNudge[] = data
        .filter((item: any) => {
          // Filter by context relevance
          if (currentContext === 'email_composer') {
            return item.warning_type?.includes('deadline') || 
                   item.warning_type?.includes('carrier') ||
                   item.warning_type?.includes('communication') ||
                   item.trigger_context === 'email_composer';
          }
          if (currentContext === 'package_builder') {
            return item.warning_type?.includes('evidence') || 
                   item.warning_type?.includes('documentation') ||
                   item.warning_type?.includes('coverage') ||
                   item.trigger_context === 'package_builder';
          }
          if (currentContext === 'files') {
            return item.warning_type?.includes('document') || 
                   item.warning_type?.includes('evidence') ||
                   item.trigger_context === 'files';
          }
          return true;
        })
        .map((item: any) => ({
          id: item.id,
          type: getTypeFromWarning(item.warning_type, item.severity),
          severity: item.severity || 'medium',
          title: item.title,
          message: item.message,
          action: item.action_recommendation || item.suggested_action,
          precedentClaimIds: item.precedent_claim_ids,
          context: item.trigger_context || 'general'
        }));

      setNudges(transformed);
    }
  }, [claimId, currentContext]);

  useEffect(() => {
    loadNudges();
  }, [loadNudges]);

  const getTypeFromWarning = (warningType: string, severity: string): SecondBrainNudge['type'] => {
    if (severity === 'critical' || severity === 'high') return 'warning';
    if (warningType?.includes('opportunity') || warningType?.includes('coverage')) return 'opportunity';
    if (warningType?.includes('precedent')) return 'precedent';
    return 'insight';
  };

  const handleDismiss = async (nudgeId: string) => {
    setDismissedIds(prev => new Set([...prev, nudgeId]));
    
    await supabase
      .from('claim_warnings_log')
      .update({ 
        is_dismissed: true, 
        dismissed_at: new Date().toISOString() 
      })
      .eq('id', nudgeId);
  };

  const visibleNudges = nudges.filter(n => !dismissedIds.has(n.id));
  const criticalCount = visibleNudges.filter(n => n.severity === 'critical' || n.severity === 'high').length;

  if (!isVisible || visibleNudges.length === 0) return null;

  const getNudgeIcon = (type: SecondBrainNudge['type']) => {
    switch (type) {
      case 'warning': return <AlertTriangle className="h-4 w-4" />;
      case 'opportunity': return <TrendingUp className="h-4 w-4" />;
      case 'precedent': return <Brain className="h-4 w-4" />;
      default: return <Lightbulb className="h-4 w-4" />;
    }
  };

  const getNudgeColors = (type: SecondBrainNudge['type'], severity: SecondBrainNudge['severity']) => {
    if (type === 'warning') {
      if (severity === 'critical') return 'bg-red-50 border-red-300 dark:bg-red-950/30 dark:border-red-800';
      if (severity === 'high') return 'bg-orange-50 border-orange-300 dark:bg-orange-950/30 dark:border-orange-800';
      return 'bg-yellow-50 border-yellow-300 dark:bg-yellow-950/30 dark:border-yellow-800';
    }
    if (type === 'opportunity') return 'bg-green-50 border-green-300 dark:bg-green-950/30 dark:border-green-800';
    if (type === 'precedent') return 'bg-purple-50 border-purple-300 dark:bg-purple-950/30 dark:border-purple-800';
    return 'bg-blue-50 border-blue-300 dark:bg-blue-950/30 dark:border-blue-800';
  };

  const getIconColor = (type: SecondBrainNudge['type'], severity: SecondBrainNudge['severity']) => {
    if (type === 'warning') {
      if (severity === 'critical') return 'text-red-600';
      if (severity === 'high') return 'text-orange-600';
      return 'text-yellow-600';
    }
    if (type === 'opportunity') return 'text-green-600';
    if (type === 'precedent') return 'text-purple-600';
    return 'text-blue-600';
  };

  if (isMinimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <Button
          onClick={() => setIsMinimized(false)}
          className="rounded-full h-12 w-12 shadow-lg bg-primary hover:bg-primary/90 relative"
        >
          <Brain className="h-5 w-5" />
          {criticalCount > 0 && (
            <Badge 
              variant="destructive" 
              className="absolute -top-1 -right-1 h-5 w-5 p-0 flex items-center justify-center text-xs"
            >
              {criticalCount}
            </Badge>
          )}
        </Button>
      </div>
    );
  }

  return (
    <Card className="fixed bottom-4 right-4 z-50 w-80 shadow-xl border-primary/20 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-3 bg-gradient-to-r from-primary/10 to-primary/5 border-b">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          <span className="font-medium text-sm">Darwin Second Brain</span>
          {criticalCount > 0 && (
            <Badge variant="destructive" className="text-xs">{criticalCount}</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setIsExpanded(!isExpanded)}
          >
            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setIsMinimized(true)}
          >
            <EyeOff className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={() => setIsVisible(false)}
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Content */}
      {isExpanded && (
        <ScrollArea className="h-80 overflow-auto">
          <div className="p-2 space-y-2">
            {visibleNudges.map(nudge => (
              <div
                key={nudge.id}
                className={cn(
                  "relative p-3 rounded-lg border text-sm",
                  getNudgeColors(nudge.type, nudge.severity)
                )}
              >
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 h-5 w-5 opacity-50 hover:opacity-100"
                  onClick={() => handleDismiss(nudge.id)}
                >
                  <X className="h-3 w-3" />
                </Button>

                <div className="flex items-start gap-2 pr-6">
                  <div className={cn("mt-0.5", getIconColor(nudge.type, nudge.severity))}>
                    {getNudgeIcon(nudge.type)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-xs mb-1">{nudge.title}</div>
                    <p className="text-xs text-muted-foreground leading-relaxed">{nudge.message}</p>
                    {nudge.action && (
                      <div className="mt-2 text-xs font-medium text-primary">
                        → {nudge.action}
                      </div>
                    )}
                    {nudge.precedentClaimIds && nudge.precedentClaimIds.length > 0 && (
                      <div className="mt-1 text-xs text-purple-600">
                        Based on {nudge.precedentClaimIds.length} similar claim{nudge.precedentClaimIds.length > 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {visibleNudges.length === 0 && (
              <div className="text-center py-4 text-muted-foreground text-xs">
                <Brain className="h-6 w-6 mx-auto mb-2 opacity-50" />
                No active insights
              </div>
            )}
          </div>
        </ScrollArea>
      )}
    </Card>
  );
};
