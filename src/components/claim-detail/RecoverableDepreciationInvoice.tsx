import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { FileText, Image, Loader2, Download, Camera, File, CheckSquare, DollarSign, Package, Send, Building2, AlertCircle, Sparkles, FileSearch } from "lucide-react";
import { format } from "date-fns";

interface RecoverableDepreciationInvoiceProps {
  claimId: string;
  claim: any;
}

interface ClaimPhoto {
  id: string;
  file_name: string;
  file_path: string;
  category: string | null;
  description: string | null;
  created_at: string | null;
}

interface ClaimFile {
  id: string;
  file_name: string;
  file_path: string;
  file_type: string | null;
  folder_id: string | null;
  folder_name?: string;
  uploaded_at: string | null;
}

interface Settlement {
  id: string;
  recoverable_depreciation: number;
  replacement_cost_value: number;
  deductible: number;
  non_recoverable_depreciation: number;
  total_settlement: number | null;
  estimate_amount: number | null;
  pwi_recoverable_depreciation?: number;
  pwi_rcv?: number;
  pwi_non_recoverable_depreciation?: number;
  pwi_deductible?: number;
  other_structures_recoverable_depreciation?: number;
  other_structures_rcv?: number;
  other_structures_non_recoverable_depreciation?: number;
  other_structures_deductible?: number;
  personal_property_recoverable_depreciation?: number;
  personal_property_rcv?: number;
  personal_property_non_recoverable_depreciation?: number;
}

const formatCurrency = (amount: number | null | undefined): string => {
  if (amount === null || amount === undefined) return "$0.00";
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
};

interface Contractor {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  logo_url: string | null;
}

interface PaymentSummary {
  totalReceived: number;
  deductiblePaid: number;
}

export const RecoverableDepreciationInvoice = ({ claimId, claim }: RecoverableDepreciationInvoiceProps) => {
  const [photos, setPhotos] = useState<ClaimPhoto[]>([]);
  const [files, setFiles] = useState<ClaimFile[]>([]);
  const [allFiles, setAllFiles] = useState<ClaimFile[]>([]);
  const [estimateFiles, setEstimateFiles] = useState<ClaimFile[]>([]);
  const [selectedPhotos, setSelectedPhotos] = useState<Set<string>>(new Set());
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [selectedEstimateId, setSelectedEstimateId] = useState<string>("");
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [paymentSummary, setPaymentSummary] = useState<PaymentSummary>({ totalReceived: 0, deductiblePaid: 0 });
  const [loading, setLoading] = useState(false);
  const [loadingData, setLoadingData] = useState(true);
  const [analyzingEstimate, setAnalyzingEstimate] = useState(false);
  const [workDescription, setWorkDescription] = useState("");
  const [generatedPackageUrl, setGeneratedPackageUrl] = useState<string | null>(null);
  
  // Invoice form data
  const [invoiceData, setInvoiceData] = useState({
    invoiceNumber: `RD-${Date.now().toString().slice(-8)}`,
    invoiceDate: format(new Date(), "yyyy-MM-dd"),
    dueDate: format(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), "yyyy-MM-dd"),
    notes: "Request for release of recoverable depreciation upon completion of repairs.",
    supplementAmount: 0,
  });

  useEffect(() => {
    loadData();
  }, [claimId]);

  const loadData = async () => {
    setLoadingData(true);
    try {
      // Load settlement data - use maybeSingle() to handle no settlement case gracefully
      const { data: settlementData, error: settlementError } = await supabase
        .from('claim_settlements')
        .select('*')
        .eq('claim_id', claimId)
        .maybeSingle();

      if (settlementError) {
        console.error('Error loading settlement:', settlementError);
      }
      setSettlement(settlementData);

      // Load assigned contractor
      const { data: contractorAssignment } = await supabase
        .from('claim_contractors')
        .select('contractor_id')
        .eq('claim_id', claimId)
        .limit(1)
        .maybeSingle();

      if (contractorAssignment?.contractor_id) {
        const { data: contractorProfile } = await supabase
          .from('profiles')
          .select('id, full_name, email, phone, logo_url')
          .eq('id', contractorAssignment.contractor_id)
          .single();
        
        if (contractorProfile) {
          setContractor(contractorProfile);
        }
      }

      // Load checks received from insurance for this claim
      const { data: checksData } = await supabase
        .from('claim_checks')
        .select('amount, check_type')
        .eq('claim_id', claimId);

      if (checksData) {
        // Sum all checks received from insurance
        const received = checksData.reduce((sum, check) => sum + Number(check.amount || 0), 0);
        
        setPaymentSummary({
          totalReceived: received,
          deductiblePaid: 0, // User can track this separately
        });
      }

      // Load photos
      const { data: photosData, error: photosError } = await supabase
        .from('claim_photos')
        .select('id, file_name, file_path, category, description, created_at')
        .eq('claim_id', claimId)
        .order('created_at', { ascending: false });

      if (photosError) throw photosError;
      setPhotos(photosData || []);

      // Load folders to find Certificate of Completion folder
      const { data: foldersData, error: foldersError } = await supabase
        .from('claim_folders')
        .select('id, name')
        .eq('claim_id', claimId);

      if (foldersError) throw foldersError;

      const certFolder = foldersData?.find(f => f.name.toLowerCase().includes('certificate'));
      const estimateFolder = foldersData?.find(f => f.name.toLowerCase().includes('estimate'));
      
      // Load files from Certificate of Completion folder
      const { data: filesData, error: filesError } = await supabase
        .from('claim_files')
        .select('id, file_name, file_path, file_type, folder_id, uploaded_at')
        .eq('claim_id', claimId)
        .order('uploaded_at', { ascending: false });

      if (filesError) throw filesError;
      
      // Add folder names to files
      const filesWithFolders = (filesData || []).map(file => {
        const folder = foldersData?.find(f => f.id === file.folder_id);
        return { ...file, folder_name: folder?.name };
      });
      
      setAllFiles(filesWithFolders);
      
      // Filter to Certificate of Completion folder files only
      if (certFolder) {
        const certFiles = filesWithFolders.filter(f => f.folder_id === certFolder.id);
        setFiles(certFiles);
      } else {
        // If no cert folder, show all files
        setFiles(filesWithFolders);
      }

      // Filter to Estimate folder files (PDFs only for Darwin analysis)
      if (estimateFolder) {
        const estFiles = filesWithFolders.filter(f => 
          f.folder_id === estimateFolder.id && 
          (f.file_type?.includes('pdf') || f.file_name.toLowerCase().endsWith('.pdf'))
        );
        setEstimateFiles(estFiles);
      } else {
        // If no estimate folder, show all PDFs
        const pdfFiles = filesWithFolders.filter(f => 
          f.file_type?.includes('pdf') || f.file_name.toLowerCase().endsWith('.pdf')
        );
        setEstimateFiles(pdfFiles);
      }
    } catch (error) {
      console.error('Error loading data:', error);
      toast.error('Failed to load claim data');
    } finally {
      setLoadingData(false);
    }
  };

  const togglePhoto = (id: string) => {
    const newSelected = new Set(selectedPhotos);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedPhotos(newSelected);
  };

  const toggleFile = (id: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedFiles(newSelected);
  };

  const selectAllPhotos = () => {
    setSelectedPhotos(new Set(photos.map(p => p.id)));
  };

  const clearPhotos = () => {
    setSelectedPhotos(new Set());
  };

  const selectAllFiles = () => {
    setSelectedFiles(new Set(files.map(f => f.id)));
  };

  const clearFiles = () => {
    setSelectedFiles(new Set());
  };

  // Calculate total recoverable depreciation
  // Note: Paid When Incurred RCV is itself recoverable (released upon job completion)
  const getTotalRecoverableDepreciation = (): number => {
    if (!settlement) return 0;
    const dwelling = Number(settlement.recoverable_depreciation) || 0;
    const pwiRcv = Number(settlement.pwi_rcv) || 0; // Paid When Incurred RCV IS the recoverable amount
    const otherStructures = Number(settlement.other_structures_recoverable_depreciation) || 0;
    const personalProperty = Number(settlement.personal_property_recoverable_depreciation) || 0;
    return dwelling + pwiRcv + otherStructures + personalProperty;
  };

  // Analyze selected estimate with Darwin AI
  const analyzeEstimate = async (expandUserInput?: string) => {
    if (!selectedEstimateId) {
      toast.error('Please select an estimate file first');
      return;
    }

    const selectedFile = estimateFiles.find(f => f.id === selectedEstimateId);
    if (!selectedFile) {
      toast.error('Selected file not found');
      return;
    }

    setAnalyzingEstimate(true);
    try {
      // Download the file and convert to base64
      const { data: fileData, error: downloadError } = await supabase.storage
        .from('claim-files')
        .download(selectedFile.file_path);

      if (downloadError) throw downloadError;

      // Convert to base64
      const arrayBuffer = await fileData.arrayBuffer();
      const base64 = btoa(
        new Uint8Array(arrayBuffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
      );

      // Call Darwin AI analysis
      const { data: analysisResult, error: analysisError } = await supabase.functions.invoke('darwin-ai-analysis', {
        body: {
          claimId,
          analysisType: 'estimate_work_summary',
          pdfContent: base64,
          pdfFileName: selectedFile.file_name,
          additionalContext: expandUserInput ? { userInput: expandUserInput } : undefined,
        },
      });

      if (analysisError) throw analysisError;

      if (analysisResult?.result) {
        setWorkDescription(analysisResult.result);
        toast.success(expandUserInput 
          ? 'Darwin expanded your description using the estimate' 
          : 'Darwin analyzed the estimate and generated work description'
        );
      } else {
        toast.error('No analysis result received');
      }
    } catch (error: any) {
      console.error('Error analyzing estimate:', error);
      toast.error(error.message || 'Failed to analyze estimate');
    } finally {
      setAnalyzingEstimate(false);
    }
  };

  const expandDescription = () => {
    if (!workDescription.trim()) {
      toast.error('Please enter a brief work description to expand');
      return;
    }
    analyzeEstimate(workDescription);
  };

  const handleGeneratePackage = async () => {
    if (!settlement) {
      toast.error('No settlement data found. Please add settlement information first.');
      return;
    }

    const totalRD = getTotalRecoverableDepreciation();
    if (totalRD <= 0) {
      toast.error('No recoverable depreciation amount to invoice.');
      return;
    }

    setLoading(true);
    try {
      const supplementAmount = Number(invoiceData.supplementAmount) || 0;

      // Calculate outstanding ACV funds
      const rcvForCalc = Number(settlement.replacement_cost_value) || 0;
      const otherStructuresRCVForCalc = Number(settlement.other_structures_rcv) || 0;
      const pwiRCVForCalc = Number(settlement.pwi_rcv) || 0;
      const personalPropertyRCVForCalc = Number(settlement.personal_property_rcv) || 0;
      const totalRCVForCalc = rcvForCalc + otherStructuresRCVForCalc + pwiRCVForCalc + personalPropertyRCVForCalc;
      const nonRecoverableForCalc = Number(settlement.non_recoverable_depreciation) || 0;
      const deductibleForCalc = Number(settlement.deductible) || 0;
      const acvForCalc = totalRCVForCalc - totalRD - nonRecoverableForCalc;
      const outstandingACV = Math.max(0, acvForCalc - deductibleForCalc - paymentSummary.totalReceived);

      const totalAmount = totalRD + supplementAmount + outstandingACV;

      // Get individual depreciation amounts
      const dwellingRD = Number(settlement.recoverable_depreciation) || 0;
      const otherStructuresRD = Number(settlement.other_structures_recoverable_depreciation) || 0;
      const pwiRD = Number(settlement.pwi_recoverable_depreciation) || 0;
      const personalPropertyRD = Number(settlement.personal_property_recoverable_depreciation) || 0;

      // Generate the invoice with detailed line items for each category
      const lineItems: { description: string; quantity: number; unitPrice: number }[] = [];

      // Add each depreciation category as its own line item with actual amounts
      if (dwellingRD > 0) {
        lineItems.push({
          description: `Dwelling/Structure Recoverable Depreciation - Claim #${claim.claim_number || 'N/A'}`,
          quantity: 1,
          unitPrice: dwellingRD,
        });
      }
      
      if (otherStructuresRD > 0) {
        lineItems.push({
          description: `Other Structures Recoverable Depreciation - Claim #${claim.claim_number || 'N/A'}`,
          quantity: 1,
          unitPrice: otherStructuresRD,
        });
      }
      
      if (pwiRD > 0) {
        lineItems.push({
          description: `Paid When Incurred Recoverable Depreciation - Claim #${claim.claim_number || 'N/A'}`,
          quantity: 1,
          unitPrice: pwiRD,
        });
      }
      
      if (personalPropertyRD > 0) {
        lineItems.push({
          description: `Personal Property Recoverable Depreciation - Claim #${claim.claim_number || 'N/A'}`,
          quantity: 1,
          unitPrice: personalPropertyRD,
        });
      }

      // If no individual items but there's a total, use the total as a single line item
      if (lineItems.length === 0 && totalRD > 0) {
        lineItems.push({
          description: `Recoverable Depreciation - Claim #${claim.claim_number || 'N/A'}`,
          quantity: 1,
          unitPrice: totalRD,
        });
      }

      // Add supplement if present
      if (supplementAmount > 0) {
        lineItems.push({
          description: 'Supplement Amount',
          quantity: 1,
          unitPrice: supplementAmount,
        });
      }

      // Add outstanding ACV funds if present
      if (outstandingACV > 0) {
        lineItems.push({
          description: `Outstanding ACV Funds - Claim #${claim.claim_number || 'N/A'}`,
          quantity: 1,
          unitPrice: outstandingACV,
        });
      }

      // Calculate breakdown values (reuse already-calculated values from above)
      const deductible = deductibleForCalc;
      const nonRecoverableDepreciation = nonRecoverableForCalc;
      const paymentsReceived = paymentSummary.totalReceived;
      const acv = acvForCalc;

      // Get RCV values for each category
      const dwellingRCV = rcvForCalc;
      const otherStructuresRCV = otherStructuresRCVForCalc;
      const pwiRCV = pwiRCVForCalc;
      const personalPropertyRCV = personalPropertyRCVForCalc;
      const totalRCV = dwellingRCV + otherStructuresRCV + pwiRCV + personalPropertyRCV;

      // Generate signed URLs for selected photos to embed in invoice
      const photoUrls: { url: string; name: string; description: string }[] = [];
      if (selectedPhotos.size > 0) {
        for (const photoId of selectedPhotos) {
          const photo = photos.find(p => p.id === photoId);
          if (photo) {
            const { data: signedData } = await supabase.storage
              .from('claim-files')
              .createSignedUrl(photo.file_path, 7 * 24 * 60 * 60);
            if (signedData?.signedUrl) {
              photoUrls.push({
                url: signedData.signedUrl,
                name: photo.file_name,
                description: photo.description || photo.category || '',
              });
            }
          }
        }
      }

      const { data: invoiceResult, error: invoiceError } = await supabase.functions.invoke("generate-invoice", {
        body: {
          invoiceNumber: invoiceData.invoiceNumber,
          invoiceDate: invoiceData.invoiceDate,
          dueDate: invoiceData.dueDate,
          sender: contractor ? {
            name: contractor.full_name || 'Contractor',
            email: contractor.email || '',
            phone: contractor.phone || '',
            logoUrl: contractor.logo_url || '',
          } : null,
          recipient: {
            name: claim.insurance_company || 'Insurance Company',
            email: claim.insurance_email || '',
            address: '',
          },
          lineItems: lineItems.filter(item => item.unitPrice > 0),
          subtotal: totalAmount,
          notes: invoiceData.notes,
          claimNumber: claim.claim_number,
          policyholderName: claim.policyholder_name,
          workDescription: workDescription || undefined,
          supplementAmount: supplementAmount > 0 ? supplementAmount : undefined,
          photos: photoUrls.length > 0 ? photoUrls : undefined,
          settlementBreakdown: {
            rcv: totalRCV,
            acv,
            deductible,
            paymentsReceived,
            paymentsOutstanding: outstandingACV,
            recoverableDepreciation: totalRD,
            dwellingRCV,
            otherStructuresRCV,
            pwiRCV,
            personalPropertyRCV,
            dwellingRD,
            otherStructuresRD,
            pwiRD,
            personalPropertyRD,
            nonRecoverableDepreciation,
            supplement: supplementAmount > 0 ? supplementAmount : undefined,
          },
          claimId,
        },
      });

      if (invoiceError) throw invoiceError;

      setGeneratedPackageUrl(invoiceResult?.pdfUrl);
      toast.success('Invoice generated successfully!');

      // Log the selected photos and files count
      console.log(`Package includes: Invoice + ${selectedPhotos.size} photos + ${selectedFiles.size} documents`);

    } catch (error: any) {
      console.error('Error generating package:', error);
      toast.error(error.message || 'Failed to generate invoice package');
    } finally {
      setLoading(false);
    }
  };

  const downloadInvoice = () => {
    if (generatedPackageUrl) {
      fetch(generatedPackageUrl)
        .then(res => res.text())
        .then(html => {
          const printWindow = window.open('', '_blank');
          if (printWindow) {
            printWindow.document.write(html);
            printWindow.document.close();
          }
        })
        .catch(() => {
          window.open(generatedPackageUrl, "_blank");
        });
    }
  };

  const downloadSelectedFiles = async () => {
    if (selectedFiles.size === 0 && selectedPhotos.size === 0) {
      toast.error('No files or photos selected');
      return;
    }

    toast.info(`Opening ${selectedPhotos.size} photos and ${selectedFiles.size} documents...`);
    
    // Download selected files
    for (const fileId of selectedFiles) {
      const file = files.find(f => f.id === fileId);
      if (file) {
        const { data } = await supabase.storage
          .from('claim-files')
          .createSignedUrl(file.file_path, 3600);
        if (data?.signedUrl) {
          window.open(data.signedUrl, '_blank');
        }
      }
    }

    // Download selected photos
    for (const photoId of selectedPhotos) {
      const photo = photos.find(p => p.id === photoId);
      if (photo) {
        const { data } = await supabase.storage
          .from('claim-files')
          .createSignedUrl(photo.file_path, 3600);
        if (data?.signedUrl) {
          window.open(data.signedUrl, '_blank');
        }
      }
    }
  };

  if (loadingData) {
    return (
      <Card>
        <CardContent className="py-8 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" />
          <p className="text-muted-foreground">Loading claim data...</p>
        </CardContent>
      </Card>
    );
  }

  const totalRD = getTotalRecoverableDepreciation();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <DollarSign className="h-5 w-5 text-primary" />
          Recoverable Depreciation Invoice
        </CardTitle>
        <CardDescription>
          Generate final invoice for recoverable depreciation with Certificate of Completion documents
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Settlement Summary */}
        <div className="p-4 bg-muted/50 rounded-lg space-y-4">
          <h3 className="font-medium flex items-center gap-2">
            <Package className="h-4 w-4" />
            Settlement Summary
          </h3>
          {settlement ? (
            <div className="space-y-4">
              {/* RCV Values */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Replacement Cost Value (RCV)</p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Dwelling</p>
                    <p className="font-semibold">{formatCurrency(settlement.replacement_cost_value)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Other Structures</p>
                    <p className="font-semibold">{formatCurrency(settlement.other_structures_rcv)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Paid When Incurred</p>
                    <p className="font-semibold">{formatCurrency(settlement.pwi_rcv)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Personal Property</p>
                    <p className="font-semibold">{formatCurrency(settlement.personal_property_rcv)}</p>
                  </div>
                  <div className="border-l pl-4">
                    <p className="text-muted-foreground">Total RCV</p>
                    <p className="font-bold text-lg">{formatCurrency(
                      (Number(settlement.replacement_cost_value) || 0) +
                      (Number(settlement.other_structures_rcv) || 0) +
                      (Number(settlement.pwi_rcv) || 0) +
                      (Number(settlement.personal_property_rcv) || 0)
                    )}</p>
                  </div>
                </div>
              </div>

              {/* Recoverable Depreciation Values */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">Recoverable Depreciation (RD)</p>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Dwelling</p>
                    <p className="font-semibold text-primary">{formatCurrency(settlement.recoverable_depreciation)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Other Structures</p>
                    <p className="font-semibold text-primary">{formatCurrency(settlement.other_structures_recoverable_depreciation)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Paid When Incurred</p>
                    <p className="font-semibold text-primary">{formatCurrency(settlement.pwi_rcv)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Personal Property</p>
                    <p className="font-semibold text-primary">{formatCurrency(settlement.personal_property_recoverable_depreciation)}</p>
                  </div>
                  <div className="border-l pl-4">
                    <p className="text-muted-foreground">Total Recoverable</p>
                    <p className="font-bold text-lg text-primary">{formatCurrency(totalRD)}</p>
                  </div>
                </div>
              </div>

              {/* Deductible & Outstanding ACV */}
              <div className="pt-2 border-t">
                <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Deductible</p>
                    <p className="font-semibold">{formatCurrency(settlement.deductible)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Payments Received</p>
                    <p className="font-semibold">{formatCurrency(paymentSummary.totalReceived)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Outstanding ACV Funds</p>
                    <p className="font-semibold text-destructive">{formatCurrency((() => {
                      const rcvCalc = (Number(settlement.replacement_cost_value) || 0) +
                        (Number(settlement.other_structures_rcv) || 0) +
                        (Number(settlement.pwi_rcv) || 0) +
                        (Number(settlement.personal_property_rcv) || 0);
                      const nrd = Number(settlement.non_recoverable_depreciation) || 0;
                      const ded = Number(settlement.deductible) || 0;
                      const acvCalc = rcvCalc - getTotalRecoverableDepreciation() - nrd;
                      return Math.max(0, acvCalc - ded - paymentSummary.totalReceived);
                    })())}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Estimate Amount</p>
                    <p className="font-semibold">{formatCurrency(settlement.estimate_amount)}</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No settlement data found. Please add settlement information in the Accounting tab first.
            </p>
          )}
        </div>

        {/* Contractor Info (Invoice From) */}
        <div className="p-4 bg-blue-50 dark:bg-blue-950/30 rounded-lg space-y-2 border border-blue-200 dark:border-blue-800">
          <h3 className="font-medium flex items-center gap-2">
            <Building2 className="h-4 w-4 text-blue-600" />
            Invoice From (Contractor)
          </h3>
          {contractor ? (
            <div className="text-sm">
              <p className="font-semibold text-blue-900 dark:text-blue-100">{contractor.full_name}</p>
              {contractor.email && <p className="text-blue-700 dark:text-blue-300">{contractor.email}</p>}
              {contractor.phone && <p className="text-blue-700 dark:text-blue-300">{contractor.phone}</p>}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertCircle className="h-4 w-4" />
              <span>No contractor assigned. Please assign a contractor in the Assignments tab first.</span>
            </div>
          )}
        </div>

        {/* Invoice Details */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <Label>Invoice Number</Label>
            <Input
              value={invoiceData.invoiceNumber}
              onChange={(e) => setInvoiceData({ ...invoiceData, invoiceNumber: e.target.value })}
            />
          </div>
          <div>
            <Label>Invoice Date</Label>
            <Input
              type="date"
              value={invoiceData.invoiceDate}
              onChange={(e) => setInvoiceData({ ...invoiceData, invoiceDate: e.target.value })}
            />
          </div>
          <div>
            <Label>Due Date</Label>
            <Input
              type="date"
              value={invoiceData.dueDate}
              onChange={(e) => setInvoiceData({ ...invoiceData, dueDate: e.target.value })}
            />
          </div>
          <div>
            <Label>Supplement Amount</Label>
            <div className="relative">
              <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                type="number"
                min="0"
                step="0.01"
                className="pl-8"
                value={invoiceData.supplementAmount || ''}
                onChange={(e) => setInvoiceData({ ...invoiceData, supplementAmount: parseFloat(e.target.value) || 0 })}
                placeholder="0.00"
              />
            </div>
          </div>
        </div>

        <div>
          <Label>Notes</Label>
          <Textarea
            value={invoiceData.notes}
            onChange={(e) => setInvoiceData({ ...invoiceData, notes: e.target.value })}
            rows={2}
            placeholder="Additional notes for the invoice..."
          />
        </div>

        {/* Estimate Analysis Section */}
        <div className="p-4 bg-purple-50 dark:bg-purple-950/30 rounded-lg space-y-3 border border-purple-200 dark:border-purple-800">
          <h3 className="font-medium flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-600" />
            Darwin AI - Work Description
          </h3>
          <p className="text-sm text-muted-foreground">
            Select an estimate file and let Darwin analyze it to generate a description of the work completed.
          </p>
          
          <div className="flex gap-2">
            <div className="flex-1">
              <Select value={selectedEstimateId} onValueChange={setSelectedEstimateId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select estimate file..." />
                </SelectTrigger>
                <SelectContent>
                  {estimateFiles.length === 0 ? (
                    <SelectItem value="none" disabled>No PDF files found</SelectItem>
                  ) : (
                    estimateFiles.map(file => (
                      <SelectItem key={file.id} value={file.id}>
                        <span className="flex items-center gap-2">
                          <FileSearch className="h-4 w-4" />
                          {file.file_name}
                        </span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
            <Button 
              variant="outline" 
              onClick={() => analyzeEstimate()}
              disabled={!selectedEstimateId || analyzingEstimate}
              className="border-purple-300 text-purple-700 hover:bg-purple-100 dark:border-purple-700 dark:text-purple-300"
            >
              {analyzingEstimate ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Analyzing...
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Auto-Generate
                </>
              )}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Work Description (for invoice)</Label>
              <Button
                variant="ghost"
                size="sm"
                onClick={expandDescription}
                disabled={!selectedEstimateId || !workDescription.trim() || analyzingEstimate}
                className="text-purple-600 hover:text-purple-700 hover:bg-purple-50"
              >
                {analyzingEstimate ? (
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                ) : (
                  <Sparkles className="h-4 w-4 mr-1" />
                )}
                Expand with Darwin
              </Button>
            </div>
            <Textarea
              value={workDescription}
              onChange={(e) => setWorkDescription(e.target.value)}
              rows={3}
              placeholder="Type a brief description (e.g., 'roof replacement') and click 'Expand with Darwin' to elaborate using the estimate..."
              className="mt-1"
            />
            <p className="text-xs text-muted-foreground">
              Tip: Type a brief description like "roof replacement" then click "Expand with Darwin" to generate detailed invoice text from the estimate.
            </p>
          </div>
        </div>

        {/* Document Selection Tabs */}
        <Tabs defaultValue="documents" className="w-full">
          <TabsList className="flex flex-col sm:flex-row w-full h-auto gap-1 p-1">
            <TabsTrigger value="documents" className="w-full justify-start gap-2 px-3 py-2">
              <File className="h-4 w-4 flex-shrink-0" />
              <span>Certificate Docs ({selectedFiles.size}/{files.length})</span>
            </TabsTrigger>
            <TabsTrigger value="photos" className="w-full justify-start gap-2 px-3 py-2">
              <Camera className="h-4 w-4 flex-shrink-0" />
              <span>Photos ({selectedPhotos.size}/{photos.length})</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents" className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {files.length === 0 ? 'No documents in Certificate of Completion folder' : `${files.length} documents available`}
              </p>
              {files.length > 0 && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllFiles}>
                    <CheckSquare className="h-4 w-4 mr-1" />
                    Select All
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearFiles}>
                    Clear
                  </Button>
                </div>
              )}
            </div>

            {files.length > 0 && (
              <ScrollArea className="h-[200px] border rounded-md p-3">
                <div className="space-y-2">
                  {files.map(file => (
                    <div
                      key={file.id}
                      className={`flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-muted/50 ${
                        selectedFiles.has(file.id) ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => toggleFile(file.id)}
                    >
                      <Checkbox
                        checked={selectedFiles.has(file.id)}
                        onCheckedChange={() => toggleFile(file.id)}
                      />
                      <FileText className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <div className="overflow-hidden flex-1 min-w-0">
                        <p className="text-sm truncate">{file.file_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {file.folder_name} • {file.uploaded_at ? format(new Date(file.uploaded_at), 'MMM d, yyyy') : 'Unknown date'}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>

          <TabsContent value="photos" className="space-y-3">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {photos.length === 0 ? 'No photos uploaded' : `${photos.length} photos available`}
              </p>
              {photos.length > 0 && (
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={selectAllPhotos}>
                    <CheckSquare className="h-4 w-4 mr-1" />
                    Select All
                  </Button>
                  <Button variant="ghost" size="sm" onClick={clearPhotos}>
                    Clear
                  </Button>
                </div>
              )}
            </div>
            
            {photos.length > 0 && (
              <ScrollArea className="h-[200px] border rounded-md p-3">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {photos.map(photo => (
                    <div
                      key={photo.id}
                      className={`relative flex items-center gap-2 p-2 border rounded cursor-pointer hover:bg-muted/50 ${
                        selectedPhotos.has(photo.id) ? 'border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => togglePhoto(photo.id)}
                    >
                      <Checkbox
                        checked={selectedPhotos.has(photo.id)}
                        onCheckedChange={() => togglePhoto(photo.id)}
                      />
                      <Image className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                      <div className="overflow-hidden flex-1 min-w-0">
                        <p className="text-xs truncate">{photo.file_name}</p>
                        {photo.category && (
                          <p className="text-xs text-muted-foreground truncate">{photo.category}</p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-4 border-t">
          <Button
            onClick={handleGeneratePackage}
            disabled={loading || !settlement || totalRD <= 0}
            className="flex-1"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Generating Invoice...
              </>
            ) : (
              <>
                <FileText className="h-4 w-4 mr-2" />
                Generate Invoice ({formatCurrency(totalRD)})
              </>
            )}
          </Button>

          {(selectedFiles.size > 0 || selectedPhotos.size > 0) && (
            <Button variant="outline" onClick={downloadSelectedFiles}>
              <Download className="h-4 w-4 mr-2" />
              Download Selected ({selectedFiles.size + selectedPhotos.size})
            </Button>
          )}
        </div>

        {/* Generated Invoice */}
        {generatedPackageUrl && (
          <div className="p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-green-600" />
                <span className="font-medium text-green-800 dark:text-green-200">Invoice Generated!</span>
              </div>
              <Button variant="outline" size="sm" onClick={downloadInvoice}>
                <Download className="h-4 w-4 mr-2" />
                View/Print Invoice
              </Button>
            </div>
            <p className="text-sm text-green-700 dark:text-green-300">
              Invoice created for {formatCurrency(totalRD)}. Download the selected photos and documents to compile your complete RD release package.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
};
