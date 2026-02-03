import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { serverFetch } from '@/lib/api/server-fetch';
import { API } from '@/lib/api/endpoints';
import { getServerSession } from '@/lib/auth/utils';
import { UserEditForm } from '@/components/admin/user-edit-form';
import type { AdminUser, AdminUserResponse } from '@/types/admin';

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

/**
 * Fetch user by ID from API
 */
async function getUser(id: string): Promise<AdminUser | null> {
  try {
    const res = await serverFetch(API.USERS.byId(id));

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as AdminUserResponse;

    if (!data.success) {
      return null;
    }

    return {
      id: data.data.id,
      name: data.data.name,
      email: data.data.email,
      emailVerified: data.data.emailVerified,
      image: data.data.image,
      role: data.data.role,
      bio: data.data.bio ?? null,
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
 * Admin User Edit Page
 *
 * Edit user details (name, role, email verification).
 */
export default async function AdminUserEditPage({ params }: PageProps) {
  const { id } = await params;

  const session = await getServerSession();
  if (!session) {
    notFound();
  }

  const user = await getUser(id);

  if (!user) {
    notFound();
  }

  return <UserEditForm user={user} currentUserId={session.user.id} />;
}
