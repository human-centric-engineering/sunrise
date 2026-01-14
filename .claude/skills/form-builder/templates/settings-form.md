# Settings Form Template

Use this template for settings pages with toggles, selects, and mixed input types.

## Zod Schema Template

**File:** `lib/validations/settings.ts`

```typescript
import { z } from 'zod';

export const settingsSchema = z.object({
  // Boolean toggles
  emailNotifications: z.boolean(),
  marketingEmails: z.boolean(),
  weeklyDigest: z.boolean(),

  // Select/enum field
  theme: z.enum(['light', 'dark', 'system']),
  timezone: z.string().min(1, 'Timezone is required'),
  language: z.string().min(1, 'Language is required'),

  // Optional text field
  displayName: z
    .string()
    .max(50, 'Display name must be less than 50 characters')
    .optional()
    .or(z.literal('')),
});

export type SettingsInput = z.infer<typeof settingsSchema>;

// Default values for new users
export const defaultSettings: SettingsInput = {
  emailNotifications: true,
  marketingEmails: false,
  weeklyDigest: true,
  theme: 'system',
  timezone: 'UTC',
  language: 'en',
  displayName: '',
};
```

## Form Component Template

**File:** `components/forms/settings-form.tsx`

```typescript
'use client';

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { apiClient, APIClientError } from '@/lib/api/client';
import {
  settingsSchema,
  type SettingsInput,
  defaultSettings,
} from '@/lib/validations/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { FormError } from './form-error';
import { Loader2, CheckCircle2 } from 'lucide-react';

interface SettingsFormProps {
  initialValues?: Partial<SettingsInput>;
}

export function SettingsForm({ initialValues }: SettingsFormProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isDirty },
  } = useForm<SettingsInput>({
    resolver: zodResolver(settingsSchema),
    mode: 'onTouched',
    defaultValues: {
      ...defaultSettings,
      ...initialValues,
    },
  });

  const onSubmit = async (data: SettingsInput) => {
    try {
      setIsLoading(true);
      setError(null);
      setSuccess(false);

      await apiClient.patch('/api/v1/users/me/settings', { body: data });

      setSuccess(true);
      setIsLoading(false);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setIsLoading(false);
      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to save settings');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-8">
      {/* Notification Settings Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Notifications</h3>
        <p className="text-muted-foreground text-sm">
          Manage how you receive notifications and updates.
        </p>

        {/* Email Notifications Toggle */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="emailNotifications" className="text-base">
              Email Notifications
            </Label>
            <p className="text-muted-foreground text-sm">
              Receive email notifications about your account activity.
            </p>
          </div>
          <Controller
            name="emailNotifications"
            control={control}
            render={({ field }) => (
              <Switch
                id="emailNotifications"
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={isLoading}
              />
            )}
          />
        </div>

        {/* Marketing Emails Toggle */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="marketingEmails" className="text-base">
              Marketing Emails
            </Label>
            <p className="text-muted-foreground text-sm">
              Receive emails about new features and promotions.
            </p>
          </div>
          <Controller
            name="marketingEmails"
            control={control}
            render={({ field }) => (
              <Switch
                id="marketingEmails"
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={isLoading}
              />
            )}
          />
        </div>

        {/* Weekly Digest Toggle */}
        <div className="flex items-center justify-between rounded-lg border p-4">
          <div className="space-y-0.5">
            <Label htmlFor="weeklyDigest" className="text-base">
              Weekly Digest
            </Label>
            <p className="text-muted-foreground text-sm">
              Get a weekly summary of your activity.
            </p>
          </div>
          <Controller
            name="weeklyDigest"
            control={control}
            render={({ field }) => (
              <Switch
                id="weeklyDigest"
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={isLoading}
              />
            )}
          />
        </div>
      </div>

      {/* Appearance Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Appearance</h3>
        <p className="text-muted-foreground text-sm">
          Customize how the application looks for you.
        </p>

        {/* Theme Select */}
        <div className="space-y-2">
          <Label htmlFor="theme">Theme</Label>
          <Controller
            name="theme"
            control={control}
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isLoading}
              >
                <SelectTrigger id="theme">
                  <SelectValue placeholder="Select theme" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                  <SelectItem value="system">System</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <FormError message={errors.theme?.message} />
        </div>
      </div>

      {/* Localization Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Localization</h3>
        <p className="text-muted-foreground text-sm">
          Set your language and timezone preferences.
        </p>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Language Select */}
          <div className="space-y-2">
            <Label htmlFor="language">Language</Label>
            <Controller
              name="language"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isLoading}
                >
                  <SelectTrigger id="language">
                    <SelectValue placeholder="Select language" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="en">English</SelectItem>
                    <SelectItem value="es">Spanish</SelectItem>
                    <SelectItem value="fr">French</SelectItem>
                    <SelectItem value="de">German</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            <FormError message={errors.language?.message} />
          </div>

          {/* Timezone Select */}
          <div className="space-y-2">
            <Label htmlFor="timezone">Timezone</Label>
            <Controller
              name="timezone"
              control={control}
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  disabled={isLoading}
                >
                  <SelectTrigger id="timezone">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="UTC">UTC</SelectItem>
                    <SelectItem value="America/New_York">Eastern Time</SelectItem>
                    <SelectItem value="America/Chicago">Central Time</SelectItem>
                    <SelectItem value="America/Denver">Mountain Time</SelectItem>
                    <SelectItem value="America/Los_Angeles">Pacific Time</SelectItem>
                    <SelectItem value="Europe/London">London</SelectItem>
                    <SelectItem value="Europe/Paris">Paris</SelectItem>
                    <SelectItem value="Asia/Tokyo">Tokyo</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
            <FormError message={errors.timezone?.message} />
          </div>
        </div>
      </div>

      {/* Profile Section */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium">Profile</h3>
        <p className="text-muted-foreground text-sm">
          Customize your public profile information.
        </p>

        {/* Display Name Input */}
        <div className="space-y-2">
          <Label htmlFor="displayName">Display Name</Label>
          <Input
            id="displayName"
            placeholder="How you appear to others"
            disabled={isLoading}
            {...register('displayName')}
          />
          <FormError message={errors.displayName?.message} />
          <p className="text-muted-foreground text-xs">
            Leave blank to use your account name.
          </p>
        </div>
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
          {error}
        </div>
      )}

      {/* Success Display */}
      {success && (
        <div className="flex items-center gap-2 rounded-md bg-green-50 p-3 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
          <CheckCircle2 className="h-4 w-4" />
          Settings saved successfully!
        </div>
      )}

      {/* Submit Button */}
      <div className="flex justify-end">
        <Button type="submit" disabled={isLoading || !isDirty}>
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            'Save Changes'
          )}
        </Button>
      </div>
    </form>
  );
}
```

## Key Patterns

### Using Controller for Non-Native Inputs

shadcn/ui components like `Switch` and `Select` need `Controller`:

```typescript
import { Controller } from 'react-hook-form';

<Controller
  name="fieldName"
  control={control}
  render={({ field }) => (
    <Switch
      checked={field.value}
      onCheckedChange={field.onChange}
      disabled={isLoading}
    />
  )}
/>
```

### Tracking Dirty State

Disable save button when nothing changed:

```typescript
const { formState: { isDirty } } = useForm(...);

<Button disabled={isLoading || !isDirty}>Save Changes</Button>
```

### Inline Success Message

For settings, show success inline instead of redirecting:

```typescript
setSuccess(true);
setTimeout(() => setSuccess(false), 3000);
```

## Usage

```tsx
// In settings page
import { SettingsForm } from '@/components/forms/settings-form';

export default async function SettingsPage() {
  const settings = await getUserSettings(); // Server-side fetch

  return (
    <div className="max-w-2xl">
      <h1 className="mb-6 text-2xl font-bold">Settings</h1>
      <SettingsForm initialValues={settings} />
    </div>
  );
}
```
