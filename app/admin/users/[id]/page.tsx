import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { getServerSession } from '@/lib/auth/utils';
import { UserEditForm } from '@/components/admin/user-edit-form';
import type { AdminUser } from '@/types/admin';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  return {
    title: `Edit User ${id}`,
    description: 'Edit user details',
  };
}

interface UserApiResponse {
  success: boolean;
  data: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    role: string | null;
    createdAt: string;
    updatedAt: string;
    phone?: string | null;
    timezone?: string | null;
    location?: string | null;
  };
}

/**
 * Fetch user by ID from API
 */
async function getUser(id: string): Promise<AdminUser | null> {
  try {
    // Get cookies to forward to the API
    const cookieStore = await cookies();
    const cookieHeader = cookieStore
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');

    const res = await fetch(
      `${process.env.BETTER_AUTH_URL || 'http://localhost:3000'}/api/v1/users/${id}`,
      {
        headers: {
          Cookie: cookieHeader,
        },
        cache: 'no-store',
      }
    );

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as UserApiResponse;

    if (!data.success) {
      return null;
    }

    // Convert string dates to Date objects and ensure all optional fields are present
    return {
      id: data.data.id,
      name: data.data.name,
      email: data.data.email,
      emailVerified: data.data.emailVerified,
      image: data.data.image,
      role: data.data.role,
      createdAt: new Date(data.data.createdAt),
      updatedAt: new Date(data.data.updatedAt),
      phone: data.data.phone ?? null,
      timezone: data.data.timezone ?? null,
      location: data.data.location ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Admin User Edit Page (Phase 4.4)
 *
 * Edit user details (name, role, email verification).
 */
export default async function AdminUserEditPage({ params }: PageProps) {
  const { id } = await params;

  // Get current user session
  const session = await getServerSession();
  if (!session) {
    notFound();
  }

  // Fetch user
  const user = await getUser(id);

  if (!user) {
    notFound();
  }

  return <UserEditForm user={user} currentUserId={session.user.id} />;
}
