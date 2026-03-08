import { useRef, useState, useCallback, useEffect } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/esm/Page/AnnotationLayer.css";
import "react-pdf/dist/esm/Page/TextLayer.css";
import mammoth from "mammoth";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card } from "@/components/ui/card";
import { Pencil, Calendar, Type, Trash2, Save, ChevronLeft, ChevronRight, CheckSquare } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
    onFieldsChange(updatedFields);
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

  // Sync fields to parent after drag/resize ends
  useEffect(() => {
    if (!draggingField && !resizingField) {
      onFieldsChange(fields);
    }
  }, [draggingField, resizingField]);

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
    onFieldsChange(updatedFields);
    toast({ title: "Field removed" });
  };

  const clearAllFields = () => {
    setFields([]);
    onFieldsChange([]);
    toast({ title: "All fields cleared" });
  };

  const loadTemplate = (templateId: string) => {
    const template = templates?.find(t => t.id === templateId);
    if (!template) return;

    clearAllFields();
    const templateFields = (Array.isArray(template.field_data) ? template.field_data : []) as unknown as Field[];
    setFields(templateFields);
    onFieldsChange(templateFields);
    toast({ title: `Template "${template.name}" loaded` });
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
                  <div className="flex items-center justify-center h-96 w-[600px]">
                    <p className="text-muted-foreground">Loading PDF...</p>
                  </div>
                }
                error={
                  <div className="flex flex-col items-center justify-center h-96 w-[600px] bg-muted/20 border rounded">
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

        {/* Field list */}
        {fields.length > 0 && (
          <div className="mt-4">
            <Label className="text-sm mb-2 block">
              Placed Fields ({fields.length}) - Double-click field to remove, or click badge below
            </Label>
            <div className="flex flex-wrap gap-2">
              {fields.map((field) => (
                <Badge 
                  key={field.id} 
                  variant="outline"
                  className={`cursor-pointer hover:bg-destructive/10 ${field.page === currentPage ? 'ring-2 ring-primary' : ''}`}
                  onClick={() => removeField(field.id)}
                >
                  {field.label} {field.page && `(P${field.page})`} {field.signerIndex !== undefined && `S${field.signerIndex + 1}`}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
