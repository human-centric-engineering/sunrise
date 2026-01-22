/**
 * Feature Flags Utilities Tests (Phase 4.4)
 *
 * Tests the feature flag utilities for runtime feature toggles.
 *
 * Test Coverage:
 * - isFeatureEnabled() - check if flag is enabled
 * - getAllFlags() - get all flags
 * - getFlag() - get single flag by name
 * - toggleFlag() - toggle flag state
 * - createFlag() - create new flag
 * - updateFlag() - update flag
 * - deleteFlag() - delete flag
 * - seedDefaultFlags() - seed default flags
 *
 * @see lib/feature-flags/index.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FeatureFlag } from '@/types/prisma';

/**
 * Mock dependencies
 */

// Mock the logger
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// Mock Prisma client
vi.mock('@/lib/db/client', () => ({
  prisma: {
    featureFlag: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

// Import after mocking
import {
  isFeatureEnabled,
  getAllFlags,
  getFlag,
  toggleFlag,
  createFlag,
  updateFlag,
  deleteFlag,
  seedDefaultFlags,
} from '@/lib/feature-flags';
import { logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { DEFAULT_FLAGS } from '@/lib/feature-flags/config';

/**
 * Helper to create mock feature flag
 */
function createMockFlag(overrides: Partial<FeatureFlag> = {}): FeatureFlag {
  return {
    id: 'flag_123',
    name: 'TEST_FLAG',
    enabled: false,
    description: 'Test flag description',
    metadata: {},
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    createdBy: null,
    ...overrides,
  };
}

describe('Feature Flags Utilities', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isFeatureEnabled', () => {
    it('should return true when flag is enabled', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue({ enabled: true } as FeatureFlag);

      // Act
      const result = await isFeatureEnabled('MAINTENANCE_MODE');

      // Assert
      expect(result).toBe(true);
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
        where: { name: 'MAINTENANCE_MODE' },
        select: { enabled: true },
      });
    });

    it('should return false when flag is disabled', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue({ enabled: false } as FeatureFlag);

      // Act
      const result = await isFeatureEnabled('MAINTENANCE_MODE');

      // Assert
      expect(result).toBe(false);
    });

    it('should return false when flag does not exist', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      // Act
      const result = await isFeatureEnabled('NONEXISTENT_FLAG');

      // Assert
      expect(result).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith('Feature flag not found', {
        flag: 'NONEXISTENT_FLAG',
      });
    });

    it('should convert flag name to uppercase', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue({ enabled: true } as FeatureFlag);

      // Act
      await isFeatureEnabled('maintenance_mode');

      // Assert
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
        where: { name: 'MAINTENANCE_MODE' },
        select: { enabled: true },
      });
    });

    it('should return false and log error on database failure', async () => {
      // Arrange
      const error = new Error('Database connection failed');
      vi.mocked(prisma.featureFlag.findUnique).mockRejectedValue(error);

      // Act
      const result = await isFeatureEnabled('TEST_FLAG');

      // Assert
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith('Error checking feature flag', error, {
        flag: 'TEST_FLAG',
      });
    });
  });

  describe('getAllFlags', () => {
    it('should return all flags ordered by name', async () => {
      // Arrange
      const mockFlags = [
        createMockFlag({ name: 'ALPHA_FLAG' }),
        createMockFlag({ name: 'BETA_FLAG' }),
        createMockFlag({ name: 'MAINTENANCE_MODE' }),
      ];
      vi.mocked(prisma.featureFlag.findMany).mockResolvedValue(mockFlags);

      // Act
      const result = await getAllFlags();

      // Assert
      expect(result).toEqual(mockFlags);
      expect(prisma.featureFlag.findMany).toHaveBeenCalledWith({
        orderBy: { name: 'asc' },
      });
    });

    it('should return empty array when no flags exist', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findMany).mockResolvedValue([]);

      // Act
      const result = await getAllFlags();

      // Assert
      expect(result).toEqual([]);
    });

    it('should return empty array and log error on database failure', async () => {
      // Arrange
      const error = new Error('Database connection failed');
      vi.mocked(prisma.featureFlag.findMany).mockRejectedValue(error);

      // Act
      const result = await getAllFlags();

      // Assert
      expect(result).toEqual([]);
      expect(logger.error).toHaveBeenCalledWith('Error fetching feature flags', error);
    });
  });

  describe('getFlag', () => {
    it('should return flag when found', async () => {
      // Arrange
      const mockFlag = createMockFlag();
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(mockFlag);

      // Act
      const result = await getFlag('TEST_FLAG');

      // Assert
      expect(result).toEqual(mockFlag);
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
        where: { name: 'TEST_FLAG' },
      });
    });

    it('should return null when flag not found', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);

      // Act
      const result = await getFlag('NONEXISTENT_FLAG');

      // Assert
      expect(result).toBeNull();
    });

    it('should convert name to uppercase', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(createMockFlag());

      // Act
      await getFlag('test_flag');

      // Assert
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
        where: { name: 'TEST_FLAG' },
      });
    });

    it('should return null and log error on database failure', async () => {
      // Arrange
      const error = new Error('Database connection failed');
      vi.mocked(prisma.featureFlag.findUnique).mockRejectedValue(error);

      // Act
      const result = await getFlag('TEST_FLAG');

      // Assert
      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Error fetching feature flag', error, {
        flag: 'TEST_FLAG',
      });
    });
  });

  describe('toggleFlag', () => {
    it('should toggle flag to enabled', async () => {
      // Arrange
      const mockFlag = createMockFlag({ enabled: true });
      vi.mocked(prisma.featureFlag.update).mockResolvedValue(mockFlag);

      // Act
      const result = await toggleFlag('TEST_FLAG', true);

      // Assert
      expect(result).toEqual(mockFlag);
      expect(prisma.featureFlag.update).toHaveBeenCalledWith({
        where: { name: 'TEST_FLAG' },
        data: { enabled: true },
      });
      expect(logger.info).toHaveBeenCalledWith('Feature flag toggled', {
        flag: 'TEST_FLAG',
        enabled: true,
      });
    });

    it('should toggle flag to disabled', async () => {
      // Arrange
      const mockFlag = createMockFlag({ enabled: false });
      vi.mocked(prisma.featureFlag.update).mockResolvedValue(mockFlag);

      // Act
      const result = await toggleFlag('TEST_FLAG', false);

      // Assert
      expect(result).toEqual(mockFlag);
      expect(prisma.featureFlag.update).toHaveBeenCalledWith({
        where: { name: 'TEST_FLAG' },
        data: { enabled: false },
      });
    });

    it('should convert name to uppercase', async () => {
      // Arrange
      vi.mocked(prisma.featureFlag.update).mockResolvedValue(createMockFlag());

      // Act
      await toggleFlag('test_flag', true);

      // Assert
      expect(prisma.featureFlag.update).toHaveBeenCalledWith({
        where: { name: 'TEST_FLAG' },
        data: { enabled: true },
      });
    });

    it('should return null and log error on failure', async () => {
      // Arrange
      const error = new Error('Flag not found');
      vi.mocked(prisma.featureFlag.update).mockRejectedValue(error);

      // Act
      const result = await toggleFlag('NONEXISTENT_FLAG', true);

      // Assert
      expect(result).toBeNull();
      expect(logger.error).toHaveBeenCalledWith('Error toggling feature flag', error, {
        flag: 'NONEXISTENT_FLAG',
        enabled: true,
      });
    });
  });

  describe('createFlag', () => {
    it('should create a new flag with all properties', async () => {
      // Arrange
      const mockFlag = createMockFlag({
        name: 'NEW_FEATURE',
        description: 'New feature description',
        enabled: true,
        metadata: { category: 'beta' },
        createdBy: 'user_123',
      });
      vi.mocked(prisma.featureFlag.create).mockResolvedValue(mockFlag);

      // Act
      const result = await createFlag({
        name: 'new_feature',
        description: 'New feature description',
        enabled: true,
        metadata: { category: 'beta' },
        createdBy: 'user_123',
      });

      // Assert
      expect(result).toEqual(mockFlag);
      expect(prisma.featureFlag.create).toHaveBeenCalledWith({
        data: {
          name: 'NEW_FEATURE',
          description: 'New feature description',
          enabled: true,
          metadata: { category: 'beta' },
          createdBy: 'user_123',
        },
      });
      expect(logger.info).toHaveBeenCalledWith('Feature flag created', {
        flag: 'NEW_FEATURE',
        enabled: true,
      });
    });

    it('should create flag with defaults when only name provided', async () => {
      // Arrange
      const mockFlag = createMockFlag({ name: 'SIMPLE_FLAG', enabled: false });
      vi.mocked(prisma.featureFlag.create).mockResolvedValue(mockFlag);

      // Act
      const result = await createFlag({ name: 'simple_flag' });

      // Assert
      expect(result).toEqual(mockFlag);
      expect(prisma.featureFlag.create).toHaveBeenCalledWith({
        data: {
          name: 'SIMPLE_FLAG',
          description: undefined,
          enabled: false,
          metadata: {},
          createdBy: undefined,
        },
      });
    });

    it('should throw on duplicate flag name', async () => {
      // Arrange
      const error = new Error('Unique constraint failed');
      vi.mocked(prisma.featureFlag.create).mockRejectedValue(error);

      // Act & Assert
      await expect(createFlag({ name: 'EXISTING_FLAG' })).rejects.toThrow(
        'Unique constraint failed'
      );
    });
  });

  describe('updateFlag', () => {
    it('should update flag properties', async () => {
      // Arrange
      const mockFlag = createMockFlag({
        description: 'Updated description',
        enabled: true,
        metadata: { version: 2 },
      });
      vi.mocked(prisma.featureFlag.update).mockResolvedValue(mockFlag);

      // Act
      const result = await updateFlag('flag_123', {
        description: 'Updated description',
        enabled: true,
        metadata: { version: 2 },
      });

      // Assert
      expect(result).toEqual(mockFlag);
      expect(prisma.featureFlag.update).toHaveBeenCalledWith({
        where: { id: 'flag_123' },
        data: {
          description: 'Updated description',
          enabled: true,
          metadata: { version: 2 },
        },
      });
      expect(logger.info).toHaveBeenCalledWith('Feature flag updated', {
        flag: mockFlag.name,
        id: 'flag_123',
      });
    });

    it('should update only specified fields', async () => {
      // Arrange
      const mockFlag = createMockFlag({ enabled: true });
      vi.mocked(prisma.featureFlag.update).mockResolvedValue(mockFlag);

      // Act
      await updateFlag('flag_123', { enabled: true });

      // Assert
      expect(prisma.featureFlag.update).toHaveBeenCalledWith({
        where: { id: 'flag_123' },
        data: {
          description: undefined,
          enabled: true,
          metadata: undefined,
        },
      });
    });

    it('should throw on invalid flag ID', async () => {
      // Arrange
      const error = new Error('Record not found');
      vi.mocked(prisma.featureFlag.update).mockRejectedValue(error);

      // Act & Assert
      await expect(updateFlag('invalid_id', { enabled: true })).rejects.toThrow('Record not found');
    });
  });

  describe('deleteFlag', () => {
    it('should delete flag by ID', async () => {
      // Arrange
      const mockFlag = createMockFlag();
      vi.mocked(prisma.featureFlag.delete).mockResolvedValue(mockFlag);

      // Act
      await deleteFlag('flag_123');

      // Assert
      expect(prisma.featureFlag.delete).toHaveBeenCalledWith({
        where: { id: 'flag_123' },
      });
      expect(logger.info).toHaveBeenCalledWith('Feature flag deleted', {
        flag: mockFlag.name,
        id: 'flag_123',
      });
    });

    it('should throw on invalid flag ID', async () => {
      // Arrange
      const error = new Error('Record not found');
      vi.mocked(prisma.featureFlag.delete).mockRejectedValue(error);

      // Act & Assert
      await expect(deleteFlag('invalid_id')).rejects.toThrow('Record not found');
    });
  });

  describe('seedDefaultFlags', () => {
    it('should create default flags that do not exist', async () => {
      // Arrange - All flags don't exist
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.featureFlag.create).mockImplementation(
        ({ data }) =>
          Promise.resolve(createMockFlag(data as Partial<FeatureFlag>)) as ReturnType<
            typeof prisma.featureFlag.create
          >
      );

      // Act
      await seedDefaultFlags();

      // Assert
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledTimes(DEFAULT_FLAGS.length);
      expect(prisma.featureFlag.create).toHaveBeenCalledTimes(DEFAULT_FLAGS.length);

      for (const flag of DEFAULT_FLAGS) {
        expect(prisma.featureFlag.findUnique).toHaveBeenCalledWith({
          where: { name: flag.name },
        });
        expect(prisma.featureFlag.create).toHaveBeenCalledWith({
          data: flag,
        });
        expect(logger.info).toHaveBeenCalledWith('Seeded default feature flag', {
          flag: flag.name,
        });
      }
    });

    it('should skip existing flags', async () => {
      // Arrange - Flag already exists
      vi.mocked(prisma.featureFlag.findUnique).mockResolvedValue(createMockFlag());

      // Act
      await seedDefaultFlags();

      // Assert
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledTimes(DEFAULT_FLAGS.length);
      expect(prisma.featureFlag.create).not.toHaveBeenCalled();
    });

    it('should handle mixed existing and new flags', async () => {
      // Arrange - First flag exists, rest don't
      vi.mocked(prisma.featureFlag.findUnique)
        .mockResolvedValueOnce(createMockFlag()) // First call returns existing
        .mockResolvedValue(null); // Rest return null

      vi.mocked(prisma.featureFlag.create).mockImplementation(
        ({ data }) =>
          Promise.resolve(createMockFlag(data as Partial<FeatureFlag>)) as ReturnType<
            typeof prisma.featureFlag.create
          >
      );

      // Act
      await seedDefaultFlags();

      // Assert
      expect(prisma.featureFlag.findUnique).toHaveBeenCalledTimes(DEFAULT_FLAGS.length);
      // Should only create for flags that didn't exist (all but first)
      expect(prisma.featureFlag.create).toHaveBeenCalledTimes(
        Math.max(0, DEFAULT_FLAGS.length - 1)
      );
    });
  });
});
