'use client';

/**
 * Error Handling Provider
 *
 * Initializes global error handling and error tracking on application startup.
 * This component should wrap the entire application in the root layout.
 *
 * Features:
 * - Initializes global error handler (catches unhandled errors/rejections)
 * - Initializes error tracking (Sentry or no-op mode)
 * - Runs only in browser (client-side)
 * - Runs only once per session
 *
 * @example
 * ```typescript
 * // In app/layout.tsx:
 * import { ErrorHandlingProvider } from './error-handling-provider';
 *
 * export default function RootLayout({ children }) {
 *   return (
 *     <html>
 *       <body>
 *         <ErrorHandlingProvider>
 *           {children}
 *         </ErrorHandlingProvider>
 *       </body>
 *     </html>
 *   );
 * }
 * ```
 */

import { useEffect, type ReactNode } from 'react';
import { initGlobalErrorHandler } from '@/lib/errors/handler';
import { initErrorTracking } from '@/lib/errors/sentry';

interface ErrorHandlingProviderProps {
  children: ReactNode;
}

export function ErrorHandlingProvider({ children }: ErrorHandlingProviderProps) {
  useEffect(() => {
    // Initialize global error handler
    // This catches unhandled promise rejections and runtime errors
    initGlobalErrorHandler();

    // Initialize error tracking
    // This sets up Sentry (if configured) or no-op mode
    initErrorTracking();
  }, []); // Run only once on mount

  return <>{children}</>;
}
