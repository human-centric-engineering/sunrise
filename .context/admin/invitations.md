# Invitation Management

## Overview

The invitation management system allows administrators to view and manage pending user invitations. It is displayed as a tab alongside active users in the user management interface, providing a unified view of both current and prospective users.

## Features

### Invitation Listing

The `InvitationTable` component displays pending invitations with:

- **Name and email** of invited user
- **Role** to be assigned (USER or ADMIN)
- **Invited by** (admin who sent the invitation)
- **Invited date**
- **Expiration date** with "Soon" badge for invitations expiring within 24 hours
- **Action menu** (Resend, Delete)

### Search

Real-time search with 300ms debouncing across name and email fields.

### Sorting

| Column     | Sortable |
| ---------- | -------- |
| Name       | Yes      |
| Email      | Yes      |
| Role       | No       |
| Invited By | No       |
| Invited    | Yes      |
| Expires    | Yes      |

### Pagination

Server-side pagination with default 20 items per page.

## Components

### UserManagementTabs

**Location**: `components/admin/user-management-tabs.tsx`

Wrapper component that organizes users and invitations into tabs:

```typescript
interface UserManagementTabsProps {
  users: UserListItem[];
  usersMeta: PaginationMeta;
  invitations: InvitationListItem[];
  invitationsMeta: PaginationMeta;
}
```

Features:

- **Tab badges**: Shows count of users and pending invitations
- **Shared invite button**: Single "Invite User" button in header
- **Parallel data fetching**: Server component fetches both datasets concurrently

```mermaid
graph TD
    A[Users Page] --> B[Fetch Users & Invitations in Parallel]
    B --> C[UserManagementTabs]
    C --> D[Active Users Tab]
    C --> E[Pending Invitations Tab]
    D --> F[UserTable]
    E --> G[InvitationTable]
```

### InvitationTable

**Location**: `components/admin/invitation-table.tsx`

**Props**:

```typescript
interface InvitationTableProps {
  initialInvitations: InvitationListItem[];
  initialMeta: PaginationMeta;
  initialSearch?: string;
  initialSortBy?: 'name' | 'email' | 'invitedAt' | 'expiresAt';
  initialSortOrder?: 'asc' | 'desc';
}
```

## Actions

### Resend Invitation

Sends a new invitation email and resets the expiration timer:

```typescript
await apiClient.post('/api/v1/users/invite?resend=true', {
  body: {
    name: invitation.name,
    email: invitation.email,
    role: invitation.role,
  },
});
```

Provides visual feedback:

- Spinning icon during send
- Success message with 3-second auto-dismiss
- Refreshes list to show updated expiration

### Cancel Invitation

Deletes the invitation with confirmation dialog:

```mermaid
sequenceDiagram
    Admin->>InvitationTable: Click Delete
    InvitationTable->>AlertDialog: Show confirmation
    Admin->>AlertDialog: Confirm
    AlertDialog->>API: DELETE /api/v1/admin/invitations/{email}
    API->>Database: Delete invitation token
    Database-->>API: Success
    API-->>InvitationTable: 200 OK
    InvitationTable->>InvitationTable: Refresh list
```

## Expiration Handling

Invitations expiring within 24 hours are highlighted:

```typescript
function isExpiringSoon(expiresAt: Date): boolean {
  const now = new Date();
  const twentyFourHoursFromNow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return expiresAt <= twentyFourHoursFromNow;
}
```

Visual indicators:

- Orange text for expiration date
- "Soon" badge with clock icon

## API Endpoints

| Endpoint                            | Method | Purpose                  |
| ----------------------------------- | ------ | ------------------------ |
| `/api/v1/admin/invitations`         | GET    | List pending invitations |
| `/api/v1/admin/invitations/[email]` | DELETE | Cancel invitation        |
| `/api/v1/users/invite`              | POST   | Send/resend invitation   |

### Query Parameters (GET /api/v1/admin/invitations)

| Parameter   | Type     | Default   | Description              |
| ----------- | -------- | --------- | ------------------------ |
| `page`      | number   | 1         | Page number              |
| `limit`     | number   | 20        | Items per page (max 100) |
| `search`    | string   | -         | Search name/email        |
| `sortBy`    | string   | invitedAt | Sort field               |
| `sortOrder` | asc/desc | desc      | Sort direction           |

## Type Definitions

```typescript
// types/index.ts
export interface InvitationListItem {
  email: string;
  name: string;
  role: string;
  invitedBy: string;
  invitedByName: string | null;
  invitedAt: Date;
  expiresAt: Date;
}
```

## Data Flow

```mermaid
sequenceDiagram
    participant Page as Users Page (Server)
    participant API as Invitations API
    participant DB as Database
    participant UI as InvitationTable (Client)

    Page->>API: GET /api/v1/admin/invitations
    API->>DB: Query invitation tokens
    DB-->>API: Pending invitations
    API-->>Page: Paginated response
    Page->>UI: Pass initialInvitations
    UI->>UI: Render table
```

## Related Documentation

- [User Management](./user-management.md) - Active user management
- [Overview](./overview.md) - Admin dashboard architecture
- [User Creation](../auth/user-creation.md) - Invitation flow details
- [Email Templates](../email/overview.md) - Invitation email template
