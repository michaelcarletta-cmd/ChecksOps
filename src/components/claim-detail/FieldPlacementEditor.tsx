import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import mammoth from "mammoth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Pencil, Calendar, Type, Trash2, Save, ChevronLeft, ChevronRight, CheckSquare, Tag } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/aws/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DOCUMENT_TYPE_OPTIONS, SIGNER_DISPLAY_TEMPLATES, getFieldTemplateKey } from "@/lib/signer-display-templates";
import { useDocumentPresets } from "@/hooks/useDocumentPresets";

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface Field {
  id: string;
  type: "signature" | "date" | "text" | "checkbox";
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  required: boolean;
  signerIndex?: number;
  page?: number;
  display_label?: string;
  display_help_text?: string;
  display_section?: string;
  display_order?: number;
}

interface FieldPlacementEditorProps {
  documentUrl?: string;
  docxData?: Uint8Array;
  onFieldsChange: (fields: Field[]) => void;
  signerCount: number;
}

export function FieldPlacementEditor({ documentUrl, docxData, onFieldsChange, signerCount }: FieldPlacementEditorProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [fields, setFields] = useState<Field[]>([]);
  const [activeTool, setActiveTool] = useState<"signature" | "date" | "text" | "checkbox" | null>(null);
  const [currentSignerIndex, setCurrentSignerIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  // PDF state
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageWidth, setPageWidth] = useState(600);
  const [pageHeight, setPageHeight] = useState(800);
  
  // Save template dialog state
  const [isSaveDialogOpen, setIsSaveDialogOpen] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const [templateDescription, setTemplateDescription] = useState("");

  // Load template state
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  
  // Display metadata editing state
  const [editingFieldDisplay, setEditingFieldDisplay] = useState<string | null>(null);
  const [editDisplayLabel, setEditDisplayLabel] = useState("");
  const [editDisplayHelpText, setEditDisplayHelpText] = useState("");
  const [editDisplaySection, setEditDisplaySection] = useState("");
  const [selectedDocType, setSelectedDocType] = useState<string>("");
  
  // DOCX HTML rendering
  const [docxHtml, setDocxHtml] = useState<string | null>(null);
  const docxContainerRef = useRef<HTMLDivElement>(null);

  // Field picker popup
  const [pendingClickPos, setPendingClickPos] = useState<{x: number, y: number} | null>(null);
  
  // Dragging state
  const [draggingField, setDraggingField] = useState<string | null>(null);
  
  // Resizing state
  const [resizingField, setResizingField] = useState<string | null>(null);
  const [resizeStart, setResizeStart] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const wasDraggingRef = useRef(false);

  // Fetch available templates
  const { data: templates } = useQuery({
    queryKey: ["signature-field-templates"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("signature_field_templates")
        .select("*")
        .eq("is_active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  // Fetch DB presets for document type dropdown
  const { data: dbPresets } = useDocumentPresets();

  // Merge DB presets with hardcoded options for dropdown
  const docTypeOptions = useMemo(() => {
    if (!dbPresets?.length) return DOCUMENT_TYPE_OPTIONS;
    return dbPresets.map((p) => ({
      value: p.document_type,
      label: p.label,
      description: p.description || "",
    }));
  }, [dbPresets]);

  // Convert DOCX to HTML using mammoth when docxData is provided
  useEffect(() => {
    if (!docxData) return;
    setIsLoading(true);
    mammoth.convertToHtml(
      { arrayBuffer: docxData.buffer as ArrayBuffer },
      {
        convertImage: mammoth.images.imgElement(function(image: any) {
          return image.read("base64").then(function(imageBuffer: string) {
            return { src: `data:${image.contentType};base64,${imageBuffer}` };
          });
        }),
      }
    )
      .then((result) => {
        setDocxHtml(result.value);
        setIsLoading(false);
        toast({ title: "Document loaded. Click on the document to place fields." });
      })
      .catch((err) => {
        console.error("Mammoth conversion error:", err);
        setIsLoading(false);
        toast({ title: "Failed to render document", description: err.message, variant: "destructive" });
      });
  }, [docxData, toast]);

  const isDocxMode = !!docxData;

  // Save template mutation
  const saveTemplateMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("signature_field_templates")
        .insert([{
          name: templateName,
          description: templateDescription,
          field_data: fields as any,
        }]);
      if (error) throw error;
    },
    onSuccess: () => {
      toast({ title: "Field layout template saved successfully" });
      setIsSaveDialogOpen(false);
      setTemplateName("");
      setTemplateDescription("");
      queryClient.invalidateQueries({ queryKey: ["signature-field-templates"] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save template", description: error.message, variant: "destructive" });
    },
  });

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setIsLoading(false);
    toast({ title: `PDF loaded with ${numPages} page(s). Click on the document to place fields.` });
  }, [toast]);

  const onPageLoadSuccess = useCallback(({ width, height }: { width: number; height: number }) => {
    setPageWidth(width);
    setPageHeight(height);
  }, []);

  const onDocumentLoadError = useCallback((error: Error) => {
    console.error("PDF load error:", error);
    setIsLoading(false);
    toast({ 
      title: "Failed to load PDF", 
      description: "Try opening the PDF in a new tab instead",
      variant: "destructive" 
    });
  }, [toast]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    // Suppress click if we just finished dragging
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    if (!overlayRef.current) return;
    
    // Prevent if clicking on an existing field or picker
    if ((e.target as HTMLElement).closest('.field-indicator')) return;
    if ((e.target as HTMLElement).closest('.field-picker')) return;

    const rect = overlayRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool) {
      addField(activeTool, x, y);
      setActiveTool(null);
    } else {
      setPendingClickPos({ x, y });
    }
  };

  const addField = (type: "signature" | "date" | "text" | "checkbox", x: number, y: number) => {
    const fieldId = `${type}-${Date.now()}`;
    const width = type === "signature" ? 150 : type === "checkbox" ? 20 : type === "date" ? 100 : 120;
    const height = type === "signature" ? 50 : type === "checkbox" ? 20 : 25;

    const newField: Field = {
      id: fieldId,
      type,
      x,
      y,
      width,
      height,
      label: type === "signature" ? `Signature ${currentSignerIndex + 1}` :
             type === "date" ? "Date" : 
             type === "checkbox" ? "Checkbox" : "Text Field",
      required: true,
      signerIndex: currentSignerIndex,
      page: currentPage,
    };

    const updatedFields = [...fields, newField];
    setFields(updatedFields);
    emitFieldsAsPercentages(updatedFields);
    toast({ title: `${type} field added to page ${currentPage}` });
  };

  const handleSelectFieldType = (type: "signature" | "date" | "text" | "checkbox") => {
    if (pendingClickPos) {
      addField(type, pendingClickPos.x, pendingClickPos.y);
      setPendingClickPos(null);
    }
  };

  const handleFieldMouseDown = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    const field = fields.find(f => f.id === fieldId);
    if (!field) return;
    
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDragOffset({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    });
    setDraggingField(fieldId);
  };

  // Use document-level listeners for reliable drag/resize tracking
  useEffect(() => {
    const handleDocMouseMove = (e: MouseEvent) => {
      if (!overlayRef.current) return;
      if (!draggingField && !resizingField) return;

      const rect = overlayRef.current.getBoundingClientRect();

      if (resizingField) {
        const newWidth = Math.max(20, e.clientX - rect.left - resizeStart.x + resizeStart.width);
        const newHeight = Math.max(15, e.clientY - rect.top - resizeStart.y + resizeStart.height);
        setFields(prev => prev.map(f =>
          f.id === resizingField ? { ...f, width: newWidth, height: newHeight } : f
        ));
        return;
      }

      if (draggingField) {
        const newX = Math.max(0, e.clientX - rect.left - dragOffset.x);
        const newY = Math.max(0, e.clientY - rect.top - dragOffset.y);
        setFields(prev => prev.map(f =>
          f.id === draggingField ? { ...f, x: newX, y: newY } : f
        ));
      }
    };

    const handleDocMouseUp = () => {
      if (draggingField || resizingField) {
        wasDraggingRef.current = true;
        setDraggingField(null);
        setResizingField(null);
        // onFieldsChange will be called via the effect below
      }
    };

    document.addEventListener('mousemove', handleDocMouseMove);
    document.addEventListener('mouseup', handleDocMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleDocMouseMove);
      document.removeEventListener('mouseup', handleDocMouseUp);
    };
  }, [draggingField, resizingField, dragOffset, resizeStart]);

  // Sync fields to parent after drag/resize ends — convert to percentages
  useEffect(() => {
    if (!draggingField && !resizingField) {
      emitFieldsAsPercentages(fields);
    }
  }, [draggingField, resizingField]);

  // Convert pixel coordinates to percentages (0-100) relative to overlay size
  const emitFieldsAsPercentages = useCallback((pixelFields: Field[]) => {
    const overlay = overlayRef.current;
    if (!overlay || pixelFields.length === 0) {
      onFieldsChange(pixelFields.length === 0 ? [] : pixelFields);
      return;
    }
    const rect = overlay.getBoundingClientRect();
    const ow = rect.width || 600;
    const oh = rect.height || 800;
    const converted = pixelFields.map(f => ({
      ...f,
      x: parseFloat(((f.x / ow) * 100).toFixed(4)),
      y: parseFloat(((f.y / oh) * 100).toFixed(4)),
      width: parseFloat(((f.width / ow) * 100).toFixed(4)),
      height: parseFloat(((f.height / oh) * 100).toFixed(4)),
    }));
    onFieldsChange(converted);
  }, [onFieldsChange]);

  const handleResizeMouseDown = (e: React.MouseEvent, fieldId: string) => {
    e.preventDefault();
    e.stopPropagation();

    const field = fields.find(f => f.id === fieldId);
    if (!field || !overlayRef.current) return;

    setResizeStart({
      x: field.x,
      y: field.y,
      width: field.width,
      height: field.height,
    });
    setResizingField(fieldId);
  };

  const removeField = (fieldId: string) => {
    const updatedFields = fields.filter(f => f.id !== fieldId);
    setFields(updatedFields);
    emitFieldsAsPercentages(updatedFields);
    toast({ title: "Field removed" });
  };

  const clearAllFields = () => {
    setFields([]);
    onFieldsChange([]);
    toast({ title: "All fields cleared" });
  };

  // Load template — templates are stored in percentages, convert back to pixels for display
  const pixelsFromPercent = useCallback((percentFields: Field[]): Field[] => {
    const overlay = overlayRef.current;
    const ow = overlay ? overlay.getBoundingClientRect().width : 600;
    const oh = overlay ? overlay.getBoundingClientRect().height : 800;
    return percentFields.map(f => ({
      ...f,
      x: (f.x / 100) * ow,
      y: (f.y / 100) * oh,
      width: (f.width / 100) * ow,
      height: (f.height / 100) * oh,
    }));
  }, []);

  const loadTemplate = (templateId: string) => {
    const template = templates?.find(t => t.id === templateId);
    if (!template) return;

    clearAllFields();
    const templateFields = (Array.isArray(template.field_data) ? template.field_data : []) as unknown as Field[];
    // Templates may be in percentages — check if values look like percentages (< 100)
    const looksLikePercent = templateFields.length > 0 && templateFields.every(f => f.x <= 100 && f.y <= 100);
    const displayFields = looksLikePercent ? pixelsFromPercent(templateFields) : templateFields;
    setFields(displayFields);
    emitFieldsAsPercentages(displayFields);
    toast({ title: `Template "${template.name}" loaded` });
  };
  // Apply document type display labels to existing fields
  const applyDocTypeLabels = (docType: string) => {
    // Check DB presets first, then hardcoded
    const dbPreset = dbPresets?.find((p) => p.document_type === docType);
    const templateFields = dbPreset?.fields || SIGNER_DISPLAY_TEMPLATES[docType]?.fields;
    const templateLabel = dbPreset?.label || SIGNER_DISPLAY_TEMPLATES[docType]?.label || docType;
    if (!templateFields) return;

    // Count fields by type to assign indexed keys
    const typeCounts: Record<string, number> = {};
    const updated = fields.map(f => {
      typeCounts[f.type] = (typeCounts[f.type] || 0) + 1;
      const key = getFieldTemplateKey(f.type, typeCounts[f.type]);
      const meta = templateFields[key];
      if (meta) {
        return {
          ...f,
          display_label: meta.display_label,
          display_help_text: meta.display_help_text,
          display_section: meta.display_section,
          display_order: meta.display_order,
        };
      }
      return f;
    });
    setFields(updated);
    emitFieldsAsPercentages(updated);
    toast({ title: `Applied "${templateLabel}" labels to ${Object.keys(typeCounts).length > 0 ? 'fields' : 'no fields'}` });
  };


  const colors: Record<string, string> = {
    signature: "#3b82f6",
    date: "#10b981",
    text: "#8b5cf6",
    checkbox: "#f59e0b",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Label>Place Fields on Document</Label>
        <div className="flex gap-2 flex-wrap">
          {/* Load Template */}
          <Select value={selectedTemplateId} onValueChange={(id) => { setSelectedTemplateId(id); loadTemplate(id); }}>
            <SelectTrigger className="w-[200px]">
              <SelectValue placeholder="Load template..." />
            </SelectTrigger>
            <SelectContent>
              {templates?.map((template) => (
                <SelectItem key={template.id} value={template.id}>
                  {template.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {/* Save Template */}
          <Dialog open={isSaveDialogOpen} onOpenChange={setIsSaveDialogOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={fields.length === 0}>
                <Save className="w-4 h-4 mr-2" />
                Save as Template
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Save Field Layout Template</DialogTitle>
                <DialogDescription>
                  Save this field layout to reuse on other documents
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div>
                  <Label>Template Name</Label>
                  <Input
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                    placeholder="e.g., Standard Contract Layout"
                  />
                </div>
                <div>
                  <Label>Description (optional)</Label>
                  <Textarea
                    value={templateDescription}
                    onChange={(e) => setTemplateDescription(e.target.value)}
                    placeholder="Describe when to use this template..."
                    rows={3}
                  />
                </div>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => saveTemplateMutation.mutate()}
                  disabled={!templateName || saveTemplateMutation.isPending}
                >
                  {saveTemplateMutation.isPending ? "Saving..." : "Save Template"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {signerCount > 1 && (
            <div className="flex items-center gap-2">
              <Label className="text-sm">For Signer:</Label>
              <div className="flex gap-1">
                {Array.from({ length: signerCount }, (_, i) => (
                  <Button
                    key={i}
                    variant={currentSignerIndex === i ? "default" : "outline"}
                    size="sm"
                    onClick={() => setCurrentSignerIndex(i)}
                  >
                    {i + 1}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Button variant="outline" size="sm" onClick={clearAllFields}>
            <Trash2 className="w-4 h-4 mr-2" />
            Clear All
          </Button>
          
          {/* Apply document type display labels */}
          {fields.length > 0 && (
            <Select value={selectedDocType} onValueChange={(docType) => {
              setSelectedDocType(docType);
              applyDocTypeLabels(docType);
            }}>
              <SelectTrigger className="w-[200px]">
                <SelectValue placeholder="Apply label template..." />
              </SelectTrigger>
              <SelectContent>
                {docTypeOptions.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <Card className="p-4">
        {/* Tool buttons */}
        <div className="flex gap-2 mb-4 flex-wrap">
          <Button
            variant={activeTool === "signature" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTool(activeTool === "signature" ? null : "signature")}
          >
            <Pencil className="w-4 h-4 mr-2" />
            Add Signature
          </Button>
          <Button
            variant={activeTool === "date" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTool(activeTool === "date" ? null : "date")}
          >
            <Calendar className="w-4 h-4 mr-2" />
            Add Date
          </Button>
          <Button
            variant={activeTool === "text" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTool(activeTool === "text" ? null : "text")}
          >
            <Type className="w-4 h-4 mr-2" />
            Add Text
          </Button>
          <Button
            variant={activeTool === "checkbox" ? "default" : "outline"}
            size="sm"
            onClick={() => setActiveTool(activeTool === "checkbox" ? null : "checkbox")}
          >
            <CheckSquare className="w-4 h-4 mr-2" />
            Add Checkbox
          </Button>
        </div>

        {activeTool && (
          <div className="mb-4 p-3 bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded text-sm text-blue-800 dark:text-blue-200">
            Click on the document to place a {activeTool} field
          </div>
        )}

        {/* Page navigation */}
        {numPages > 1 && (
          <div className="flex items-center justify-center gap-4 mb-4">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage <= 1}
            >
              <ChevronLeft className="w-4 h-4" />
              Previous
            </Button>
            <span className="text-sm">
              Page {currentPage} of {numPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
              disabled={currentPage >= numPages}
            >
              Next
              <ChevronRight className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* Document rendering with overlay */}
        <div className="border rounded overflow-auto bg-muted/30 flex justify-center p-4">
          {isLoading && (
            <div className="flex items-center justify-center h-96 w-full">
              <p className="text-muted-foreground">Loading document...</p>
            </div>
          )}
          
          <div className="relative inline-block">
            {/* DOCX rendered as HTML */}
            {isDocxMode && docxHtml && (
              <div
                ref={docxContainerRef}
                className="bg-white text-black shadow-md docx-preview"
                style={{ width: 650, minHeight: 800, padding: '48px 56px', boxSizing: 'border-box' }}
                dangerouslySetInnerHTML={{ __html: docxHtml }}
              />
            )}

            {/* PDF rendered via react-pdf */}
            {!isDocxMode && documentUrl && (
              <Document
                file={documentUrl}
                onLoadSuccess={onDocumentLoadSuccess}
                onLoadError={onDocumentLoadError}
                loading={
                  <div className="flex items-center justify-center h-96 w-full max-w-[600px]">
                    <p className="text-muted-foreground">Loading PDF...</p>
                  </div>
                }
                error={
                  <div className="flex flex-col items-center justify-center h-96 w-full max-w-[600px] bg-muted/20 border rounded">
                    <p className="text-muted-foreground mb-4">Could not load PDF preview</p>
                    <Button variant="outline" onClick={() => window.open(documentUrl, '_blank')}>
                      Open PDF in New Tab
                    </Button>
                  </div>
                }
              >
                <Page
                  pageNumber={currentPage}
                  width={600}
                  onLoadSuccess={onPageLoadSuccess}
                  renderTextLayer={false}
                  renderAnnotationLayer={false}
                />
              </Document>
            )}
            
            {/* Clickable overlay for field placement */}
            {(!isLoading && (isDocxMode ? docxHtml : !isDocxMode)) && (
              <div
                ref={overlayRef}
                className={`absolute inset-0 ${draggingField ? 'cursor-grabbing' : activeTool ? 'cursor-crosshair' : 'cursor-pointer'}`}
                onClick={handleOverlayClick}
              >
                {/* Render field indicators for current page */}
                {fields.filter(f => f.page === currentPage).map((field) => (
                  <div
                    key={field.id}
                    className={`field-indicator absolute border-2 border-dashed flex items-center justify-center text-xs font-bold select-none ${
                      draggingField === field.id || resizingField === field.id ? 'opacity-70' : ''
                    } ${!activeTool ? 'cursor-move' : ''}`}
                    style={{
                      left: field.x,
                      top: field.y,
                      width: field.width,
                      height: field.height,
                      borderColor: colors[field.type],
                      backgroundColor: colors[field.type] + "33",
                      color: colors[field.type],
                    }}
                    onMouseDown={(e) => !activeTool && handleFieldMouseDown(e, field.id)}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      removeField(field.id);
                    }}
                  >
                    {field.type === "checkbox" ? "☐" : field.label}
                    {/* Resize handle */}
                    <div
                      className="absolute bottom-0 right-0 w-3 h-3 cursor-se-resize bg-current opacity-50 hover:opacity-100"
                      style={{ 
                        clipPath: 'polygon(100% 0, 100% 100%, 0 100%)',
                      }}
                      onMouseDown={(e) => handleResizeMouseDown(e, field.id)}
                    />
                  </div>
                ))}
                
                {/* Field type picker popup */}
                {pendingClickPos && (
                  <div 
                    className="field-picker absolute bg-popover border rounded-lg shadow-lg p-2 z-50"
                    style={{ 
                      left: Math.min(pendingClickPos.x, 450), 
                      top: pendingClickPos.y 
                    }}
                  >
                    <div className="text-xs text-muted-foreground mb-2">Select field type:</div>
                    <div className="flex flex-col gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="justify-start"
                        onClick={() => handleSelectFieldType("signature")}
                      >
                        <Pencil className="w-4 h-4 mr-2 text-blue-500" />
                        Signature
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="justify-start"
                        onClick={() => handleSelectFieldType("date")}
                      >
                        <Calendar className="w-4 h-4 mr-2 text-green-500" />
                        Date
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="justify-start"
                        onClick={() => handleSelectFieldType("text")}
                      >
                        <Type className="w-4 h-4 mr-2 text-purple-500" />
                        Text
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="justify-start"
                        onClick={() => handleSelectFieldType("checkbox")}
                      >
                        <CheckSquare className="w-4 h-4 mr-2 text-amber-500" />
                        Checkbox
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="w-full mt-1 text-muted-foreground"
                      onClick={() => setPendingClickPos(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Field list with display label editing */}
        {fields.length > 0 && (
          <div className="mt-4">
            <Label className="text-sm mb-2 block">
              Placed Fields ({fields.length}) — Double-click to remove · Click <Tag className="w-3 h-3 inline" /> to edit signer-facing label
            </Label>
            <div className="flex flex-wrap gap-2">
              {fields.map((field) => (
                <div key={field.id} className="flex items-center gap-1">
                  <Badge 
                    variant="outline"
                    className={`cursor-pointer hover:bg-destructive/10 ${field.page === currentPage ? 'ring-2 ring-primary' : ''}`}
                    onClick={() => removeField(field.id)}
                  >
                    {field.display_label || field.label} {field.page && `(P${field.page})`} {field.signerIndex !== undefined && `S${field.signerIndex + 1}`}
                  </Badge>
                  <button
                    type="button"
                    className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                    title="Edit signer-facing label"
                    onClick={() => {
                      setEditingFieldDisplay(field.id);
                      setEditDisplayLabel(field.display_label || "");
                      setEditDisplayHelpText(field.display_help_text || "");
                      setEditDisplaySection(field.display_section || "");
                    }}
                  >
                    <Tag className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Display metadata edit dialog */}
        <Dialog open={!!editingFieldDisplay} onOpenChange={(open) => { if (!open) setEditingFieldDisplay(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Edit Signer-Facing Label</DialogTitle>
              <DialogDescription>
                These labels are shown to the signer on the signing page. They do not affect field IDs or submission data.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div>
                <Label>Display Label</Label>
                <Input
                  value={editDisplayLabel}
                  onChange={(e) => setEditDisplayLabel(e.target.value)}
                  placeholder="e.g., Owner Signature"
                />
              </div>
              <div>
                <Label>Help Text</Label>
                <Textarea
                  value={editDisplayHelpText}
                  onChange={(e) => setEditDisplayHelpText(e.target.value)}
                  placeholder="e.g., Sign here to approve the contract terms."
                  rows={2}
                />
              </div>
              <div>
                <Label>Section Group (optional)</Label>
                <Input
                  value={editDisplaySection}
                  onChange={(e) => setEditDisplaySection(e.target.value)}
                  placeholder="e.g., Signatures, Identification"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setEditingFieldDisplay(null)}>Cancel</Button>
              <Button onClick={() => {
                if (!editingFieldDisplay) return;
                const updated = fields.map(f => 
                  f.id === editingFieldDisplay 
                    ? {
                        ...f,
                        display_label: editDisplayLabel || undefined,
                        display_help_text: editDisplayHelpText || undefined,
                        display_section: editDisplaySection || undefined,
                      }
                    : f
                );
                setFields(updated);
                emitFieldsAsPercentages(updated);
                setEditingFieldDisplay(null);
                toast({ title: "Field label updated" });
              }}>
                Save Label
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </Card>
    </div>
  );
}
