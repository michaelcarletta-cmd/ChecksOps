import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExternalLink, Zap, ArrowRight, CheckCircle2, Camera, FileText, Bell, Database } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

import { awsApiBaseUrl } from "@/lib/awsStaging";

const AWS_FUNCTIONS_BASE = `${awsApiBaseUrl()}/functions/v1`;

const zapTemplates = [
  {
    name: "Company Cam Photo Sync",
    description: "Import photos from Company Cam projects to claims",
    icon: Camera,
    steps: [
      "Create a Zap with Company Cam trigger (New Photo)",
      "Add a Webhook POST action to the automation endpoint",
      "Map photo URL and project name fields",
    ],
  },
  {
    name: "Form to Claim Creation",
    description: "Create claims from Typeform, JotForm, or Google Forms",
    icon: FileText,
    steps: [
      "Create a Zap with your form trigger (New Submission)",
      "Add a Webhook POST action to the automation endpoint",
      "Map policyholder name, email, address, loss date",
    ],
  },
  {
    name: "Slack Notifications",
    description: "Send claim updates to Slack channels",
    icon: Bell,
    steps: [
      "Create a Zap with a Webhooks by Zapier trigger (Catch Hook)",
      "Add a Slack action (Send Channel Message)",
      "Map claim number, policyholder, and event type",
    ],
  },
  {
    name: "Google Sheets Sync",
    description: "Export claim data to Google Sheets for reporting",
    icon: Database,
    steps: [
      "Create a Zap with a Webhooks by Zapier trigger (Catch Hook)",
      "Add Google Sheets action (Create Spreadsheet Row)",
      "Map claim number, status, amounts, dates",
    ],
  },
];

interface ZapierIntegrationSettingsProps {
  embedded?: boolean;
}

export function ZapierIntegrationSettings({ embedded }: ZapierIntegrationSettingsProps) {
  const { toast } = useToast();
  const [testUrl, setTestUrl] = useState("");
  const [testing, setTesting] = useState(false);

  const handleTestWebhook = async () => {
    if (!testUrl) {
      toast({ title: "Error", description: "Please enter a Zapier webhook URL", variant: "destructive" });
      return;
    }
    setTesting(true);
    try {
      await fetch(testUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        mode: "no-cors",
        body: JSON.stringify({
          test: true,
          timestamp: new Date().toISOString(),
          triggered_from: window.location.origin,
        }),
      });
      toast({ title: "Request Sent", description: "Check your Zap's history to confirm it was triggered." });
    } catch {
      toast({ title: "Error", description: "Failed to trigger the webhook. Check the URL and try again.", variant: "destructive" });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-primary" />
            Zapier Integration
          </CardTitle>
          <CardDescription>
            Connect Freedom Claims with thousands of apps using Zapier's automation platform
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-3 p-4 rounded-lg bg-muted/50 border">
              <h4 className="font-semibold flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                What You Can Automate
              </h4>
              <ul className="text-sm text-muted-foreground space-y-2">
                <li>• Sync photos from Company Cam to claims</li>
                <li>• Create claims from form submissions</li>
                <li>• Send data to Google Sheets, Airtable, etc.</li>
                <li>• Trigger notifications in Slack or Teams</li>
                <li>• Connect with 7,000+ apps</li>
              </ul>
            </div>

            <div className="space-y-3 p-4 rounded-lg bg-muted/50 border">
              <h4 className="font-semibold flex items-center gap-2">
                <ArrowRight className="h-4 w-4 text-primary" />
                Getting Started
              </h4>
              <ol className="text-sm text-muted-foreground space-y-2 list-decimal list-inside">
                <li>Create a free Zapier account</li>
                <li>Create a new Zap with your desired trigger</li>
                <li>Add a Webhooks by Zapier action (POST)</li>
                <li>Point it at the endpoint below</li>
              </ol>
            </div>
          </div>

          <div className="p-4 rounded-lg border border-primary/20 bg-primary/5">
            <h4 className="font-semibold mb-2">Available Endpoints</h4>
            <p className="text-sm text-muted-foreground mb-3">
              Use Zapier's Webhooks action to send data to these Freedom Claims endpoints:
            </p>
            <div className="space-y-2 text-sm font-mono bg-background rounded p-3">
              <div>
                <span className="text-muted-foreground">Automations:</span>
                <br />
                <code className="text-xs break-all">POST {AWS_FUNCTIONS_BASE}/automation-webhook</code>
              </div>
              <div className="pt-2 border-t">
                <span className="text-muted-foreground">Inbound Email:</span>
                <br />
                <code className="text-xs break-all">POST {AWS_FUNCTIONS_BASE}/inbound-email</code>
              </div>
            </div>
          </div>

          {/* Test Webhook */}
          <div className="p-4 rounded-lg border bg-muted/30 space-y-3">
            <h4 className="font-semibold text-sm">Test a Zapier Webhook</h4>
            <div className="flex gap-2">
              <Input
                value={testUrl}
                onChange={(e) => setTestUrl(e.target.value)}
                placeholder="https://hooks.zapier.com/hooks/catch/..."
                className="flex-1"
              />
              <Button onClick={handleTestWebhook} disabled={testing} size="sm">
                {testing ? "Sending..." : "Test"}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Paste a Zapier webhook URL and send a test payload to verify connectivity.
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button variant="outline" asChild>
              <a href="https://zapier.com/apps" target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-4 w-4 mr-2" />
                Browse Zapier Apps
              </a>
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="h-5 w-5" />
            Zap Templates
          </CardTitle>
          <CardDescription>
            Follow these step-by-step guides to set up common automations in Zapier
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-2">
            {zapTemplates.map((template, idx) => {
              const Icon = template.icon;
              return (
                <div key={idx} className="p-4 rounded-lg border bg-card hover:bg-muted/50 transition-colors">
                  <div className="flex items-start gap-3">
                    <div className="p-2 rounded-lg bg-primary/10">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h4 className="font-semibold text-sm">{template.name}</h4>
                      <p className="text-xs text-muted-foreground mt-1">{template.description}</p>
                      <ol className="mt-2 text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                        {template.steps.map((step, i) => (
                          <li key={i}>{step}</li>
                        ))}
                      </ol>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
