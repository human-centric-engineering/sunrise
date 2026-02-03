'use client';

/**
 * Profile Edit Form
 *
 * Form for editing user profile information.
 * Uses react-hook-form with Zod validation.
 *
 * Phase 3.2: User Management
 */

import { useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { updateUserSchema, type UpdateUserInput } from '@/lib/validations/user';
import { useAnalytics, EVENTS } from '@/lib/analytics';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormError } from './form-error';
import { getTimezonesByRegion, getTimezoneRegions } from '@/lib/utils/timezones';

interface ProfileFormProps {
  user: {
    name: string;
    email: string;
    bio: string | null;
    phone: string | null;
    timezone: string | null;
    location: string | null;
  };
}

export function ProfileForm({ user }: ProfileFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const { track } = useAnalytics();
  const originalValuesRef = useRef({
    name: user.name,
    bio: user.bio || '',
    phone: user.phone || '',
    timezone: user.timezone || 'UTC',
    location: user.location || '',
  });

  const {
    register,
    handleSubmit,
    setValue,
    watch,
    formState: { errors },
  } = useForm<UpdateUserInput>({
    resolver: zodResolver(updateUserSchema),
    mode: 'onTouched',
    defaultValues: {
      name: user.name,
      email: user.email,
      bio: user.bio || '',
      phone: user.phone || '',
      timezone: user.timezone || 'UTC',
      location: user.location || '',
    },
  });

  const currentTimezone = watch('timezone');

  const onSubmit = async (data: UpdateUserInput) => {
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(false);

      // Clean up empty strings to null for optional fields
      const cleanData = {
        ...data,
        bio: data.bio?.trim() || null,
        phone: data.phone?.trim() || null,
        location: data.location?.trim() || null,
      };

      await apiClient.patch('/api/v1/users/me', { body: cleanData });

      // Determine which fields changed
      const fieldsChanged: string[] = [];
      const original = originalValuesRef.current;
      if (data.name !== original.name) fieldsChanged.push('name');
      if ((data.bio?.trim() || '') !== original.bio) fieldsChanged.push('bio');
      if ((data.phone?.trim() || '') !== original.phone) fieldsChanged.push('phone');
      if (data.timezone !== original.timezone) fieldsChanged.push('timezone');
      if ((data.location?.trim() || '') !== original.location) fieldsChanged.push('location');

      if (fieldsChanged.length > 0) {
        void track(EVENTS.PROFILE_UPDATED, { fields_changed: fieldsChanged });
        // Update original values for next comparison
        originalValuesRef.current = {
          name: data.name ?? original.name,
          bio: data.bio?.trim() || '',
          phone: data.phone?.trim() || '',
          timezone: data.timezone ?? 'UTC',
          location: data.location?.trim() || '',
        };
      }

      setSuccess(true);
      router.refresh();

      // Reset success after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to update profile');
      } else {
        setError('An unexpected error occurred');
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-6">
      {/* Name */}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input id="name" placeholder="Your name" disabled={isLoading} {...register('name')} />
        <FormError message={errors.name?.message} />
      </div>

      {/* Email (read-only for now - email change requires verification) */}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="your@email.com"
          disabled={true}
          {...register('email')}
        />
        <p className="text-muted-foreground text-xs">
          Email changes require verification and are not yet supported.
        </p>
      </div>

      {/* Bio */}
      <div className="space-y-2">
        <Label htmlFor="bio">Bio</Label>
        <Textarea
          id="bio"
          placeholder="Tell us about yourself..."
          disabled={isLoading}
          rows={4}
          {...register('bio')}
        />
        <FormError message={errors.bio?.message} />
        <p className="text-muted-foreground text-xs">
          Brief description for your profile. Max 500 characters.
        </p>
      </div>

      {/* Phone */}
      <div className="space-y-2">
        <Label htmlFor="phone">Phone</Label>
        <Input
          id="phone"
          type="tel"
          placeholder="+1 (555) 123-4567"
          disabled={isLoading}
          {...register('phone')}
        />
        <FormError message={errors.phone?.message} />
      </div>

      {/* Timezone */}
      <div className="space-y-2">
        <Label htmlFor="timezone">Timezone</Label>
        <Select
          value={currentTimezone || 'UTC'}
          onValueChange={(value) => setValue('timezone', value)}
          disabled={isLoading}
        >
          <SelectTrigger id="timezone">
            <SelectValue placeholder="Select timezone" />
          </SelectTrigger>
          <SelectContent className="max-h-[300px]">
            {getTimezoneRegions().map((region) => {
              const timezones = getTimezonesByRegion()[region];
              if (!timezones) return null;
              return (
                <SelectGroup key={region}>
                  <SelectLabel>{region}</SelectLabel>
                  {timezones.map((tz) => (
                    <SelectItem key={tz.value} value={tz.value}>
                      {tz.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              );
            })}
          </SelectContent>
        </Select>
        <FormError message={errors.timezone?.message} />
      </div>

      {/* Location */}
      <div className="space-y-2">
        <Label htmlFor="location">Location</Label>
        <Input
          id="location"
          placeholder="City, Country"
          disabled={isLoading}
          {...register('location')}
        />
        <FormError message={errors.location?.message} />
      </div>

      {/* Error message */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">{error}</div>
      )}

      {/* Success message */}
      {success && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          Profile updated successfully
        </div>
      )}

      {/* Submit button */}
      <Button type="submit" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Saving...
          </>
        ) : (
          'Save Changes'
        )}
      </Button>
    </form>
  );
}
