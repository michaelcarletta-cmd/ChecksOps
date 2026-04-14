import { useRef, useCallback } from "react";

/**
 * Hook that provides cursor-aware text insertion for textareas.
 * Returns a ref to attach to the textarea and an insert function.
 */
export function useInsertAtCursor(
  value: string,
  setValue: (newValue: string) => void
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const insertAtCursor = useCallback(
    (text: string) => {
      const textarea = textareaRef.current;
      if (textarea) {
        const start = textarea.selectionStart ?? value.length;
        const end = textarea.selectionEnd ?? value.length;
        const newValue = value.slice(0, start) + text + value.slice(end);
        setValue(newValue);

        // Restore cursor position after React re-render
        requestAnimationFrame(() => {
          textarea.focus();
          const newPos = start + text.length;
          textarea.setSelectionRange(newPos, newPos);
        });
      } else {
        // Fallback: append
        setValue(value + text);
      }
    },
    [value, setValue]
  );

  return { textareaRef, insertAtCursor };
}
