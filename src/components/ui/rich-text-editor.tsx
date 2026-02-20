import { useRef, useCallback, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Bold, Italic, Underline, Type, Palette } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";

interface RichTextEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}

const COLORS = [
  { name: "Black", value: "#000000" },
  { name: "Red", value: "#EF4444" },
  { name: "Blue", value: "#3B82F6" },
  { name: "Green", value: "#22C55E" },
  { name: "Orange", value: "#F97316" },
  { name: "Purple", value: "#A855F7" },
  { name: "Gray", value: "#6B7280" },
];

export function RichTextEditor({ value, onChange, placeholder, rows = 4 }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const isInitialized = useRef(false);

  // Only set initial content once
  useEffect(() => {
    if (editorRef.current && !isInitialized.current) {
      editorRef.current.innerHTML = value || '';
      isInitialized.current = true;
    }
  }, []);

  // Sync external value changes (e.g., when loading a template)
  useEffect(() => {
    if (editorRef.current && isInitialized.current) {
      // Only update if the value is completely different (like loading a template)
      const currentContent = editorRef.current.innerHTML;
      if (value !== currentContent && (value === '' || !currentContent.includes(value.slice(0, 20)))) {
        editorRef.current.innerHTML = value || '';
      }
    }
  }, [value]);

  const execCommand = useCallback((command: string, commandValue?: string) => {
    document.execCommand(command, false, commandValue);
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
    editorRef.current?.focus();
  }, [onChange]);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    if (editorRef.current) {
      onChange(editorRef.current.innerHTML);
    }
  }, [onChange]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1 p-1 bg-muted/50 rounded-md border border-input">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => execCommand('bold')}
          title="Bold"
        >
          <Bold className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => execCommand('italic')}
          title="Italic"
        >
          <Italic className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          onClick={() => execCommand('underline')}
          title="Underline"
        >
          <Underline className="h-4 w-4" />
        </Button>
        <div className="w-px h-6 bg-border mx-1" />
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              title="Text Color"
            >
              <Palette className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="flex gap-1 flex-wrap">
              {COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  className="w-6 h-6 rounded border border-border hover:scale-110 transition-transform"
                  style={{ backgroundColor: color.value }}
                  onClick={() => execCommand('foreColor', color.value)}
                  title={color.name}
                />
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 gap-1"
              title="Font Size"
            >
              <Type className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2">
            <div className="flex flex-col gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start px-3 py-1 h-auto text-sm"
                onClick={() => execCommand('fontSize', '2')}
              >
                Small
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start px-3 py-1 h-auto text-base"
                onClick={() => execCommand('fontSize', '3')}
              >
                Normal
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="justify-start px-3 py-1 h-auto text-lg"
                onClick={() => execCommand('fontSize', '4')}
              >
                Large
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
      <div
        ref={editorRef}
        contentEditable
        className="min-h-[100px] p-3 border border-input rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-ring prose prose-sm max-w-none"
        style={{ minHeight: `${rows * 24}px` }}
        onInput={handleInput}
        onPaste={handlePaste}
        data-placeholder={placeholder}
      />
      <style>{`
        [contenteditable]:empty:before {
          content: attr(data-placeholder);
          color: hsl(var(--muted-foreground));
          pointer-events: none;
        }
      `}</style>
    </div>
  );
}