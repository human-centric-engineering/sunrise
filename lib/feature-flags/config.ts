/**
 * Feature Flags Configuration (Phase 4.4)
 *
 * Default feature flags seeded into the database.
 * Add new flags here to have them automatically created on seed.
 */

/**
 * Default feature flags
 *
 * These are seeded when the application starts or when
 * running the seed command. Existing flags are not overridden.
 */
export const DEFAULT_FLAGS = [
  {
    name: 'MAINTENANCE_MODE',
    description:
      'When enabled, shows a maintenance page to all non-admin users. Admins can still access the site.',
    enabled: false,
    metadata: {
      message: 'We are currently performing scheduled maintenance. Please check back soon.',
      estimatedDowntime: null,
    },
  },
] as const;

/**
 * Feature flag names as constants for type-safe usage
 *
 * @example
 * ```typescript
 * import { FLAG_NAMES } from '@/lib/feature-flags/config';
 * import { isFeatureEnabled } from '@/lib/feature-flags';
 *
 * if (await isFeatureEnabled(FLAG_NAMES.MAINTENANCE_MODE)) {
 *   // Show maintenance page
 * }
 * ```
 */
export const FLAG_NAMES = {
  MAINTENANCE_MODE: 'MAINTENANCE_MODE',
} as const;

export type FlagName = (typeof FLAG_NAMES)[keyof typeof FLAG_NAMES];
