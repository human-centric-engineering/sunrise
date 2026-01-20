'use client';

/**
 * Feature Flag Form Component (Phase 4.4)
 *
 * Dialog form for creating new feature flags.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AlertCircle, Save } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import type { FeatureFlag } from '@/types/prisma';

/**
 * Form validation schema
 */
const featureFlagSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .regex(
      /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/,
      'Name must be in SCREAMING_SNAKE_CASE (e.g., ENABLE_FEATURE)'
    ),
  description: z.string().max(500, 'Description must be less than 500 characters').optional(),
  enabled: z.boolean(),
});

type FeatureFlagFormData = z.infer<typeof featureFlagSchema>;

interface FeatureFlagFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (flag: FeatureFlag) => void;
}

export function FeatureFlagForm({ open, onOpenChange, onSuccess }: FeatureFlagFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    reset,
    formState: { errors },
  } = useForm<FeatureFlagFormData>({
    resolver: zodResolver(featureFlagSchema),
    defaultValues: {
      name: '',
      description: '',
      enabled: false,
    },
  });

  const currentEnabled = watch('enabled');

  const onSubmit = async (data: FeatureFlagFormData) => {
    setIsSubmitting(true);
    setError(null);

    try {
      const flag = await apiClient.post<FeatureFlag>('/api/v1/admin/feature-flags', {
        body: data,
      });

      reset();
      onSuccess(flag);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    reset();
    setError(null);
    onOpenChange(false);
  };

  /**
   * Transform name input to SCREAMING_SNAKE_CASE
   */
  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    setValue('name', value, { shouldValidate: true });
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>Create Feature Flag</DialogTitle>
          <DialogDescription>
            Create a new feature flag to control feature availability.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(e) => void handleSubmit(onSubmit)(e)}>
          <div className="grid gap-4 py-4">
            {/* Error message */}
            {error && (
              <div className="flex items-center gap-2 rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/20 dark:text-red-400">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            {/* Name field */}
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                {...register('name')}
                onChange={handleNameChange}
                placeholder="FEATURE_NAME"
                className="font-mono"
              />
              {errors.name ? (
                <p className="text-sm text-red-500">{errors.name.message}</p>
              ) : (
                <p className="text-muted-foreground text-xs">
                  Use SCREAMING_SNAKE_CASE (e.g., ENABLE_DARK_MODE)
                </p>
              )}
            </div>

            {/* Description field */}
            <div className="grid gap-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                {...register('description')}
                placeholder="Describe what this flag controls..."
                rows={3}
              />
              {errors.description && (
                <p className="text-sm text-red-500">{errors.description.message}</p>
              )}
            </div>

            {/* Enabled field */}
            <div className="flex items-center justify-between rounded-lg border p-4">
              <div className="space-y-0.5">
                <Label htmlFor="enabled">Enabled by default</Label>
                <p className="text-muted-foreground text-sm">
                  Start this flag as enabled when created
                </p>
              </div>
              <Switch
                id="enabled"
                checked={currentEnabled}
                onCheckedChange={(checked) => setValue('enabled', checked)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting}>
              <Save className="mr-2 h-4 w-4" />
              {isSubmitting ? 'Creating...' : 'Create Flag'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
