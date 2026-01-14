# Simple Form Template

Use this template for basic forms with text inputs, no OAuth, no complex state.

## Zod Schema Template

**File:** `lib/validations/[domain].ts`

```typescript
import { z } from 'zod';

export const simpleFormSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name must be less than 100 characters')
    .trim(),
  email: z
    .string()
    .min(1, 'Email is required')
    .email('Invalid email address')
    .max(255)
    .toLowerCase()
    .trim(),
  message: z
    .string()
    .min(1, 'Message is required')
    .max(1000, 'Message must be less than 1000 characters')
    .trim(),
});

export type SimpleFormInput = z.infer<typeof simpleFormSchema>;
```

## Form Component Template

**File:** `components/forms/[name]-form.tsx`

```typescript
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { simpleFormSchema, type SimpleFormInput } from '@/lib/validations/domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { FormError } from './form-error';
import { Loader2, CheckCircle2 } from 'lucide-react';

interface SimpleFormProps {
  onSuccess?: () => void;
  redirectTo?: string;
}

export function SimpleForm({ onSuccess, redirectTo }: SimpleFormProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SimpleFormInput>({
    resolver: zodResolver(simpleFormSchema),
    mode: 'onTouched',
    defaultValues: {
      name: '',
      email: '',
      message: '',
    },
  });

  const onSubmit = async (data: SimpleFormInput) => {
    try {
      setIsLoading(true);
      setError(null);

      await apiClient.post('/api/v1/endpoint', { body: data });

      setSuccess(true);
      onSuccess?.();

      if (redirectTo) {
        setTimeout(() => {
          router.push(redirectTo);
          router.refresh();
        }, 1500);
      }
    } catch (err) {
      setIsLoading(false);
      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to submit form');
      } else {
        setError('An unexpected error occurred. Please try again.');
      }
    }
  };

  if (success) {
    return (
      <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-4 w-4" />
          <p className="font-medium">Success!</p>
        </div>
        {redirectTo && <p className="mt-1 text-xs">Redirecting...</p>}
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
      {/* Name Field */}
      <div className="space-y-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          type="text"
          placeholder="Your name"
          disabled={isLoading}
          {...register('name')}
        />
        <FormError message={errors.name?.message} />
      </div>

      {/* Email Field */}
      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          disabled={isLoading}
          {...register('email')}
        />
        <FormError message={errors.email?.message} />
      </div>

      {/* Message Field (Textarea) */}
      <div className="space-y-2">
        <Label htmlFor="message">Message</Label>
        <Textarea
          id="message"
          placeholder="Your message..."
          rows={4}
          disabled={isLoading}
          {...register('message')}
        />
        <FormError message={errors.message?.message} />
      </div>

      {/* Error Display */}
      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
          {error}
        </div>
      )}

      {/* Submit Button */}
      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            Submitting...
          </>
        ) : (
          'Submit'
        )}
      </Button>
    </form>
  );
}
```

## Usage

```tsx
// In a page component
import { SimpleForm } from '@/components/forms/simple-form';

export default function ContactPage() {
  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-2xl font-bold">Contact Us</h1>
      <SimpleForm redirectTo="/thank-you" />
    </div>
  );
}
```

## Customization Points

1. **Add/remove fields:** Update schema and form JSX
2. **Change validation:** Modify Zod schema rules
3. **Change success behavior:** Modify onSuccess callback or redirectTo
4. **Style changes:** Modify Tailwind classes
5. **Add field descriptions:** Add `<p className="text-muted-foreground text-sm">` after Label
