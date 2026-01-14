---
name: form-builder
version: 1.0.0
description: |
  Expert form builder for Sunrise. Creates validated forms using Zod + react-hook-form + shadcn/ui
  following established patterns: schema validation, API integration, loading states, error handling,
  and accessibility. Use when creating new forms or modifying existing ones.

triggers:
  - 'create form'
  - 'build a form'
  - 'add form for'
  - 'create profile form'
  - 'create settings form'
  - 'add form validation'

contexts:
  - 'components/forms/**/*'
  - 'lib/validations/**/*'
  - 'lib/api/client.ts'
  - '.context/api/client.md'

mcp_integrations:
  next_devtools: true
  context7:
    libraries:
      - zod: TBC # For validation patterns
      - react-hook-form: TBC # For form handling
      - { shadcn: '/websites/ui_shadcn' } # For UI components

parameters:
  validation_mode: 'onTouched' # Validate on blur for better UX
  api_client: 'apiClient' # Use apiClient for API calls
  auth_client: 'authClient' # Use authClient for auth flows only
---

# Form Builder Skill - Overview

## Mission

You are a form builder for the Sunrise project. Your role is to create production-ready forms using **react-hook-form**, **Zod** validation, and **shadcn/ui** components following established patterns for validation, error handling, loading states, and accessibility.

**CRITICAL:** Forms in Sunrise follow specific patterns. Always reference existing forms in `components/forms/` before creating new ones.

## Core Patterns

### Form Component Structure

```typescript
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { apiClient, APIClientError } from '@/lib/api/client';
import { yourSchema, type YourInput } from '@/lib/validations/your-domain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormError } from './form-error';

export function YourForm() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<YourInput>({
    resolver: zodResolver(yourSchema),
    mode: 'onTouched',
    defaultValues: {
      // ALL fields must have defaults
    },
  });

  const onSubmit = async (data: YourInput) => {
    try {
      setIsLoading(true);
      setError(null);

      await apiClient.post('/api/v1/endpoint', { body: data });

      router.push('/destination');
      router.refresh();
    } catch (err) {
      setIsLoading(false);
      if (err instanceof APIClientError) {
        setError(err.message || 'Failed to submit');
      } else {
        setError('An unexpected error occurred');
      }
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(onSubmit)(e)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="field">Field Label</Label>
        <Input id="field" disabled={isLoading} {...register('field')} />
        <FormError message={errors.field?.message} />
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md p-3 text-sm">
          {error}
        </div>
      )}

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? 'Loading...' : 'Submit'}
      </Button>
    </form>
  );
}
```

### State Management

Forms maintain these state variables:

```typescript
const [isLoading, setIsLoading] = useState(false); // Request in progress
const [error, setError] = useState<string | null>(null); // General form error
const [success, setSuccess] = useState(false); // Success state (optional)
```

### Validation Schema Pattern

```typescript
// lib/validations/[domain].ts
import { z } from 'zod';

export const yourSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
  // ... more fields
});

// Always export the inferred type
export type YourInput = z.infer<typeof yourSchema>;
```

## 5-Step Workflow

### Step 1: Analyze Requirements

**Gather information:**

- Form purpose (create, edit, settings, auth)
- Fields needed with types
- Validation rules for each field
- API endpoint to submit to
- Success behavior (redirect, message, state change)
- Special features (password strength, OAuth integration, etc.)

**Determine form type:**

- **Simple:** Basic fields, single submit
- **Medium:** Multiple field types, conditional logic
- **Complex:** Multi-step, OAuth integration, file uploads

### Step 2: Create Zod Schema

**File:** `lib/validations/[domain].ts`

**Reuse existing schemas where possible:**

```typescript
// Import reusable schemas
import { emailSchema, passwordSchema } from './auth';
import { nameSchema } from './common';

export const profileSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  bio: z.string().max(500, 'Bio must be less than 500 characters').optional(),
});

export type ProfileInput = z.infer<typeof profileSchema>;
```

**Use Context7 for Zod patterns:**

```typescript
mcp__context7__get_library_docs({
  context7CompatibleLibraryID: '/colinhacks/zod',
  topic: 'validation transform refine',
  mode: 'code',
});
```

### Step 3: Build Form Component

**File:** `components/forms/[name]-form.tsx`

**Required imports:**

```typescript
'use client';

// Form libraries
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

// Next.js hooks
import { useRouter, useSearchParams } from 'next/navigation';

// React hooks
import { useState, useEffect } from 'react';

// API client (for non-auth forms)
import { apiClient, APIClientError } from '@/lib/api/client';

// Auth client (for auth forms only)
import { authClient } from '@/lib/auth/client';

// Validation schema
import { yourSchema, type YourInput } from '@/lib/validations/your-domain';

// UI Components
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FormError } from './form-error';

// Icons (for feedback)
import { Loader2, CheckCircle2, AlertCircle } from 'lucide-react';
```

**Form setup:**

```typescript
const {
  register,
  handleSubmit,
  watch,
  setValue,
  formState: { errors },
} = useForm<YourInput>({
  resolver: zodResolver(yourSchema),
  mode: 'onTouched', // Always use onTouched for better UX
  defaultValues: {
    // ALL fields MUST have defaults
    name: '',
    email: '',
  },
});
```

### Step 4: Implement Features

**Field rendering pattern:**

```typescript
<div className="space-y-2">
  <Label htmlFor="fieldId">Field Label</Label>
  <Input
    id="fieldId"
    type="text"
    placeholder="Placeholder text"
    disabled={isLoading}
    {...register('fieldName')}
  />
  <FormError message={errors.fieldName?.message} />
</div>
```

**Password field with strength meter:**

```typescript
import { PasswordInput } from '@/components/ui/password-input';
import { PasswordStrength } from './password-strength';

const password = watch('password'); // Watch for strength meter

<div className="space-y-2">
  <Label htmlFor="password">Password</Label>
  <PasswordInput
    id="password"
    disabled={isLoading}
    {...register('password')}
  />
  <FormError message={errors.password?.message} />
  <PasswordStrength password={password} />
</div>
```

**Submit button with loading:**

```typescript
<Button type="submit" className="w-full" disabled={isLoading || success}>
  {isLoading ? (
    <>
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Submitting...
    </>
  ) : (
    'Submit'
  )}
</Button>
```

**Success state replacement:**

```typescript
if (success) {
  return (
    <div className="rounded-md bg-green-50 p-4 text-sm text-green-900 dark:bg-green-950/50 dark:text-green-300">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4" />
        <p className="font-medium">Success!</p>
      </div>
      <p className="mt-1 text-xs">Redirecting...</p>
    </div>
  );
}
```

### Step 5: Verify Implementation

**Checklist:**

- [ ] Form component created with `'use client'` directive
- [ ] Zod schema created with type export
- [ ] All form fields have default values
- [ ] `mode: 'onTouched'` set on useForm
- [ ] Loading state disables all inputs and button
- [ ] Error state displayed to user
- [ ] Success handling (redirect or message)
- [ ] FormError component used for field errors
- [ ] Accessible: Labels linked to inputs with `htmlFor`
- [ ] Run `npm run validate` - all checks pass

## API Client Usage

**For non-auth forms, use apiClient:**

```typescript
import { apiClient, APIClientError } from '@/lib/api/client';

// GET
const data = await apiClient.get<ResponseType>('/api/v1/endpoint');

// POST
const result = await apiClient.post<ResponseType>('/api/v1/endpoint', {
  body: formData,
});

// PATCH
const updated = await apiClient.patch<ResponseType>('/api/v1/endpoint', {
  body: updateData,
});

// DELETE
await apiClient.delete('/api/v1/endpoint');
```

**Error handling:**

```typescript
try {
  await apiClient.post('/api/v1/endpoint', { body: data });
} catch (err) {
  if (err instanceof APIClientError) {
    setError(err.message);

    // Handle validation errors
    if (err.code === 'VALIDATION_ERROR' && err.details) {
      // err.details contains field-specific errors
    }
  }
}
```

## Auth Client Usage

**For authentication forms ONLY, use authClient:**

```typescript
import { authClient } from '@/lib/auth/client';

// Sign in
await authClient.signIn.email(
  { email: data.email, password: data.password },
  {
    onRequest: () => setIsLoading(true),
    onSuccess: () => {
      router.push('/dashboard');
      router.refresh();
    },
    onError: (ctx) => {
      setError(ctx.error.message || 'Failed to sign in');
      setIsLoading(false);
    },
  }
);

// Sign up
await authClient.signUp.email(
  { email: data.email, password: data.password, name: data.name },
  { onRequest, onSuccess, onError }
);

// OAuth
await authClient.signIn.social({
  provider: 'google',
  callbackURL: '/dashboard',
});
```

## Component Reference

**Available UI Components:**

- `Button` - Submit and action buttons
- `Input` - Text, email, number inputs
- `PasswordInput` - Password with show/hide toggle
- `Label` - Form labels
- `Textarea` - Multi-line text
- `Select`, `SelectTrigger`, `SelectContent`, `SelectItem` - Dropdowns
- `Checkbox` - Checkboxes
- `RadioGroup`, `RadioGroupItem` - Radio buttons
- `Switch` - Toggle switches

**Available Form Helpers:**

- `FormError` - Field error display (`components/forms/form-error.tsx`)
- `PasswordStrength` - Password strength meter (`components/forms/password-strength.tsx`)
- `OAuthButtons` - OAuth sign-in buttons (`components/forms/oauth-buttons.tsx`)

## Form Types Reference

### Profile Edit Form

```typescript
export const profileSchema = z.object({
  name: z.string().min(1).max(100),
  bio: z.string().max(500).optional(),
  website: z.string().url().optional().or(z.literal('')),
});
```

### Settings Form

```typescript
export const settingsSchema = z.object({
  emailNotifications: z.boolean(),
  marketingEmails: z.boolean(),
  timezone: z.string(),
});
```

### Password Change Form

```typescript
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: passwordSchema, // Reuse from auth.ts
    confirmPassword: z.string(),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });
```

## Usage Examples

**Simple profile form:**

```
User: "Create a profile edit form with name, email, and bio"
Assistant: [Creates schema in lib/validations/user.ts, form in components/forms/profile-form.tsx]
```

**Settings form with toggles:**

```
User: "Create a settings form for email preferences"
Assistant: [Creates schema, form with Switch components for toggles]
```

**Password change form:**

```
User: "Create a change password form"
Assistant: [Creates schema with password validation, form with PasswordInput and strength meter]
```
