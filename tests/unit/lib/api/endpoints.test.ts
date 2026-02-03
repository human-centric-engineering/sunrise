/**
 * API Endpoints Constants Tests
 *
 * Tests for centralized API path constants used throughout the application.
 * Validates that all static paths and dynamic path generators are correct.
 *
 * Test Coverage:
 * - Static path constants (AUTH, USERS, ADMIN, PUBLIC)
 * - Dynamic path generators (byId, featureFlag)
 * - Path format validation (all start with /api/)
 * - ID interpolation with various formats
 */

import { describe, it, expect } from 'vitest';
import { API } from '@/lib/api/endpoints';

describe('API Endpoints', () => {
  describe('AUTH endpoints', () => {
    it('should have correct BASE path', () => {
      // Assert
      expect(API.AUTH.BASE).toBe('/api/auth');
    });

    it('should have correct SIGN_OUT path', () => {
      // Assert
      expect(API.AUTH.SIGN_OUT).toBe('/api/auth/sign-out');
    });

    it('should start with /api/', () => {
      // Assert
      expect(API.AUTH.BASE).toMatch(/^\/api\//);
      expect(API.AUTH.SIGN_OUT).toMatch(/^\/api\//);
    });

    it('should be strings', () => {
      // Assert
      expect(typeof API.AUTH.BASE).toBe('string');
      expect(typeof API.AUTH.SIGN_OUT).toBe('string');
    });
  });

  describe('USERS endpoints', () => {
    describe('static paths', () => {
      it('should have correct ME path', () => {
        // Assert
        expect(API.USERS.ME).toBe('/api/v1/users/me');
      });

      it('should have correct ME_PREFERENCES path', () => {
        // Assert
        expect(API.USERS.ME_PREFERENCES).toBe('/api/v1/users/me/preferences');
      });

      it('should have correct ME_AVATAR path', () => {
        // Assert
        expect(API.USERS.ME_AVATAR).toBe('/api/v1/users/me/avatar');
      });

      it('should have correct LIST path', () => {
        // Assert
        expect(API.USERS.LIST).toBe('/api/v1/users');
      });

      it('should have correct INVITE path', () => {
        // Assert
        expect(API.USERS.INVITE).toBe('/api/v1/users/invite');
      });

      it('should all start with /api/', () => {
        // Assert
        expect(API.USERS.ME).toMatch(/^\/api\//);
        expect(API.USERS.ME_PREFERENCES).toMatch(/^\/api\//);
        expect(API.USERS.ME_AVATAR).toMatch(/^\/api\//);
        expect(API.USERS.LIST).toMatch(/^\/api\//);
        expect(API.USERS.INVITE).toMatch(/^\/api\//);
      });

      it('should be strings', () => {
        // Assert
        expect(typeof API.USERS.ME).toBe('string');
        expect(typeof API.USERS.ME_PREFERENCES).toBe('string');
        expect(typeof API.USERS.ME_AVATAR).toBe('string');
        expect(typeof API.USERS.LIST).toBe('string');
        expect(typeof API.USERS.INVITE).toBe('string');
      });
    });

    describe('byId dynamic path', () => {
      it('should be a function', () => {
        // Assert
        expect(typeof API.USERS.byId).toBe('function');
      });

      it('should generate correct path with simple ID', () => {
        // Arrange
        const id = 'user123';

        // Act
        const path = API.USERS.byId(id);

        // Assert
        expect(path).toBe('/api/v1/users/user123');
      });

      it('should generate correct path with CUID', () => {
        // Arrange
        const cuid = 'clxyz123abc456def789';

        // Act
        const path = API.USERS.byId(cuid);

        // Assert
        expect(path).toBe('/api/v1/users/clxyz123abc456def789');
      });

      it('should generate correct path with UUID', () => {
        // Arrange
        const uuid = '123e4567-e89b-12d3-a456-426614174000';

        // Act
        const path = API.USERS.byId(uuid);

        // Assert
        expect(path).toBe('/api/v1/users/123e4567-e89b-12d3-a456-426614174000');
      });

      it('should generate correct path with numeric ID', () => {
        // Arrange
        const id = '12345';

        // Act
        const path = API.USERS.byId(id);

        // Assert
        expect(path).toBe('/api/v1/users/12345');
      });

      it('should handle single character ID', () => {
        // Arrange
        const id = '1';

        // Act
        const path = API.USERS.byId(id);

        // Assert
        expect(path).toBe('/api/v1/users/1');
      });

      it('should return string starting with /api/', () => {
        // Arrange
        const id = 'test-id';

        // Act
        const path = API.USERS.byId(id);

        // Assert
        expect(path).toMatch(/^\/api\//);
        expect(typeof path).toBe('string');
      });

      it('should handle special characters in ID', () => {
        // Arrange
        const id = 'user-123_abc';

        // Act
        const path = API.USERS.byId(id);

        // Assert
        expect(path).toBe('/api/v1/users/user-123_abc');
      });
    });
  });

  describe('ADMIN endpoints', () => {
    describe('static paths', () => {
      it('should have correct STATS path', () => {
        // Assert
        expect(API.ADMIN.STATS).toBe('/api/v1/admin/stats');
      });

      it('should have correct LOGS path', () => {
        // Assert
        expect(API.ADMIN.LOGS).toBe('/api/v1/admin/logs');
      });

      it('should have correct INVITATIONS path', () => {
        // Assert
        expect(API.ADMIN.INVITATIONS).toBe('/api/v1/admin/invitations');
      });

      it('should have correct FEATURE_FLAGS path', () => {
        // Assert
        expect(API.ADMIN.FEATURE_FLAGS).toBe('/api/v1/admin/feature-flags');
      });

      it('should all start with /api/', () => {
        // Assert
        expect(API.ADMIN.STATS).toMatch(/^\/api\//);
        expect(API.ADMIN.LOGS).toMatch(/^\/api\//);
        expect(API.ADMIN.INVITATIONS).toMatch(/^\/api\//);
        expect(API.ADMIN.FEATURE_FLAGS).toMatch(/^\/api\//);
      });

      it('should be strings', () => {
        // Assert
        expect(typeof API.ADMIN.STATS).toBe('string');
        expect(typeof API.ADMIN.LOGS).toBe('string');
        expect(typeof API.ADMIN.INVITATIONS).toBe('string');
        expect(typeof API.ADMIN.FEATURE_FLAGS).toBe('string');
      });
    });

    describe('featureFlag dynamic path', () => {
      it('should be a function', () => {
        // Assert
        expect(typeof API.ADMIN.featureFlag).toBe('function');
      });

      it('should generate correct path with simple ID', () => {
        // Arrange
        const id = 'dark-mode';

        // Act
        const path = API.ADMIN.featureFlag(id);

        // Assert
        expect(path).toBe('/api/v1/admin/feature-flags/dark-mode');
      });

      it('should generate correct path with CUID', () => {
        // Arrange
        const cuid = 'clxyz123abc456def789';

        // Act
        const path = API.ADMIN.featureFlag(cuid);

        // Assert
        expect(path).toBe('/api/v1/admin/feature-flags/clxyz123abc456def789');
      });

      it('should generate correct path with UUID', () => {
        // Arrange
        const uuid = '123e4567-e89b-12d3-a456-426614174000';

        // Act
        const path = API.ADMIN.featureFlag(uuid);

        // Assert
        expect(path).toBe('/api/v1/admin/feature-flags/123e4567-e89b-12d3-a456-426614174000');
      });

      it('should generate correct path with kebab-case ID', () => {
        // Arrange
        const id = 'new-user-onboarding';

        // Act
        const path = API.ADMIN.featureFlag(id);

        // Assert
        expect(path).toBe('/api/v1/admin/feature-flags/new-user-onboarding');
      });

      it('should generate correct path with snake_case ID', () => {
        // Arrange
        const id = 'enable_beta_features';

        // Act
        const path = API.ADMIN.featureFlag(id);

        // Assert
        expect(path).toBe('/api/v1/admin/feature-flags/enable_beta_features');
      });

      it('should return string starting with /api/', () => {
        // Arrange
        const id = 'test-flag';

        // Act
        const path = API.ADMIN.featureFlag(id);

        // Assert
        expect(path).toMatch(/^\/api\//);
        expect(typeof path).toBe('string');
      });

      it('should handle numeric ID', () => {
        // Arrange
        const id = '42';

        // Act
        const path = API.ADMIN.featureFlag(id);

        // Assert
        expect(path).toBe('/api/v1/admin/feature-flags/42');
      });
    });
  });

  describe('PUBLIC endpoints', () => {
    it('should have correct HEALTH path', () => {
      // Assert
      expect(API.PUBLIC.HEALTH).toBe('/api/health');
    });

    it('should have correct CONTACT path', () => {
      // Assert
      expect(API.PUBLIC.CONTACT).toBe('/api/v1/contact');
    });

    it('should have correct CSP_REPORT path', () => {
      // Assert
      expect(API.PUBLIC.CSP_REPORT).toBe('/api/v1/csp-report');
    });

    it('should all start with /api/', () => {
      // Assert
      expect(API.PUBLIC.HEALTH).toMatch(/^\/api\//);
      expect(API.PUBLIC.CONTACT).toMatch(/^\/api\//);
      expect(API.PUBLIC.CSP_REPORT).toMatch(/^\/api\//);
    });

    it('should be strings', () => {
      // Assert
      expect(typeof API.PUBLIC.HEALTH).toBe('string');
      expect(typeof API.PUBLIC.CONTACT).toBe('string');
      expect(typeof API.PUBLIC.CSP_REPORT).toBe('string');
    });
  });

  describe('API object structure', () => {
    it('should have all expected top-level keys', () => {
      // Assert
      expect(API).toHaveProperty('AUTH');
      expect(API).toHaveProperty('USERS');
      expect(API).toHaveProperty('ADMIN');
      expect(API).toHaveProperty('PUBLIC');
    });

    it('should have AUTH with expected properties', () => {
      // Assert
      expect(API.AUTH).toHaveProperty('BASE');
      expect(API.AUTH).toHaveProperty('SIGN_OUT');
    });

    it('should have USERS with expected properties', () => {
      // Assert
      expect(API.USERS).toHaveProperty('ME');
      expect(API.USERS).toHaveProperty('ME_PREFERENCES');
      expect(API.USERS).toHaveProperty('ME_AVATAR');
      expect(API.USERS).toHaveProperty('LIST');
      expect(API.USERS).toHaveProperty('INVITE');
      expect(API.USERS).toHaveProperty('byId');
    });

    it('should have ADMIN with expected properties', () => {
      // Assert
      expect(API.ADMIN).toHaveProperty('STATS');
      expect(API.ADMIN).toHaveProperty('LOGS');
      expect(API.ADMIN).toHaveProperty('INVITATIONS');
      expect(API.ADMIN).toHaveProperty('FEATURE_FLAGS');
      expect(API.ADMIN).toHaveProperty('featureFlag');
    });

    it('should have PUBLIC with expected properties', () => {
      // Assert
      expect(API.PUBLIC).toHaveProperty('HEALTH');
      expect(API.PUBLIC).toHaveProperty('CONTACT');
      expect(API.PUBLIC).toHaveProperty('CSP_REPORT');
    });
  });

  describe('versioning consistency', () => {
    it('should use /api/v1/ for versioned endpoints', () => {
      // Assert - USERS endpoints (except AUTH which uses /api/auth)
      expect(API.USERS.ME).toContain('/api/v1/');
      expect(API.USERS.ME_PREFERENCES).toContain('/api/v1/');
      expect(API.USERS.ME_AVATAR).toContain('/api/v1/');
      expect(API.USERS.LIST).toContain('/api/v1/');
      expect(API.USERS.INVITE).toContain('/api/v1/');
      expect(API.USERS.byId('123')).toContain('/api/v1/');

      // ADMIN endpoints
      expect(API.ADMIN.STATS).toContain('/api/v1/');
      expect(API.ADMIN.LOGS).toContain('/api/v1/');
      expect(API.ADMIN.INVITATIONS).toContain('/api/v1/');
      expect(API.ADMIN.FEATURE_FLAGS).toContain('/api/v1/');
      expect(API.ADMIN.featureFlag('123')).toContain('/api/v1/');

      // PUBLIC versioned endpoints
      expect(API.PUBLIC.CONTACT).toContain('/api/v1/');
      expect(API.PUBLIC.CSP_REPORT).toContain('/api/v1/');
    });

    it('should not use versioning for special endpoints', () => {
      // Assert - AUTH endpoints and HEALTH use /api/ without version
      expect(API.AUTH.BASE).toBe('/api/auth');
      expect(API.AUTH.SIGN_OUT).toBe('/api/auth/sign-out');
      expect(API.PUBLIC.HEALTH).toBe('/api/health');
    });
  });

  describe('real-world usage scenarios', () => {
    it('should work in typical client component fetch', () => {
      // Arrange
      const userId = 'clxyz123';

      // Act
      const userPath = API.USERS.byId(userId);
      const mePath = API.USERS.ME;

      // Assert
      expect(userPath).toBe('/api/v1/users/clxyz123');
      expect(mePath).toBe('/api/v1/users/me');
    });

    it('should work for admin operations', () => {
      // Arrange
      const featureFlagId = 'dark-mode';

      // Act
      const flagPath = API.ADMIN.featureFlag(featureFlagId);
      const statsPath = API.ADMIN.STATS;

      // Assert
      expect(flagPath).toBe('/api/v1/admin/feature-flags/dark-mode');
      expect(statsPath).toBe('/api/v1/admin/stats');
    });

    it('should work for authentication flows', () => {
      // Act
      const authBase = API.AUTH.BASE;
      const signOut = API.AUTH.SIGN_OUT;

      // Assert
      expect(authBase).toBe('/api/auth');
      expect(signOut).toBe('/api/auth/sign-out');
    });

    it('should work for health checks and monitoring', () => {
      // Act
      const health = API.PUBLIC.HEALTH;

      // Assert
      expect(health).toBe('/api/health');
    });
  });
});
