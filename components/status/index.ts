/**
 * Status Page Components
 *
 * Components for displaying system health and status information.
 *
 * @example
 * ```tsx
 * import { StatusPage, StatusIndicator, ServiceStatusCard } from '@/components/status';
 *
 * // Full status page - polls /api/health every 30 seconds
 * <StatusPage />
 *
 * // Individual components
 * <StatusIndicator status="operational" showLabel />
 * <ServiceStatusCard name="Database" health={dbHealth} />
 * ```
 */

// Components
export { StatusIndicator, getStatusConfig } from './status-indicator';
export type { StatusIndicatorProps } from './status-indicator';

export { ServiceStatusCard } from './service-status-card';
export type { ServiceStatusCardProps } from './service-status-card';

export { StatusPage } from './status-page';
export type { StatusPageProps } from './status-page';

// Hook
export { useHealthCheck } from './use-health-check';
export type {
  HealthCheckState,
  UseHealthCheckOptions,
  UseHealthCheckReturn,
} from './use-health-check';
