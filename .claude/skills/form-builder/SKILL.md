---
name: form-builder
description: |
  Form builder for Sunrise. Creates validated forms using
  `react-hook-form` + Zod + shadcn/ui following the established
  pattern: `mode: 'onTouched'`, all fields default-valued, `apiClient`
  for non-auth submits / `authClient` for auth flows, `<FormError>` for
  per-field errors, and `<FieldHelp>` ⓘ popovers on every non-trivial
  field. Use when creating new forms under `components/forms/` or
  modifying existing ones.
---

# Form Builder Skill

Production-ready forms in Sunrise use one composition: `react-hook-form` for state, `zodResolver` for validation, shadcn primitives for UI, and `<FieldHelp>` for inline guidance on non-trivial fields. Reference `components/forms/profile-form.tsx` and `preferences-form.tsx` for the canonical implementations — copy them instead of inventing.

**Required by CLAUDE.md:** every non-trivial form field gets a `<FieldHelp>` ⓘ popover. See [`.context/ui/contextual-help.md`](../../../.context/ui/contextual-help.md) for the full spec.

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

**Field rendering pattern.** Two flavours — pick based on whether the field's purpose is self-evident from its label alone.

**Self-evident fields** (name, email, password — meaning is obvious): no FieldHelp needed.

```typescript
<div className="space-y-2">
  <Label htmlFor="email">Email</Label>
  <Input
    id="email"
    type="email"
    disabled={isLoading}
    {...register('email')}
  />
  <FormError message={errors.email?.message} />
</div>
```

**Non-trivial fields** (bio, phone, timezone, anything domain-specific or whose default matters): wrap with a `<FieldHelp>` ⓘ popover inside the label. Required by CLAUDE.md.

```typescript
import { FieldHelp } from '@/components/ui/field-help';

<div className="space-y-2">
  <Label htmlFor="bio" className="flex items-center gap-1">
    Bio
    <FieldHelp title="Public bio">
      Shown on your profile and in @mentions. 500 character max. Leave blank to
      hide the bio section entirely.
    </FieldHelp>
  </Label>
  <Textarea
    id="bio"
    rows={3}
    disabled={isLoading}
    {...register('bio')}
  />
  <FormError message={errors.bio?.message} />
</div>
```

Notes on the FieldHelp pattern:

- `className="flex items-center gap-1"` on the `<Label>` puts the ⓘ inline with the text.
- Body should answer three questions: **what** the setting does, **when** to change it, and **what the default is**. Keep it under three sentences.
- Add `<Link href="/admin/orchestration/learning">Learn more</Link>` when there's deeper context the user should be able to drill into.
- Heuristic for "non-trivial": if you wouldn't be able to predict what a field controls from its label alone — or if it has a non-obvious default, an effect on billing/cost, or domain-specific terminology — it needs help text.

Full spec and accessibility notes: [`.context/ui/contextual-help.md`](../../../.context/ui/contextual-help.md).

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
- [ ] **Every non-trivial field has `<FieldHelp>` inside its `<Label>`** (per CLAUDE.md)
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

- `FieldHelp` - ⓘ popover for non-trivial field guidance (`components/ui/field-help.tsx`) — required on non-self-evident fields per CLAUDE.md
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
