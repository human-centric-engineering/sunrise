/**
 * getAllPendingInvitations() Function Tests
 *
 * Tests the getAllPendingInvitations utility function that retrieves
 * and processes pending user invitations with support for:
 * - Pagination
 * - Search (email/name)
 * - Sorting (name, email, invitedAt, expiresAt)
 * - Inviter name resolution
 * - Filtering expired invitations
 *
 * @see lib/utils/invitation-token.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAllPendingInvitations } from '@/lib/utils/invitation-token';

/**
 * Mock dependencies
 */

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    verification: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

// Mock logger
vi.mock('@/lib/logging', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Import mocked modules
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';

/**
 * Test data factories
 */

const createMockVerification = (
  email: string,
  name: string,
  role: string,
  invitedBy: string,
  daysOffset = 7
) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + daysOffset * 24 * 60 * 60 * 1000);
  const createdAt = new Date(now.getTime() - 24 * 60 * 60 * 1000); // 1 day ago

  return {
    id: `verification-${email}`,
    identifier: `invitation:${email}`,
    value: 'hashed-token',
    expiresAt,
    createdAt,
    updatedAt: createdAt,
    metadata: {
      name,
      role,
      invitedBy,
      invitedAt: createdAt.toISOString(),
    },
  };
};

const createMockUser = (id: string, name: string) => ({
  id,
  name,
  email: `${name.toLowerCase().replace(' ', '.')}@example.com`,
  role: 'ADMIN',
  emailVerified: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  image: null,
  bio: null,
  phone: null,
  timezone: 'UTC',
  location: null,
  preferences: {},
});

/**
 * Test Suite: getAllPendingInvitations()
 */
describe('getAllPendingInvitations()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basic functionality', () => {
    it('should return pending invitations with inviter names', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice Johnson', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob Smith', 'USER', 'admin-2', 5),
      ];

      const mockAdmin1 = createMockUser('admin-1', 'Admin One');
      const mockAdmin2 = createMockUser('admin-2', 'Admin Two');

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(2);

      // Mock user lookups for inviter names
      vi.mocked(prisma.user.findUnique)
        .mockResolvedValueOnce(mockAdmin1)
        .mockResolvedValueOnce(mockAdmin2);

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should return invitations with resolved inviter names
      expect(result.invitations).toHaveLength(2);
      expect(result.total).toBe(2);

      // Find invitations by email (order depends on database query)
      const aliceInvitation = result.invitations.find((inv) => inv.email === 'alice@example.com');
      const bobInvitation = result.invitations.find((inv) => inv.email === 'bob@example.com');

      expect(aliceInvitation).toMatchObject({
        email: 'alice@example.com',
        name: 'Alice Johnson',
        role: 'USER',
        invitedBy: 'admin-1',
        invitedByName: 'Admin One',
      });

      expect(bobInvitation).toMatchObject({
        email: 'bob@example.com',
        name: 'Bob Smith',
        role: 'USER',
        invitedBy: 'admin-2',
        invitedByName: 'Admin Two',
      });
    });

    it('should query database with correct filters', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      await getAllPendingInvitations();

      // Assert: Should filter by invitation prefix and non-expired
      expect(prisma.verification.findMany).toHaveBeenCalledWith({
        where: {
          identifier: { startsWith: 'invitation:' },
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { createdAt: 'desc' },
      });

      expect(prisma.verification.count).toHaveBeenCalledWith({
        where: {
          identifier: { startsWith: 'invitation:' },
          expiresAt: { gt: expect.any(Date) },
        },
      });
    });

    it('should extract email from identifier', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('user@example.com', 'Test User', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should extract email correctly
      expect(result.invitations[0].email).toBe('user@example.com');
    });

    it('should parse dates from metadata and database', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('user@example.com', 'Test User', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should return proper Date objects
      expect(result.invitations[0].invitedAt).toBeInstanceOf(Date);
      expect(result.invitations[0].expiresAt).toBeInstanceOf(Date);
    });

    it('should log successful fetch', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      await getAllPendingInvitations({ page: 1, limit: 20 });

      // Assert
      expect(logger.info).toHaveBeenCalledWith(
        'Fetched pending invitations',
        expect.objectContaining({
          total: 0,
          page: 1,
          limit: 20,
          search: null,
        })
      );
    });
  });

  describe('pagination', () => {
    it('should apply default pagination (page 1, limit 20)', async () => {
      // Arrange
      const mockVerifications = Array.from({ length: 25 }, (_, i) =>
        createMockVerification(`user${i}@example.com`, `User ${i}`, 'USER', 'admin-1', 7)
      );

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(25);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should return first 20 items
      expect(result.invitations).toHaveLength(20);
      expect(result.total).toBe(25);
    });

    it('should paginate correctly (page 2)', async () => {
      // Arrange
      const mockVerifications = Array.from({ length: 25 }, (_, i) =>
        createMockVerification(`user${i}@example.com`, `User ${i}`, 'USER', 'admin-1', 7)
      );

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(25);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ page: 2, limit: 10 });

      // Assert: Should return items 11-20
      expect(result.invitations).toHaveLength(10);
      expect(result.invitations[0].email).toBe('user10@example.com');
      expect(result.invitations[9].email).toBe('user19@example.com');
    });

    it('should handle last page with fewer items', async () => {
      // Arrange
      const mockVerifications = Array.from({ length: 25 }, (_, i) =>
        createMockVerification(`user${i}@example.com`, `User ${i}`, 'USER', 'admin-1', 7)
      );

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(25);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ page: 3, limit: 10 });

      // Assert: Should return remaining 5 items
      expect(result.invitations).toHaveLength(5);
    });

    it('should return empty array for page beyond total', async () => {
      // Arrange
      const mockVerifications = Array.from({ length: 5 }, (_, i) =>
        createMockVerification(`user${i}@example.com`, `User ${i}`, 'USER', 'admin-1', 7)
      );

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(5);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ page: 10, limit: 20 });

      // Assert
      expect(result.invitations).toHaveLength(0);
      expect(result.total).toBe(5);
    });
  });

  describe('search functionality', () => {
    it('should filter by email (case-insensitive)', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice Johnson', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob Smith', 'USER', 'admin-1', 7),
        createMockVerification('charlie@test.com', 'Charlie Brown', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ search: 'EXAMPLE' });

      // Assert: Should only include emails containing "example"
      expect(result.invitations).toHaveLength(2);
      expect(result.invitations[0].email).toContain('example');
      expect(result.invitations[1].email).toContain('example');
      expect(result.total).toBe(2); // Filtered total
    });

    it('should filter by name (case-insensitive)', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice Johnson', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob Smith', 'USER', 'admin-1', 7),
        createMockVerification('charlie@example.com', 'Charlie Brown', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ search: 'johnson' });

      // Assert: Should only include names containing "johnson"
      expect(result.invitations).toHaveLength(1);
      expect(result.invitations[0].name).toBe('Alice Johnson');
    });

    it('should filter by partial match', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice Johnson', 'USER', 'admin-1', 7),
        createMockVerification('alicia@example.com', 'Alicia Keys', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob Smith', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ search: 'ali' });

      // Assert: Should match both alice and alicia
      expect(result.invitations).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should return empty array when no matches', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice Johnson', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ search: 'nonexistent' });

      // Assert
      expect(result.invitations).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should log search query', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      await getAllPendingInvitations({ search: 'test' });

      // Assert
      expect(logger.info).toHaveBeenCalledWith(
        'Fetched pending invitations',
        expect.objectContaining({
          search: 'test',
        })
      );
    });
  });

  describe('sorting functionality', () => {
    it('should sort by invitedAt descending (default)', async () => {
      // Arrange
      const now = new Date();
      const mockVerifications = [
        {
          ...createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
          createdAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000), // 3 days ago
          metadata: {
            name: 'Alice',
            role: 'USER',
            invitedBy: 'admin-1',
            invitedAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
        {
          ...createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-1', 7),
          createdAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
          metadata: {
            name: 'Bob',
            role: 'USER',
            invitedBy: 'admin-1',
            invitedAt: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString(),
          },
        },
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(2);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should be sorted by invitedAt descending (most recent first)
      expect(result.invitations[0].email).toBe('bob@example.com');
      expect(result.invitations[1].email).toBe('alice@example.com');
    });

    it('should sort by name ascending', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('charlie@example.com', 'Charlie', 'USER', 'admin-1', 7),
        createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ sortBy: 'name', sortOrder: 'asc' });

      // Assert: Should be sorted alphabetically
      expect(result.invitations[0].name).toBe('Alice');
      expect(result.invitations[1].name).toBe('Bob');
      expect(result.invitations[2].name).toBe('Charlie');
    });

    it('should sort by name descending', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-1', 7),
        createMockVerification('charlie@example.com', 'Charlie', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ sortBy: 'name', sortOrder: 'desc' });

      // Assert: Should be sorted reverse alphabetically
      expect(result.invitations[0].name).toBe('Charlie');
      expect(result.invitations[1].name).toBe('Bob');
      expect(result.invitations[2].name).toBe('Alice');
    });

    it('should sort by email', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('charlie@example.com', 'User C', 'USER', 'admin-1', 7),
        createMockVerification('alice@example.com', 'User A', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'User B', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ sortBy: 'email', sortOrder: 'asc' });

      // Assert: Should be sorted by email
      expect(result.invitations[0].email).toBe('alice@example.com');
      expect(result.invitations[1].email).toBe('bob@example.com');
      expect(result.invitations[2].email).toBe('charlie@example.com');
    });

    it('should sort by expiresAt', async () => {
      // Arrange
      const now = new Date();
      const mockVerifications = [
        {
          ...createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
          expiresAt: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000), // 3 days
        },
        {
          ...createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-1', 7),
          expiresAt: new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000), // 1 day
        },
        {
          ...createMockVerification('charlie@example.com', 'Charlie', 'USER', 'admin-1', 7),
          expiresAt: new Date(now.getTime() + 5 * 24 * 60 * 60 * 1000), // 5 days
        },
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ sortBy: 'expiresAt', sortOrder: 'asc' });

      // Assert: Should be sorted by expiration date
      expect(result.invitations[0].email).toBe('bob@example.com'); // Expires soonest
      expect(result.invitations[1].email).toBe('alice@example.com');
      expect(result.invitations[2].email).toBe('charlie@example.com'); // Expires latest
    });

    it('should handle case-insensitive name sorting', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'alice', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-1', 7),
        createMockVerification('charlie@example.com', 'CHARLIE', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act
      const result = await getAllPendingInvitations({ sortBy: 'name', sortOrder: 'asc' });

      // Assert: Should sort case-insensitively
      expect(result.invitations[0].name).toBe('alice');
      expect(result.invitations[1].name).toBe('Bob');
      expect(result.invitations[2].name).toBe('CHARLIE');
    });
  });

  describe('inviter name resolution', () => {
    it('should resolve inviter names from User table', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
      ];

      const mockAdmin = createMockUser('admin-1', 'Admin User');

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(mockAdmin);

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should look up inviter
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: 'admin-1' },
        select: { name: true },
      });
      expect(result.invitations[0].invitedByName).toBe('Admin User');
    });

    it('should return null for deleted inviter', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-deleted', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null); // User deleted

      // Act
      const result = await getAllPendingInvitations();

      // Assert
      expect(result.invitations[0].invitedByName).toBeNull();
    });

    it('should handle multiple different inviters', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-2', 7),
        createMockVerification('charlie@example.com', 'Charlie', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(3);
      vi.mocked(prisma.user.findUnique)
        .mockResolvedValueOnce(createMockUser('admin-1', 'Admin One'))
        .mockResolvedValueOnce(createMockUser('admin-2', 'Admin Two'))
        .mockResolvedValueOnce(createMockUser('admin-1', 'Admin One'));

      // Act - use explicit sort to get deterministic order (default invitedAt desc
      // can reorder results since each createMockVerification uses new Date() with
      // slightly different millisecond timestamps)
      const result = await getAllPendingInvitations({ sortBy: 'email', sortOrder: 'asc' });

      // Assert: Should resolve all inviter names (sorted by email asc: alice, bob, charlie)
      expect(result.invitations[0].invitedByName).toBe('Admin One');
      expect(result.invitations[1].invitedByName).toBe('Admin Two');
      expect(result.invitations[2].invitedByName).toBe('Admin One');
    });
  });

  describe('combined operations', () => {
    it('should handle search + sort + pagination together', async () => {
      // Arrange
      const mockVerifications = [
        createMockVerification('alice@example.com', 'Alice', 'USER', 'admin-1', 7),
        createMockVerification('alicia@example.com', 'Alicia', 'USER', 'admin-1', 7),
        createMockVerification('bob@example.com', 'Bob', 'USER', 'admin-1', 7),
        createMockVerification('alice.smith@example.com', 'Alice Smith', 'USER', 'admin-1', 7),
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(4);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(createMockUser('admin-1', 'Admin'));

      // Act: Search for "alice", sort by name asc, page 1 with limit 2
      const result = await getAllPendingInvitations({
        search: 'alice',
        sortBy: 'name',
        sortOrder: 'asc',
        page: 1,
        limit: 2,
      });

      // Assert: Should filter, sort, and paginate
      expect(result.invitations).toHaveLength(2);
      expect(result.invitations[0].name).toBe('Alice'); // Alphabetically first
      expect(result.invitations[1].name).toBe('Alice Smith');
      // Total is the filtered count after search but before pagination
      // Search for "alice" matches: alice@example.com, alicia@example.com, alice.smith@example.com = 3
      // But alicia is NOT in the mock data, so it should be 2: alice@example.com and alice.smith@example.com
      expect(result.total).toBe(2); // 2 matches for "alice"
    });
  });

  describe('edge cases', () => {
    it('should handle empty result set', async () => {
      // Arrange
      vi.mocked(prisma.verification.findMany).mockResolvedValue([]);
      vi.mocked(prisma.verification.count).mockResolvedValue(0);

      // Act
      const result = await getAllPendingInvitations();

      // Assert
      expect(result.invitations).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('should handle invitations without invitedBy metadata', async () => {
      // Arrange
      const mockVerifications = [
        {
          ...createMockVerification('alice@example.com', 'Alice', 'USER', '', 7),
          metadata: {
            name: 'Alice',
            role: 'USER',
            invitedBy: '', // Empty invitedBy
            invitedAt: new Date().toISOString(),
          },
        },
      ];

      vi.mocked(prisma.verification.findMany).mockResolvedValue(mockVerifications);
      vi.mocked(prisma.verification.count).mockResolvedValue(1);

      // Act
      const result = await getAllPendingInvitations();

      // Assert: Should not crash
      expect(result.invitations).toHaveLength(1);
      expect(result.invitations[0].invitedByName).toBeNull();
    });
  });

  describe('error handling', () => {
    it('should throw error when database query fails', async () => {
      // Arrange
      const dbError = new Error('Database connection failed');
      vi.mocked(prisma.verification.findMany).mockRejectedValue(dbError);

      // Act & Assert
      await expect(getAllPendingInvitations()).rejects.toThrow(
        'Failed to fetch pending invitations'
      );
    });

    it('should log error when query fails', async () => {
      // Arrange
      const dbError = new Error('Database error');
      vi.mocked(prisma.verification.findMany).mockRejectedValue(dbError);

      // Act
      try {
        await getAllPendingInvitations();
      } catch {
        // Expected to throw
      }

      // Assert
      expect(logger.error).toHaveBeenCalledWith('Failed to fetch pending invitations', dbError);
    });
  });
});
