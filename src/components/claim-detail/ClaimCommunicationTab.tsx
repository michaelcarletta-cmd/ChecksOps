import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ClaimEmails } from "./ClaimEmails";
import { ClaimSMS } from "./ClaimSMS";
import { ChevronDown } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

const commTabs = [
  { value: "emails", label: "Emails" },
  { value: "sms", label: "SMS / Text" },
];

export function ClaimCommunicationTab({ 
  claimId, 
  claim
}: { claimId: string; claim: any }) {
  const [activeTab, setActiveTab] = useState("emails");
  const isMobile = useIsMobile();
  const activeLabel = commTabs.find(t => t.value === activeTab)?.label || "Emails";

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
      {isMobile ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="w-full justify-between bg-muted border-border text-foreground font-medium">
              <span>{activeLabel}</span>
              <ChevronDown className="h-4 w-4 ml-2 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-[var(--radix-dropdown-menu-trigger-width)] bg-popover border-border" align="start">
            {commTabs.map((tab) => (
              <DropdownMenuItem
                key={tab.value}
                onClick={() => setActiveTab(tab.value)}
                className={`cursor-pointer ${activeTab === tab.value ? 'bg-accent text-accent-foreground' : ''}`}
              >
                {tab.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <TabsList className="flex flex-row w-full bg-muted/40 p-2 gap-1 overflow-x-auto scrollbar-hide">
          <TabsTrigger value="emails" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">Emails</TabsTrigger>
          <TabsTrigger value="sms" className="flex-1 md:flex-none justify-start text-base font-medium px-4 whitespace-nowrap">SMS / Text</TabsTrigger>
        </TabsList>
      )}
      <TabsContent value="emails" className="mt-6">
        <ClaimEmails claimId={claimId} claim={claim} />
      </TabsContent>
      <TabsContent value="sms" className="mt-6">
        <ClaimSMS claimId={claimId} policyholderPhone={claim.policyholder_phone} />
      </TabsContent>
    </Tabs>
  );
}
