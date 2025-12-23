'use client';

/**
 * Reusable Error Boundary Component
 *
 * React error boundary that catches JavaScript errors anywhere in child component tree.
 * Features:
 * - Customizable fallback UI (component or render function)
 * - Error callback hook for logging/tracking
 * - Reset keys for automatic recovery
 * - Automatic error logging with context
 *
 * Error boundaries catch errors during:
 * - Rendering
 * - Lifecycle methods
 * - Constructors
 *
 * Error boundaries DO NOT catch errors in:
 * - Event handlers (use try/catch)
 * - Async code (use handleClientError)
 * - Server-side rendering
 * - Errors thrown in the error boundary itself
 *
 * @see https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary
 *
 * @example
 * ```tsx
 * // Basic usage with default fallback
 * <ErrorBoundary>
 *   <MyComponent />
 * </ErrorBoundary>
 *
 * // Custom fallback UI
 * <ErrorBoundary
 *   fallback={(error, reset) => (
 *     <div>
 *       <h2>Oops! {error.message}</h2>
 *       <button onClick={reset}>Try again</button>
 *     </div>
 *   )}
 * >
 *   <MyComponent />
 * </ErrorBoundary>
 *
 * // With reset keys (auto-reset when userId changes)
 * <ErrorBoundary resetKeys={[userId]}>
 *   <UserProfile userId={userId} />
 * </ErrorBoundary>
 *
 * // With error callback
 * <ErrorBoundary
 *   onError={(error, errorInfo) => {
 *     trackError(error, {
 *       component: errorInfo.componentStack
 *     });
 *   }}
 * >
 *   <MyComponent />
 * </ErrorBoundary>
 * ```
 */

import { Component, type ReactNode, type ErrorInfo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { logger } from '@/lib/logging';

interface ErrorBoundaryProps {
  /** Child components to render */
  children: ReactNode;
  /**
   * Fallback UI to show when an error occurs
   * Can be a React element or a render function
   */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /**
   * Callback fired when an error is caught
   * Use this for logging or error tracking
   */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /**
   * Keys that trigger a reset when they change
   * Useful for re-fetching data or resetting component state
   */
  resetKeys?: unknown[];
  /**
   * Name of this error boundary for logging
   * Helps identify which boundary caught the error
   */
  errorBoundaryName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * Error Boundary Component
 *
 * Class component that implements React error boundary lifecycle methods
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  /**
   * Update state when an error is caught
   * This is called during the "render" phase, so side effects are not allowed
   */
  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      error,
      errorInfo: null,
    };
  }

  /**
   * Log error details after error is caught
   * This is called during the "commit" phase, so side effects are allowed
   */
  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    const { onError, errorBoundaryName } = this.props;

    // Log error with structured logger
    logger.error('Error caught by boundary', error, {
      boundaryName: errorBoundaryName || 'ErrorBoundary',
      componentStack: errorInfo.componentStack,
      errorType: 'boundary',
    });

    // Update state with error info
    this.setState({ errorInfo });

    // Call custom error handler if provided
    if (onError) {
      onError(error, errorInfo);
    }
  }

  /**
   * Check if reset keys have changed and reset error boundary if they have
   * This allows automatic recovery when props change (e.g., user navigates to new page)
   */
  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    const { resetKeys } = this.props;
    const { hasError } = this.state;

    if (hasError && resetKeys) {
      // Check if any reset key has changed
      const hasResetKeyChanged = resetKeys.some((key, index) => {
        return key !== prevProps.resetKeys?.[index];
      });

      if (hasResetKeyChanged) {
        this.reset();
      }
    }
  }

  /**
   * Reset error boundary to initial state
   * Allows users to try again after an error
   */
  reset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    const { hasError, error } = this.state;
    const { children, fallback } = this.props;

    if (hasError && error) {
      // Render custom fallback if provided
      if (fallback) {
        if (typeof fallback === 'function') {
          return fallback(error, this.reset);
        }
        return fallback;
      }

      // Render default fallback UI
      return <DefaultErrorFallback error={error} reset={this.reset} />;
    }

    // No error, render children normally
    return children;
  }
}

/**
 * Default Error Fallback Component
 *
 * Displays a user-friendly error message with a retry button
 * Used when no custom fallback is provided to ErrorBoundary
 */
function DefaultErrorFallback({ error, reset }: { error: Error; reset: () => void }): ReactNode {
  return (
    <div className="flex min-h-[400px] items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-red-500" />
            <CardTitle>Something went wrong</CardTitle>
          </div>
          <CardDescription>
            An unexpected error occurred. This has been logged and we&apos;ll look into it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Show error message in development only */}
          {process.env.NODE_ENV === 'development' && (
            <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-400">
              <p className="font-mono">{error.message}</p>
            </div>
          )}

          <Button onClick={reset} className="w-full">
            Try again
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
