# Form Components

## Overview

Sunrise includes specialized form components for common UI patterns like error display, password strength indication, and avatar uploads. These components integrate with react-hook-form, Zod validation, and the shadcn/ui design system.

## Component Library

| Component          | Purpose                           | File                                      |
| ------------------ | --------------------------------- | ----------------------------------------- |
| `FormError`        | Display validation error messages | `components/forms/form-error.tsx`         |
| `PasswordStrength` | Visual password strength meter    | `components/forms/password-strength.tsx`  |
| `AvatarUpload`     | Avatar upload with drag-and-drop  | `components/forms/avatar-upload.tsx`      |
| `AvatarCropDialog` | Image cropping modal              | `components/forms/avatar-crop-dialog.tsx` |

## FormError

Displays validation error messages with an icon, colored background, and border. Supports both direct messages and error code mapping.

```tsx
import { FormError } from '@/components/forms/form-error';

// Direct message (from react-hook-form)
<FormError message={errors.email?.message} />

// Error code (maps to user-friendly message)
<FormError code="UNAUTHORIZED" />
// Renders: "Please sign in to continue."

// From API error response (message takes precedence)
<FormError code={apiError.code} message={apiError.message} />
```

**Props:**

| Prop      | Type     | Required | Description                                           |
| --------- | -------- | -------- | ----------------------------------------------------- |
| `message` | `string` | No       | Error message to display (takes precedence over code) |
| `code`    | `string` | No       | Error code to map via `lib/errors/messages.ts`        |

**Behavior:**

- Returns `null` when no message or code is provided
- Uses `getUserFriendlyMessage()` to map error codes to readable messages
- Works in both light and dark modes with appropriate color schemes

## PasswordStrength

Visual indicator showing password strength with a progress bar and text label.

```tsx
import { PasswordStrength } from '@/components/forms/password-strength';

// Typically used with a watched password field
const password = watch('password');

<PasswordStrength password={password} />;
```

**Props:**

| Prop       | Type     | Required | Description                |
| ---------- | -------- | -------- | -------------------------- |
| `password` | `string` | Yes      | Password value to evaluate |

**Behavior:**

- Returns `null` when password is empty
- Displays progress bar with color coding: red (Weak) to green (Strong)
- Shows text label: Weak, Fair, Good, or Strong

**Strength Calculation:**

The `calculatePasswordStrength()` utility in `lib/utils/password-strength.ts` evaluates:

- **Length:** Bonuses at 8, 12, and 16 characters
- **Character variety:** Lowercase, uppercase, numbers, special characters
- **Pattern penalties:** All same case, repeated characters, common sequences (123, abc, qwerty, password)

```typescript
interface PasswordStrength {
  score: number; // 0-4
  label: 'Weak' | 'Fair' | 'Good' | 'Strong' | 'Very Strong';
  color: string; // Tailwind class (e.g., 'bg-green-500')
  percentage: number; // 0-100 for progress bar width
}
```

## AvatarUpload

Complete avatar upload component with drag-and-drop, file validation, crop dialog, and delete functionality.

```tsx
import { AvatarUpload } from '@/components/forms/avatar-upload';
import { getInitials } from '@/lib/utils/initials';

<AvatarUpload currentAvatar={user.image} userName={user.name} initials={getInitials(user.name)} />;
```

**Props:**

| Prop            | Type             | Required | Description                             |
| --------------- | ---------------- | -------- | --------------------------------------- |
| `currentAvatar` | `string \| null` | Yes      | Current avatar URL                      |
| `userName`      | `string`         | Yes      | User's display name                     |
| `initials`      | `string`         | Yes      | Fallback initials (use `getInitials()`) |

**Features:**

- Click-to-upload or drag-and-drop file selection
- Client-side file validation (type and size)
- Opens crop dialog before upload
- Uploads cropped image to `/api/v1/users/me/avatar`
- Updates user session via better-auth after successful upload
- Delete button to remove current avatar
- Loading states for upload and delete operations
- Error message display

**Supported formats:** JPEG, PNG, WebP, GIF (from `lib/storage/constants.ts`)

**Max file size:** Derived from `lib/validations/storage.ts`

## AvatarCropDialog

Modal dialog for cropping images to a circular avatar shape. Used internally by `AvatarUpload`.

```tsx
import { AvatarCropDialog } from '@/components/forms/avatar-crop-dialog';

<AvatarCropDialog
  open={showCropDialog}
  imageSrc={imageObjectUrl}
  onConfirm={(blob) => handleUpload(blob)}
  onCancel={() => setShowCropDialog(false)}
/>;
```

**Props:**

| Prop        | Type                   | Required | Description                         |
| ----------- | ---------------------- | -------- | ----------------------------------- |
| `open`      | `boolean`              | Yes      | Controls dialog visibility          |
| `imageSrc`  | `string`               | Yes      | Image URL (typically an object URL) |
| `onConfirm` | `(blob: Blob) => void` | Yes      | Called with cropped image blob      |
| `onCancel`  | `() => void`           | Yes      | Called when user cancels            |

**Features:**

- Uses `react-easy-crop` for pan and zoom
- Circular crop shape for avatars
- Zoom slider with +/- buttons (1x to 3x)
- Outputs 500x500 JPEG at 90% quality
- Processing state during blob creation

**Integration with AvatarUpload:**

```
User selects file
     |
     v
AvatarUpload validates file type/size
     |
     v
AvatarUpload opens AvatarCropDialog
     |
     v
User adjusts crop area
     |
     v
AvatarCropDialog calls onConfirm(blob)
     |
     v
AvatarUpload uploads blob to API
     |
     v
Session updated, page refreshed
```

## Utility Functions

### getInitials

Extracts initials from a user's name for avatar fallbacks.

```typescript
import { getInitials } from '@/lib/utils/initials';

getInitials('John Doe'); // "JD"
getInitials('Alice'); // "A"
getInitials('John Q. Doe'); // "JQ" (first 2 initials only)
getInitials(''); // "?"
getInitials('   '); // "?"
```

**Behavior:**

- Returns up to 2 uppercase characters
- Handles extra spaces and empty strings
- Returns "?" for empty or whitespace-only input

**Location:** `lib/utils/initials.ts`

### getRoleBadgeVariant

Returns the appropriate badge variant for a user role.

```typescript
import { getRoleBadgeVariant } from '@/lib/utils/initials';
import { Badge } from '@/components/ui/badge';

<Badge variant={getRoleBadgeVariant(user.role)}>
  {user.role}
</Badge>

// ADMIN -> "default" (primary color)
// USER or other -> "outline"
```

**Signature:**

```typescript
function getRoleBadgeVariant(role: string | null): 'default' | 'secondary' | 'outline';
```

**Location:** `lib/utils/initials.ts`

## Usage Patterns

### Form with Error Display

```tsx
'use client';

import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { FormError } from '@/components/forms/form-error';
import { PasswordStrength } from '@/components/forms/password-strength';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { signupSchema } from '@/lib/validations/auth';

export function SignupForm() {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(signupSchema),
  });

  const password = watch('password');

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <div>
        <Input {...register('email')} placeholder="Email" />
        <FormError message={errors.email?.message} />
      </div>

      <div>
        <Input {...register('password')} type="password" placeholder="Password" />
        <FormError message={errors.password?.message} />
        <PasswordStrength password={password || ''} />
      </div>

      <Button type="submit">Sign Up</Button>
    </form>
  );
}
```

### Settings Page with Avatar

```tsx
import { AvatarUpload } from '@/components/forms/avatar-upload';
import { getInitials } from '@/lib/utils/initials';

export function ProfileSettings({ user }) {
  return (
    <div>
      <h2>Profile Picture</h2>
      <AvatarUpload
        currentAvatar={user.image}
        userName={user.name || 'User'}
        initials={getInitials(user.name || '')}
      />
    </div>
  );
}
```

### Admin User Table with Role Badges

```tsx
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { getInitials, getRoleBadgeVariant } from '@/lib/utils/initials';

export function UserRow({ user }) {
  return (
    <tr>
      <td>
        <Avatar>
          <AvatarImage src={user.image} />
          <AvatarFallback>{getInitials(user.name)}</AvatarFallback>
        </Avatar>
      </td>
      <td>{user.name}</td>
      <td>
        <Badge variant={getRoleBadgeVariant(user.role)}>{user.role}</Badge>
      </td>
    </tr>
  );
}
```

## Related Documentation

- [UI Patterns Overview](./overview.md) - URL-persistent tabs and other patterns
- [Marketing Components](./marketing.md) - Landing page components
- [Storage Overview](../storage/overview.md) - File upload configuration
- [Authentication](../auth/integration.md) - Session management after avatar upload
