'use client';

/**
 * Feature Flag Form Component (Phase 4.4)
 *
 * Dialog form for creating and editing feature flags.
 */

import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import {
  SharedSettingsSaveHint,
  useSharedSettingsReadOnly,
} from '@/components/admin/shared-settings-access';
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
import { Save } from 'lucide-react';
import { SaveError } from '@/components/forms/form-error';
import { apiClient } from '@/lib/api/client';
import { API } from '@/lib/api/endpoints';
import { useSaveFailure } from '@/lib/hooks/use-save-failure';
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

/**
 * Server path → the field that shows its message. Only fields that render
 * `errors.x` are listed; every other path joins the summary by Save
 * (`.context/ui/form-errors.md`).
 */
const SERVER_FIELDS: Partial<Record<string, keyof FeatureFlagFormData>> = {
  name: 'name',
  description: 'description',
};

interface FeatureFlagFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: (flag: FeatureFlag) => void;
  /** Pass an existing flag to enable edit mode */
  flag?: FeatureFlag | null;
}

export function FeatureFlagForm({ open, onOpenChange, onSuccess, flag }: FeatureFlagFormProps) {
  const readOnly = useSharedSettingsReadOnly();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isEditMode = !!flag;

  const {
    register,
    handleSubmit,
    setError,
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

  const save = useSaveFailure({
    fallback: 'An unexpected error occurred',
    fields: SERVER_FIELDS,
    setError,
  });
  const clearSaveFailure = save.clear;

  // Populate form when editing an existing flag
  useEffect(() => {
    if (flag && open) {
      setValue('name', flag.name);
      setValue('description', flag.description || '');
      setValue('enabled', flag.enabled);
    } else if (!open) {
      // Reset form when dialog closes
      reset();
      clearSaveFailure();
    }
  }, [flag, open, setValue, reset, clearSaveFailure]);

  const currentEnabled = watch('enabled');

  const onSubmit = async (data: FeatureFlagFormData) => {
    setIsSubmitting(true);

    try {
      let savedFlag: FeatureFlag;

      if (isEditMode && flag) {
        // Edit existing flag (PATCH)
        savedFlag = await apiClient.patch<FeatureFlag>(API.ADMIN.featureFlag(flag.id), {
          body: {
            description: data.description,
            enabled: data.enabled,
          },
        });
      } else {
        // Create new flag (POST)
        savedFlag = await apiClient.post<FeatureFlag>(API.ADMIN.FEATURE_FLAGS, {
          body: data,
        });
      }

      reset();
      onSuccess(savedFlag);
      onOpenChange(false);
    } catch (err) {
      save.report(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClose = () => {
    reset();
    save.clear();
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
          <DialogTitle>{isEditMode ? 'Edit Feature Flag' : 'Create Feature Flag'}</DialogTitle>
          <DialogDescription>
            {isEditMode
              ? 'Update the feature flag settings.'
              : 'Create a new feature flag to control feature availability.'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={save.submit(handleSubmit(onSubmit))} className="space-y-4">
          <div className="grid gap-4 pt-4">
            {/* Name field */}
            <div className="grid gap-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                {...register('name')}
                onChange={isEditMode ? undefined : handleNameChange}
                placeholder="FEATURE_NAME"
                className="font-mono"
                disabled={isEditMode}
              />
              {errors.name ? (
                <p className="text-sm text-red-500">{errors.name.message}</p>
              ) : isEditMode ? (
                <p className="text-muted-foreground text-xs">Flag names cannot be changed</p>
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
                <Label htmlFor="enabled">{isEditMode ? 'Enabled' : 'Enabled by default'}</Label>
                <p className="text-muted-foreground text-sm">
                  {isEditMode
                    ? 'Toggle this flag on or off'
                    : 'Start this flag as enabled when created'}
                </p>
              </div>
              <Switch
                id="enabled"
                checked={currentEnabled}
                onCheckedChange={(checked) => setValue('enabled', checked)}
              />
            </div>
          </div>
          {/* Directly above the footer's Save. */}
          <SaveError failure={save.failure} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={handleClose}>
              Cancel
            </Button>
            <SharedSettingsSaveHint />
            <Button type="submit" disabled={readOnly || isSubmitting}>
              <Save className="mr-2 h-4 w-4" />
              {isSubmitting
                ? isEditMode
                  ? 'Saving...'
                  : 'Creating...'
                : isEditMode
                  ? 'Save Changes'
                  : 'Create Flag'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
