'use client';

import { useState, useEffect } from 'react';
import { FeatureFlagList } from '@/components/admin/feature-flag-list';
import { FeatureFlagForm } from '@/components/admin/feature-flag-form';
import type { FeatureFlag } from '@/types/prisma';

/**
 * API response type
 */
interface ApiResponse {
  success: boolean;
  data: FeatureFlag[];
}

/**
 * Feature Flags Page Content (Client Component)
 *
 * Feature flags management with list and create form.
 */
export function FeatureFlagsPage() {
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingFlag, setEditingFlag] = useState<FeatureFlag | null>(null);

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
      } catch {
        // Error is silently caught — Batch 6 will add proper error state UI
      } finally {
        setIsLoading(false);
      }
    };

    void fetchFlags();
  }, []);

  /**
   * Handle flag create/update
   */
  const handleFlagSaved = (savedFlag: FeatureFlag) => {
    if (editingFlag) {
      // Update existing flag
      setFlags((prev) => prev.map((f) => (f.id === savedFlag.id ? savedFlag : f)));
    } else {
      // Add new flag
      setFlags((prev) => [...prev, savedFlag]);
    }
    setEditingFlag(null);
  };

  /**
   * Open create form
   */
  const handleCreateClick = () => {
    setEditingFlag(null);
    setShowForm(true);
  };

  /**
   * Open edit form
   */
  const handleEditClick = (flag: FeatureFlag) => {
    setEditingFlag(flag);
    setShowForm(true);
  };

  /**
   * Close form
   */
  const handleFormClose = (open: boolean) => {
    setShowForm(open);
    if (!open) {
      setEditingFlag(null);
    }
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

      <FeatureFlagList
        initialFlags={flags}
        onCreateClick={handleCreateClick}
        onEditClick={handleEditClick}
      />

      <FeatureFlagForm
        open={showForm}
        onOpenChange={handleFormClose}
        onSuccess={handleFlagSaved}
        flag={editingFlag}
      />
    </div>
  );
}
