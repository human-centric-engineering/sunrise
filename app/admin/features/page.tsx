import type { Metadata } from 'next';
import { FeatureFlagsPage } from '@/components/admin/feature-flags-page';

export const metadata: Metadata = {
  title: 'Feature Flags',
  description: 'Toggle features on or off without redeployment',
};

/**
 * Admin Feature Flags Page (Phase 4.4)
 *
 * Feature flags management with list and create form.
 */
export default function AdminFeaturesRoute() {
  return <FeatureFlagsPage />;
}
