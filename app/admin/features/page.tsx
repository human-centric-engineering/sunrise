'use client';

import { useState, useEffect } from 'react';
import { FeatureFlagList } from '@/components/admin/feature-flag-list';
import { FeatureFlagForm } from '@/components/admin/feature-flag-form';
import type { FeatureFlag } from '@/types/prisma';

/**
 * Admin Feature Flags Page (Phase 4.4)
 *
 * Feature flags management with list and create form.
 */
export default function AdminFeaturesPage() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreateForm, setShowCreateForm] = useState(false);

  /**
   * API response type
   */
  interface ApiResponse {
    success: boolean;
    data: FeatureFlag[];
  }

  /**
   * Fetch flags on mount
   */
  useEffect(() => {
    const fetchFlags = async () => {
      try {
        const res = await fetch('/api/v1/admin/feature-flags', {
          credentials: 'same-origin',
        });

        if (!res.ok) {
          throw new Error('Failed to fetch flags');
        }

        const response = (await res.json()) as ApiResponse;

        if (response.success) {
          setFlags(response.data);
        }
      } catch (error) {
        console.error('Failed to fetch feature flags:', error);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchFlags();
  }, []);

  /**
   * Handle new flag creation
   */
  const handleFlagCreated = (newFlag: FeatureFlag) => {
    setFlags((prev) => [...prev, newFlag]);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="text-lg font-semibold">Feature Flags</h2>
          <p className="text-muted-foreground text-sm">
            Toggle features on or off without redeployment.
          </p>
        </div>
        <div className="flex h-48 items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Feature Flags</h2>
        <p className="text-muted-foreground text-sm">
          Toggle features on or off without redeployment.
        </p>
      </div>

      <FeatureFlagList initialFlags={flags} onCreateClick={() => setShowCreateForm(true)} />

      <FeatureFlagForm
        open={showCreateForm}
        onOpenChange={setShowCreateForm}
        onSuccess={handleFlagCreated}
      />
    </div>
  );
}
