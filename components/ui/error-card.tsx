'use client';

/**
 * Shared Error Card
 *
 * Reusable error UI for error boundaries across route groups.
 * Provides consistent styling with configurable title, description,
 * action buttons, and dev-only error details.
 */

import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';

export interface ErrorCardAction {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'outline';
  icon?: ReactNode;
}

export interface ErrorCardProps {
  /** Card title */
  title: string;
  /** Card description */
  description: string;
  /** Icon displayed next to the title (defaults to AlertTriangle) */
  icon?: ReactNode;
  /** Icon color class (defaults to "text-red-500") */
  iconClassName?: string;
  /** Error object for dev-only details */
  error?: Error & { digest?: string };
  /** Action buttons */
  actions?: ErrorCardAction[];
  /** Optional footer content (e.g., support link) */
  footer?: ReactNode;
  /** Container min-height class (defaults to "min-h-[400px]") */
  containerClassName?: string;
}

export function ErrorCard({
  title,
  description,
  icon,
  iconClassName = 'text-red-500',
  error,
  actions,
  footer,
  containerClassName = 'min-h-[400px]',
}: ErrorCardProps): React.ReactElement {
  return (
    <div className={`flex items-center justify-center p-4 ${containerClassName}`}>
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className={iconClassName}>{icon ?? <AlertTriangle className="h-5 w-5" />}</span>
            <CardTitle>{title}</CardTitle>
          </div>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Dev-only error details */}
          {error && process.env.NODE_ENV === 'development' && (
            <div className="space-y-2">
              <div className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950/50 dark:text-red-400">
                <p className="font-semibold">Error:</p>
                <p className="font-mono">{error.message}</p>
              </div>
              {error.digest && (
                <div className="rounded-md bg-gray-100 p-3 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                  <p className="font-semibold">Error Digest:</p>
                  <p className="font-mono">{error.digest}</p>
                </div>
              )}
            </div>
          )}

          {/* Action buttons */}
          {actions && actions.length > 0 && (
            <div className="flex gap-2">
              {actions.map((action) => (
                <Button
                  key={action.label}
                  onClick={action.onClick}
                  variant={action.variant ?? 'default'}
                  className="flex-1"
                >
                  {action.icon}
                  {action.label}
                </Button>
              ))}
            </div>
          )}

          {footer}
        </CardContent>
      </Card>
    </div>
  );
}
