# Session Management

This document covers server-side and client-side session handling patterns in Sunrise.

## Server-Side Session Access

### In Server Components

```typescript
// app/(protected)/dashboard/page.tsx
import { getServerSession, getServerUser } from '@/lib/auth/utils'

export default async function DashboardPage() {
  // Get full session (session + user)
  const session = await getServerSession()

  // Or get just the user
  const user = await getServerUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div>
      <h1>Welcome, {user.name}</h1>
      <p>Session expires: {new Date(session.session.expiresAt).toLocaleDateString()}</p>
    </div>
  )
}
```

### In Server Actions

```typescript
// app/actions/update-profile.ts
'use server';

import { requireAuth } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { revalidatePath } from 'next/cache';

export async function updateProfile(formData: FormData) {
  const session = await requireAuth();

  const name = formData.get('name') as string;

  await prisma.user.update({
    where: { id: session.user.id },
    data: { name },
  });

  revalidatePath('/profile');

  return { success: true };
}
```

### Protected Server Actions

```typescript
// app/actions/create-post.ts
'use server';

import { requireAuth } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';
import { z } from 'zod';

const createPostSchema = z.object({
  title: z.string().min(1).max(100),
  content: z.string().min(1),
});

export async function createPost(formData: FormData) {
  // Ensure user is authenticated
  const session = await requireAuth();

  // Validate input
  const data = createPostSchema.parse({
    title: formData.get('title'),
    content: formData.get('content'),
  });

  // Create post
  const post = await prisma.post.create({
    data: {
      ...data,
      authorId: session.user.id,
    },
  });

  return { success: true, post };
}
```

### Role-Based Server Actions

```typescript
// app/actions/delete-user.ts
'use server';

import { requireRole } from '@/lib/auth/utils';
import { prisma } from '@/lib/db/client';

export async function deleteUser(userId: string) {
  // Ensure user is admin
  await requireRole('ADMIN');

  await prisma.user.delete({
    where: { id: userId },
  });

  return { success: true };
}
```

## Client-Side Session Updates

When user data changes, the session automatically updates due to better-auth's reactive state management:

```typescript
// components/profile-form.tsx
'use client'

import { authClient, useSession } from '@/lib/auth/client'
import { useState } from 'react'

export function ProfileForm() {
  const { data: session, refetch } = useSession()
  const [name, setName] = useState(session?.user.name || '')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()

    // Update user via API
    const response = await fetch('/api/v1/users/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })

    if (response.ok) {
      // Manually refetch session if needed
      // (better-auth usually updates automatically)
      await refetch()
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button type="submit">Update Profile</button>
    </form>
  )
}
```

## Logout Implementation

### Simple Logout

```typescript
// components/logout-button.tsx
'use client'

import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'

export function LogoutButton() {
  const router = useRouter()

  const handleLogout = async () => {
    await authClient.signOut()
    router.push('/')
    router.refresh()
  }

  return (
    <Button onClick={handleLogout} variant="ghost">
      Logout
    </Button>
  )
}
```

### Logout with Cleanup

```typescript
// components/logout-button.tsx
'use client'

import { authClient } from '@/lib/auth/client'
import { Button } from '@/components/ui/button'
import { useRouter } from 'next/navigation'

export function LogoutButton() {
  const router = useRouter()

  const handleLogout = async () => {
    try {
      // Optional: Clear client-side data
      localStorage.clear()
      sessionStorage.clear()

      // Optional: Call API to perform server-side cleanup
      await fetch('/api/auth/cleanup', { method: 'POST' })

      // Sign out
      await authClient.signOut()

      // Redirect and refresh
      router.push('/')
      router.refresh()
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }

  return (
    <Button onClick={handleLogout} variant="ghost">
      Logout
    </Button>
  )
}
```

## Session Utilities Reference

### `getServerSession()`

Returns full session object or null:

```typescript
const session = await getServerSession();
// { session: { id, userId, expiresAt, ... }, user: { id, name, email, role, ... } }
```

### `getServerUser()`

Returns just the user or null:

```typescript
const user = await getServerUser();
// { id, name, email, role, emailVerified, image, ... }
```

### `requireAuth()`

Throws if not authenticated:

```typescript
const session = await requireAuth();
// Guaranteed to have session, or throws error
```

### `requireRole(role)`

Throws if not authenticated or wrong role:

```typescript
await requireRole('ADMIN');
// Throws if not admin
```

## Session Caching

better-auth caches session data using cookies and internal state management:

- **Client-side**: nanostore provides reactive state without re-fetching
- **Server-side**: Session validated once per request using headers
- **No unnecessary database queries**

## Session Configuration

Session behavior is configured in `lib/auth/config.ts`:

```typescript
export const auth = betterAuth({
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // Update session every 24 hours
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5, // 5 minutes
    },
  },
});
```

## Related Documentation

- [Auth Forms](./forms.md) - Login and signup forms
- [OAuth Integration](./oauth.md) - Social login setup
- [Auth Integration](./integration.md) - Route protection patterns
