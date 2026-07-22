import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class InlineErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[InlineErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}] caught:`, error, info);
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive space-y-2">
          <p className="font-semibold">
            {this.props.label ? `${this.props.label} crashed` : "This panel crashed"}
          </p>
          <pre className="whitespace-pre-wrap break-words text-[11px] opacity-90">
            {this.state.error.message}
          </pre>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            onClick={() => this.setState({ hasError: false, error: null })}
          >
            Retry
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
