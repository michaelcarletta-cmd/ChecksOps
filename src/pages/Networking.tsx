import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ContractorsTab } from "@/components/networking/ContractorsTab";
import { ContractorDirectoryTab } from "@/components/networking/ContractorDirectoryTab";
import { InsuranceCompaniesTab } from "@/components/networking/InsuranceCompaniesTab";
import { MortgageCompaniesDirectory } from "@/components/checks/MortgageCompaniesDirectory";
import { AdjustersTab } from "@/components/networking/AdjustersTab";

export default function Networking() {
  return (
    <div className="space-y-4 md:space-y-8 p-4 md:p-0">
      <div className="space-y-2 md:space-y-3">
        <h1 className="text-2xl md:text-4xl font-bold tracking-tight text-foreground">Networking</h1>
        <p className="text-muted-foreground text-sm md:text-lg">
          Browse the ChecksOps contractor directory, and manage your own contractors, referrers, insurance and mortgage companies
        </p>
      </div>

      <Tabs defaultValue="directory" className="space-y-6">
        <TabsList className="flex flex-col md:flex-row w-full bg-muted p-2 gap-1 h-auto rounded-md">
          <TabsTrigger value="directory" className="w-full md:w-auto justify-start text-sm md:text-base font-medium px-3 md:px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
            Directory
          </TabsTrigger>
          <TabsTrigger value="contractors" className="w-full md:w-auto justify-start text-sm md:text-base font-medium px-3 md:px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
            My Contractors
          </TabsTrigger>
          <TabsTrigger value="adjusters" className="w-full md:w-auto justify-start text-sm md:text-base font-medium px-3 md:px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
            Adjusters
          </TabsTrigger>
          <TabsTrigger value="insurance" className="w-full md:w-auto justify-start text-sm md:text-base font-medium px-3 md:px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
            Insurance Companies
          </TabsTrigger>
          <TabsTrigger value="mortgage" className="w-full md:w-auto justify-start text-sm md:text-base font-medium px-3 md:px-4 py-2 text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground rounded-sm">
            Mortgage Companies
          </TabsTrigger>
        </TabsList>

        <TabsContent value="directory">
          <ContractorDirectoryTab />
        </TabsContent>

        <TabsContent value="contractors">
          <ContractorsTab />
        </TabsContent>

        <TabsContent value="adjusters">
          <AdjustersTab />
        </TabsContent>

        <TabsContent value="insurance">
          <InsuranceCompaniesTab />
        </TabsContent>

        <TabsContent value="mortgage">
          <MortgageCompaniesDirectory />
        </TabsContent>
      </Tabs>
    </div>
  );
}
