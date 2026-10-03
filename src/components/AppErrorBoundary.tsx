import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AppErrorBoundary caught:", error, info);
    try {
      const key = "checksops-error-boundary-reload";
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, "1");
        window.location.reload();
      }
    } catch {
      /* ignore */
    }
  }

  render() {
    if (this.state.hasError && this.state.error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center p-8 bg-background text-foreground">
          <h1 className="text-xl font-semibold text-destructive mb-2">Something went wrong</h1>
          <p className="text-muted-foreground mb-4 max-w-lg text-center">
            The app hit an error. Check the browser console (F12 → Console) for details.
          </p>
          <pre className="text-left text-sm bg-muted p-4 rounded-md overflow-auto max-w-2xl max-h-48">
            {this.state.error.message}
          </pre>
          <Button
            type="button"
            className="mt-6"
            onClick={() => window.location.reload()}
          >
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
