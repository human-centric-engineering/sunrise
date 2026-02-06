# User-Friendly Error Messages

**Last Updated**: 2026-02-06
**Related**: [Error Handling Overview](./overview.md)

This document covers translating technical error codes to user-friendly messages for display in the UI.

## Table of Contents

- [Overview](#overview)
- [getUserFriendlyMessage()](#getuserfriendlymessage)
- [Error Code Mappings](#error-code-mappings)
- [getContextualErrorMessage()](#getcontextualerrormessage)
- [getFormErrorMessage()](#getformerrormessage)
- [Using in Components](#using-in-components)
- [FormError Component](#formerror-component)

## Overview

Technical error codes are not user-friendly:

```typescript
// Bad (technical)
'VALIDATION_ERROR: Email field failed regex validation';

// Good (user-friendly)
'Please check your input and try again.';
```

The `lib/errors/messages.ts` module provides translation functions to convert error codes to actionable messages.

## getUserFriendlyMessage()

**Location**: `lib/errors/messages.ts`

Maps an error code to a user-friendly message.

```typescript
import { getUserFriendlyMessage } from '@/lib/errors/messages';

// Basic usage
getUserFriendlyMessage('UNAUTHORIZED');
// -> "Please sign in to continue."

// Unknown code falls back to default
getUserFriendlyMessage('UNKNOWN_CODE');
// -> "An error occurred. Please try again."

// Custom fallback message
getUserFriendlyMessage('UNKNOWN_CODE', 'Custom fallback');
// -> "Custom fallback"
```

**Signature**:

```typescript
function getUserFriendlyMessage(
  code?: string,
  defaultMessage: string = 'An error occurred. Please try again.'
): string;
```

## Error Code Mappings

All supported error codes and their user-friendly messages:

| Error Code               | User-Friendly Message                                  |
| ------------------------ | ------------------------------------------------------ |
| `UNAUTHORIZED`           | Please sign in to continue.                            |
| `FORBIDDEN`              | You don't have permission to access this resource.     |
| `NOT_FOUND`              | The requested resource could not be found.             |
| `VALIDATION_ERROR`       | Please check your input and try again.                 |
| `EMAIL_TAKEN`            | This email address is already registered.              |
| `RATE_LIMIT_EXCEEDED`    | Too many requests. Please try again later.             |
| `INTERNAL_ERROR`         | Something went wrong. Please try again.                |
| `CONFLICT`               | This resource already exists.                          |
| `INVITATION_EXPIRED`     | This invitation has expired. Please request a new one. |
| `FILE_TOO_LARGE`         | The file is too large. Please choose a smaller file.   |
| `INVALID_FILE_TYPE`      | This file type is not supported.                       |
| `UPLOAD_FAILED`          | Failed to upload file. Please try again.               |
| `STORAGE_NOT_CONFIGURED` | File uploads are not available at this time.           |

## getContextualErrorMessage()

Generates context-aware messages based on resource, action, or field.

```typescript
import { getContextualErrorMessage } from '@/lib/errors/messages';

// Resource-specific
getContextualErrorMessage('NOT_FOUND', { resource: 'user' });
// -> "User not found."

// Action-specific
getContextualErrorMessage('FORBIDDEN', { action: 'delete', resource: 'post' });
// -> "You don't have permission to delete this post."

// Action only
getContextualErrorMessage('FORBIDDEN', { action: 'delete' });
// -> "You don't have permission to delete."

// Field-specific validation
getContextualErrorMessage('VALIDATION_ERROR', { field: 'email' });
// -> "Email is invalid."

// Auth with action
getContextualErrorMessage('UNAUTHORIZED', { action: 'view this page' });
// -> "Please sign in to view this page."

// Internal error with action
getContextualErrorMessage('INTERNAL_ERROR', { action: 'save changes' });
// -> "Failed to save changes. Please try again."
```

**Signature**:

```typescript
function getContextualErrorMessage(
  code: string,
  context?: {
    resource?: string;
    action?: string;
    field?: string;
  }
): string;
```

## getFormErrorMessage()

Extracts appropriate error messages from API error responses for forms.

```typescript
import { getFormErrorMessage } from '@/lib/errors/messages';

// General error
const error = { code: 'UNAUTHORIZED', message: '...' };
getFormErrorMessage(error);
// -> "Please sign in to continue."

// Field-specific validation error
const validationError = {
  code: 'VALIDATION_ERROR',
  details: { email: ['Invalid email format'] },
};
getFormErrorMessage(validationError, 'email');
// -> "Invalid email format"

// Multiple field errors
const multiError = {
  code: 'VALIDATION_ERROR',
  details: {
    password: ['Must be at least 8 characters', 'Must contain a number'],
  },
};
getFormErrorMessage(multiError, 'password');
// -> "Must be at least 8 characters and must contain a number"
```

**Signature**:

```typescript
function getFormErrorMessage(
  error: {
    code?: string;
    message?: string;
    details?: Record<string, string[]>;
  },
  field?: string
): string;
```

## Using in Components

### Basic Error Display

```typescript
import { getUserFriendlyMessage } from '@/lib/errors/messages';

function MyComponent() {
  const [error, setError] = useState(null);

  const handleAction = async () => {
    try {
      await apiCall();
    } catch (err) {
      const message = getUserFriendlyMessage(err.code);
      setError(message);
    }
  };

  return (
    <div>
      {error && <p className="text-red-500">{error}</p>}
      <button onClick={handleAction}>Submit</button>
    </div>
  );
}
```

### With API Error Response

```typescript
import { getFormErrorMessage } from '@/lib/errors/messages';

function SignupForm() {
  const [apiError, setApiError] = useState(null);

  const onSubmit = async (data) => {
    try {
      await apiClient.post('/api/v1/users', data);
    } catch (error) {
      setApiError(error);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Input name="email" />

      {/* Show field-specific error */}
      {apiError && (
        <p className="text-red-500">
          {getFormErrorMessage(apiError, 'email')}
        </p>
      )}

      <Button type="submit">Sign Up</Button>
    </form>
  );
}
```

## FormError Component

**Location**: `components/forms/form-error.tsx`

A pre-built component that displays error messages with consistent styling. Automatically translates error codes.

### Props

| Prop      | Type     | Description                                      |
| --------- | -------- | ------------------------------------------------ |
| `message` | `string` | Direct error message to display                  |
| `code`    | `string` | Error code to translate to user-friendly message |

If both `message` and `code` are provided, `message` takes precedence.

### Usage Examples

```typescript
import { FormError } from '@/components/forms/form-error';

// Direct message
<FormError message="Email is required" />

// Error code (automatically translated)
<FormError code="UNAUTHORIZED" />
// -> Displays: "Please sign in to continue."

// From API error response
<FormError code={apiError.code} />

// With fallback message
<FormError code={apiError.code} message={apiError.message} />
```

### Complete Form Example

```typescript
import { FormError } from '@/components/forms/form-error';

function SignupForm() {
  const [apiError, setApiError] = useState(null);

  const onSubmit = async (data) => {
    try {
      await apiClient.post('/api/v1/users', data);
    } catch (error) {
      setApiError(error);
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)}>
      <Input name="email" />
      <Input name="password" type="password" />

      {/* Show API error with user-friendly message */}
      {apiError && <FormError code={apiError.code} />}

      <Button type="submit">Sign Up</Button>
    </form>
  );
}
```

### Styling

FormError renders with:

- Red background and border
- AlertCircle icon
- Dark mode support

```tsx
// Renders as:
<div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-400">
  <AlertCircle className="h-4 w-4 flex-shrink-0" />
  <span>{displayMessage}</span>
</div>
```

## Related Documentation

- **[Error Handling Overview](./overview.md)** - Architecture and flow diagrams
- **[Error Classes](./error-classes.md)** - API error classes
- **[Error Boundaries](./error-boundaries.md)** - React error boundaries

## See Also

- `lib/errors/messages.ts` - Message utilities implementation
- `lib/api/errors.ts` - Error codes definition
- `components/forms/form-error.tsx` - FormError component
