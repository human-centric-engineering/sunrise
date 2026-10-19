import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { API } from '@/lib/api/endpoints';
import { requireServerData } from '@/lib/api/server-load';
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

/**
 * Fetch user by ID from API. A missing user renders the not-found page; any
 * other failure throws to the admin error boundary rather than reading as a
 * missing user (#518).
 */
async function getUser(id: string): Promise<AdminUser> {
  const { data } = await requireServerData<AdminUser>(API.USERS.byId(id), { notFound: true });

  return {
    id: data.id,
    name: data.name,
    email: data.email,
    emailVerified: data.emailVerified,
    image: data.image,
    role: data.role,
    bio: data.bio ?? null,
    createdAt: new Date(data.createdAt),
    updatedAt: new Date(data.updatedAt),
    phone: data.phone ?? null,
    timezone: data.timezone ?? null,
    location: data.location ?? null,
  };
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

  return <UserEditForm user={user} currentUserId={session.user.id} />;
}
