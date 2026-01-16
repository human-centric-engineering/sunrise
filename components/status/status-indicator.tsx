'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';
import type { ServiceStatus } from '@/lib/monitoring';

/**
 * Props for StatusIndicator component
 */
export interface StatusIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  /** The status to display */
  status: ServiceStatus | 'unknown';
  /** Size variant */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show a label */
  showLabel?: boolean;
  /** Whether to animate the indicator (pulse effect for operational) */
  animate?: boolean;
}

/**
 * Status indicator colors and labels
 */
const statusConfig = {
  operational: {
    color: 'bg-green-500',
    label: 'Operational',
    description: 'All systems working normally',
  },
  degraded: {
    color: 'bg-yellow-500',
    label: 'Degraded',
    description: 'System experiencing issues',
  },
  outage: {
    color: 'bg-red-500',
    label: 'Outage',
    description: 'System unavailable',
  },
  unknown: {
    color: 'bg-gray-400',
    label: 'Unknown',
    description: 'Status unknown',
  },
} as const;

/**
 * Size configurations
 */
const sizeConfig = {
  sm: {
    dot: 'h-2 w-2',
    text: 'text-xs',
    gap: 'gap-1.5',
  },
  md: {
    dot: 'h-3 w-3',
    text: 'text-sm',
    gap: 'gap-2',
  },
  lg: {
    dot: 'h-4 w-4',
    text: 'text-base',
    gap: 'gap-2.5',
  },
} as const;

/**
 * StatusIndicator Component
 *
 * Displays a colored dot/badge indicating service status.
 * Supports operational (green), degraded (yellow), outage (red), and unknown (gray) states.
 *
 * @example
 * ```tsx
 * // Basic usage
 * <StatusIndicator status="operational" />
 *
 * // With label
 * <StatusIndicator status="degraded" showLabel />
 *
 * // Large size with animation
 * <StatusIndicator status="operational" size="lg" animate />
 * ```
 */
export function StatusIndicator({
  status,
  size = 'md',
  showLabel = false,
  animate = false,
  className,
  ...props
}: StatusIndicatorProps) {
  const config = statusConfig[status];
  const sizes = sizeConfig[size];

  return (
    <div
      className={cn('inline-flex items-center', sizes.gap, className)}
      role="status"
      aria-label={`Status: ${config.label}`}
      {...props}
    >
      <span
        className={cn(
          'rounded-full',
          sizes.dot,
          config.color,
          animate && status === 'operational' && 'animate-pulse'
        )}
        aria-hidden="true"
      />
      {showLabel && (
        <span className={cn('font-medium', sizes.text, 'text-foreground')}>{config.label}</span>
      )}
    </div>
  );
}

/**
 * Get status configuration for external use
 */
export function getStatusConfig(status: ServiceStatus | 'unknown') {
  return statusConfig[status];
}
