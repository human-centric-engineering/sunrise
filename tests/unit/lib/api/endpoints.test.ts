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

  describe('INVITATIONS endpoints', () => {
    it('should have correct METADATA path', () => {
      expect(API.INVITATIONS.METADATA).toBe('/api/v1/invitations/metadata');
    });

    it('should start with /api/', () => {
      expect(API.INVITATIONS.METADATA).toMatch(/^\/api\//);
    });
  });

  describe('ADMIN.invitationByEmail dynamic path', () => {
    it('should generate correct path with simple email', () => {
      const path = API.ADMIN.invitationByEmail('user@example.com');
      expect(path).toBe('/api/v1/admin/invitations/user%40example.com');
    });

    it('should encode special characters in email', () => {
      const path = API.ADMIN.invitationByEmail('user+test@example.com');
      expect(path).toBe('/api/v1/admin/invitations/user%2Btest%40example.com');
    });

    it('should return string starting with /api/', () => {
      const path = API.ADMIN.invitationByEmail('test@test.com');
      expect(path).toMatch(/^\/api\//);
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
      expect(API.PUBLIC.CSP_REPORT).toBe('/api/csp-report');
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
    });

    it('should not use versioning for special endpoints', () => {
      // Assert - AUTH endpoints, HEALTH, and CSP_REPORT use /api/ without version
      expect(API.AUTH.BASE).toBe('/api/auth');
      expect(API.AUTH.SIGN_OUT).toBe('/api/auth/sign-out');
      expect(API.PUBLIC.HEALTH).toBe('/api/health');
      expect(API.PUBLIC.CSP_REPORT).toBe('/api/csp-report');
    });
  });

  describe('ORCHESTRATION endpoints', () => {
    it('should have correct static paths', () => {
      expect(API.ADMIN.ORCHESTRATION.AGENTS).toBe('/api/v1/admin/orchestration/agents');
      expect(API.ADMIN.ORCHESTRATION.CAPABILITIES).toBe('/api/v1/admin/orchestration/capabilities');
      expect(API.ADMIN.ORCHESTRATION.PROVIDERS).toBe('/api/v1/admin/orchestration/providers');
      expect(API.ADMIN.ORCHESTRATION.WORKFLOWS).toBe('/api/v1/admin/orchestration/workflows');
      expect(API.ADMIN.ORCHESTRATION.CHAT_STREAM).toBe('/api/v1/admin/orchestration/chat/stream');
      expect(API.ADMIN.ORCHESTRATION.CONVERSATIONS).toBe(
        '/api/v1/admin/orchestration/conversations'
      );
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_DOCUMENTS).toBe(
        '/api/v1/admin/orchestration/knowledge/documents'
      );
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEARCH).toBe(
        '/api/v1/admin/orchestration/knowledge/search'
      );
      expect(API.ADMIN.ORCHESTRATION.COSTS).toBe('/api/v1/admin/orchestration/costs');
      expect(API.ADMIN.ORCHESTRATION.SETTINGS).toBe('/api/v1/admin/orchestration/settings');
    });

    it('should generate correct dynamic workflow paths', () => {
      const id = 'wf-123';
      expect(API.ADMIN.ORCHESTRATION.workflowById(id)).toBe(
        '/api/v1/admin/orchestration/workflows/wf-123'
      );
      expect(API.ADMIN.ORCHESTRATION.workflowValidate(id)).toBe(
        '/api/v1/admin/orchestration/workflows/wf-123/validate'
      );
      expect(API.ADMIN.ORCHESTRATION.workflowExecute(id)).toBe(
        '/api/v1/admin/orchestration/workflows/wf-123/execute'
      );
    });

    it('should generate correct dynamic execution paths', () => {
      const id = 'exec-456';
      expect(API.ADMIN.ORCHESTRATION.executionById(id)).toBe(
        '/api/v1/admin/orchestration/executions/exec-456'
      );
      expect(API.ADMIN.ORCHESTRATION.executionApprove(id)).toBe(
        '/api/v1/admin/orchestration/executions/exec-456/approve'
      );
    });

    it('should generate correct dynamic knowledge paths', () => {
      const id = 'doc-789';
      expect(API.ADMIN.ORCHESTRATION.knowledgeDocumentById(id)).toBe(
        '/api/v1/admin/orchestration/knowledge/documents/doc-789'
      );
      expect(API.ADMIN.ORCHESTRATION.knowledgeDocumentRechunk(id)).toBe(
        '/api/v1/admin/orchestration/knowledge/documents/doc-789/rechunk'
      );
      expect(API.ADMIN.ORCHESTRATION.knowledgePatternByNumber(14)).toBe(
        '/api/v1/admin/orchestration/knowledge/patterns/14'
      );
    });

    it('should generate correct dynamic agent paths', () => {
      const id = 'agent-abc';
      expect(API.ADMIN.ORCHESTRATION.agentById(id)).toBe(
        '/api/v1/admin/orchestration/agents/agent-abc'
      );
      expect(API.ADMIN.ORCHESTRATION.agentBudget(id)).toBe(
        '/api/v1/admin/orchestration/agents/agent-abc/budget'
      );
      expect(API.ADMIN.ORCHESTRATION.agentCapabilities(id)).toBe(
        '/api/v1/admin/orchestration/agents/agent-abc/capabilities'
      );
      expect(API.ADMIN.ORCHESTRATION.agentCapabilityById(id, 'cap-1')).toBe(
        '/api/v1/admin/orchestration/agents/agent-abc/capabilities/cap-1'
      );
    });

    it('should generate correct dynamic provider paths', () => {
      const id = 'prov-xyz';
      expect(API.ADMIN.ORCHESTRATION.providerById(id)).toBe(
        '/api/v1/admin/orchestration/providers/prov-xyz'
      );
      expect(API.ADMIN.ORCHESTRATION.providerTest(id)).toBe(
        '/api/v1/admin/orchestration/providers/prov-xyz/test'
      );
      expect(API.ADMIN.ORCHESTRATION.providerModels(id)).toBe(
        '/api/v1/admin/orchestration/providers/prov-xyz/models'
      );
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

  // ─── New coverage blocks ──────────────────────────────────────────────────

  describe('ORCHESTRATION dynamic paths — broad coverage', () => {
    const agentId = 'agent-1';
    const capId = 'cap-1';
    const providerId = 'prov-1';
    const workflowId = 'wf-1';
    const scheduleId = 'sched-1';
    const execId = 'exec-1';
    const convId = 'conv-1';
    const docId = 'doc-1';
    const webhookId = 'wh-1';
    const deliveryId = 'del-1';
    const evalId = 'eval-1';
    const toolId = 'tool-1';
    const resourceId = 'res-1';
    const keyId = 'key-1';
    const sessionId = 'sess-1';
    const versionId = 'ver-1';
    const tokenId = 'tok-1';

    it('agentClone produces correct path', () => {
      // Arrange/Act
      const path = API.ADMIN.ORCHESTRATION.agentClone(agentId);
      // Assert
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/clone');
    });

    it('agentCapabilitiesUsage produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentCapabilitiesUsage(agentId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/capabilities/usage');
    });

    it('agentInstructionsHistory produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentInstructionsHistory(agentId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/instructions-history');
    });

    it('agentInstructionsRevert produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentInstructionsRevert(agentId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/instructions-revert');
    });

    it('agentInviteTokens produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentInviteTokens(agentId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/invite-tokens');
    });

    it('agentInviteTokenById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentInviteTokenById(agentId, tokenId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/invite-tokens/tok-1');
    });

    it('agentVersions produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentVersions(agentId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/versions');
    });

    it('agentVersionRestore produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.agentVersionRestore(agentId, versionId);
      expect(path).toBe('/api/v1/admin/orchestration/agents/agent-1/versions/ver-1/restore');
    });

    it('capabilityById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.capabilityById(capId);
      expect(path).toBe('/api/v1/admin/orchestration/capabilities/cap-1');
    });

    it('capabilityAgents produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.capabilityAgents(capId);
      expect(path).toBe('/api/v1/admin/orchestration/capabilities/cap-1/agents');
    });

    it('capabilityStats produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.capabilityStats(capId);
      expect(path).toBe('/api/v1/admin/orchestration/capabilities/cap-1/stats');
    });

    it('providerModelById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.providerModelById('gpt-4o');
      expect(path).toBe('/api/v1/admin/orchestration/provider-models/gpt-4o');
    });

    it('providerTestModel produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.providerTestModel(providerId);
      expect(path).toBe('/api/v1/admin/orchestration/providers/prov-1/test-model');
    });

    it('providerHealth produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.providerHealth(providerId);
      expect(path).toBe('/api/v1/admin/orchestration/providers/prov-1/health');
    });

    it('workflowSchedules produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowSchedules(workflowId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/schedules');
    });

    it('workflowScheduleById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowScheduleById(workflowId, scheduleId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/schedules/sched-1');
    });

    it('workflowDryRun produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowDryRun(workflowId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/dry-run');
    });

    it('workflowExecuteStream produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowExecuteStream(workflowId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/execute-stream');
    });

    it('workflowSaveAsTemplate produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowSaveAsTemplate(workflowId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/save-as-template');
    });

    it('executionCancel produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.executionCancel(execId);
      expect(path).toBe('/api/v1/admin/orchestration/executions/exec-1/cancel');
    });

    it('executionRetryStep produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.executionRetryStep(execId);
      expect(path).toBe('/api/v1/admin/orchestration/executions/exec-1/retry-step');
    });

    it('workflowDefinitionHistory produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowDefinitionHistory(workflowId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/definition-history');
    });

    it('workflowDefinitionRevert produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowDefinitionRevert(workflowId);
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf-1/definition-revert');
    });

    it('conversationById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.conversationById(convId);
      expect(path).toBe('/api/v1/admin/orchestration/conversations/conv-1');
    });

    it('conversationMessages produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.conversationMessages(convId);
      expect(path).toBe('/api/v1/admin/orchestration/conversations/conv-1/messages');
    });

    it('knowledgeDocumentRetry produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.knowledgeDocumentRetry(docId);
      expect(path).toBe('/api/v1/admin/orchestration/knowledge/documents/doc-1/retry');
    });

    it('knowledgeDocumentConfirm produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.knowledgeDocumentConfirm(docId);
      expect(path).toBe('/api/v1/admin/orchestration/knowledge/documents/doc-1/confirm');
    });

    it('knowledgeDocumentChunks produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.knowledgeDocumentChunks(docId);
      expect(path).toBe('/api/v1/admin/orchestration/knowledge/documents/doc-1/chunks');
    });

    it('webhookById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.webhookById(webhookId);
      expect(path).toBe('/api/v1/admin/orchestration/webhooks/wh-1');
    });

    it('webhookDeliveries produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.webhookDeliveries(webhookId);
      expect(path).toBe('/api/v1/admin/orchestration/webhooks/wh-1/deliveries');
    });

    it('webhookTest produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.webhookTest(webhookId);
      expect(path).toBe('/api/v1/admin/orchestration/webhooks/wh-1/test');
    });

    it('retryDelivery produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.retryDelivery(deliveryId);
      expect(path).toBe('/api/v1/admin/orchestration/webhooks/deliveries/del-1/retry');
    });

    it('evaluationById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.evaluationById(evalId);
      expect(path).toBe('/api/v1/admin/orchestration/evaluations/eval-1');
    });

    it('evaluationComplete produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.evaluationComplete(evalId);
      expect(path).toBe('/api/v1/admin/orchestration/evaluations/eval-1/complete');
    });

    it('evaluationLogs produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.evaluationLogs(evalId);
      expect(path).toBe('/api/v1/admin/orchestration/evaluations/eval-1/logs');
    });

    it('mcpToolById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.mcpToolById(toolId);
      expect(path).toBe('/api/v1/admin/orchestration/mcp/tools/tool-1');
    });

    it('mcpResourceById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.mcpResourceById(resourceId);
      expect(path).toBe('/api/v1/admin/orchestration/mcp/resources/res-1');
    });

    it('mcpKeyById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.mcpKeyById(keyId);
      expect(path).toBe('/api/v1/admin/orchestration/mcp/keys/key-1');
    });

    it('mcpKeyRotate produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.mcpKeyRotate(keyId);
      expect(path).toBe('/api/v1/admin/orchestration/mcp/keys/key-1/rotate');
    });

    it('mcpSessionById produces correct path', () => {
      const path = API.ADMIN.ORCHESTRATION.mcpSessionById(sessionId);
      expect(path).toBe('/api/v1/admin/orchestration/mcp/sessions/sess-1');
    });
  });

  describe('ORCHESTRATION static constants', () => {
    it('AGENTS_BULK equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.AGENTS_BULK).toBe('/api/v1/admin/orchestration/agents/bulk');
    });

    it('AGENTS_COMPARE equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.AGENTS_COMPARE).toBe(
        '/api/v1/admin/orchestration/agents/compare'
      );
    });

    it('AGENTS_EXPORT equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.AGENTS_EXPORT).toBe(
        '/api/v1/admin/orchestration/agents/export'
      );
    });

    it('AGENTS_IMPORT equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.AGENTS_IMPORT).toBe(
        '/api/v1/admin/orchestration/agents/import'
      );
    });

    it('PROVIDER_MODELS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.PROVIDER_MODELS).toBe(
        '/api/v1/admin/orchestration/provider-models'
      );
    });

    it('PROVIDER_MODEL_RECOMMEND equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.PROVIDER_MODEL_RECOMMEND).toBe(
        '/api/v1/admin/orchestration/provider-models/recommend'
      );
    });

    it('MODELS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MODELS).toBe('/api/v1/admin/orchestration/models');
    });

    it('EXECUTIONS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.EXECUTIONS).toBe('/api/v1/admin/orchestration/executions');
    });

    it('CONVERSATIONS_CLEAR equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.CONVERSATIONS_CLEAR).toBe(
        '/api/v1/admin/orchestration/conversations/clear'
      );
    });

    it('CONVERSATIONS_EXPORT equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.CONVERSATIONS_EXPORT).toBe(
        '/api/v1/admin/orchestration/conversations/export'
      );
    });

    it('KNOWLEDGE_GRAPH equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_GRAPH).toBe(
        '/api/v1/admin/orchestration/knowledge/graph'
      );
    });

    it('KNOWLEDGE_PATTERNS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_PATTERNS).toBe(
        '/api/v1/admin/orchestration/knowledge/patterns'
      );
    });

    it('KNOWLEDGE_SEED equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_SEED).toBe(
        '/api/v1/admin/orchestration/knowledge/seed'
      );
    });

    it('EMBEDDING_MODELS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.EMBEDDING_MODELS).toBe(
        '/api/v1/admin/orchestration/embedding-models'
      );
    });

    it('KNOWLEDGE_EMBED equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBED).toBe(
        '/api/v1/admin/orchestration/knowledge/embed'
      );
    });

    it('KNOWLEDGE_EMBEDDING_STATUS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_EMBEDDING_STATUS).toBe(
        '/api/v1/admin/orchestration/knowledge/embedding-status'
      );
    });

    it('KNOWLEDGE_META_TAGS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.KNOWLEDGE_META_TAGS).toBe(
        '/api/v1/admin/orchestration/knowledge/meta-tags'
      );
    });

    it('WEBHOOKS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.WEBHOOKS).toBe('/api/v1/admin/orchestration/webhooks');
    });

    it('COSTS_SUMMARY equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.COSTS_SUMMARY).toBe(
        '/api/v1/admin/orchestration/costs/summary'
      );
    });

    it('COSTS_ALERTS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.COSTS_ALERTS).toBe('/api/v1/admin/orchestration/costs/alerts');
    });

    it('ANALYTICS_TOPICS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.ANALYTICS_TOPICS).toBe(
        '/api/v1/admin/orchestration/analytics/topics'
      );
    });

    it('ANALYTICS_UNANSWERED equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.ANALYTICS_UNANSWERED).toBe(
        '/api/v1/admin/orchestration/analytics/unanswered'
      );
    });

    it('ANALYTICS_ENGAGEMENT equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.ANALYTICS_ENGAGEMENT).toBe(
        '/api/v1/admin/orchestration/analytics/engagement'
      );
    });

    it('ANALYTICS_CONTENT_GAPS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.ANALYTICS_CONTENT_GAPS).toBe(
        '/api/v1/admin/orchestration/analytics/content-gaps'
      );
    });

    it('ANALYTICS_FEEDBACK equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.ANALYTICS_FEEDBACK).toBe(
        '/api/v1/admin/orchestration/analytics/feedback'
      );
    });

    it('MAINTENANCE_TICK equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MAINTENANCE_TICK).toBe(
        '/api/v1/admin/orchestration/maintenance/tick'
      );
    });

    it('EVALUATIONS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.EVALUATIONS).toBe('/api/v1/admin/orchestration/evaluations');
    });

    it('OBSERVABILITY_DASHBOARD_STATS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.OBSERVABILITY_DASHBOARD_STATS).toBe(
        '/api/v1/admin/orchestration/observability/dashboard-stats'
      );
    });

    it('QUIZ_SCORES equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.QUIZ_SCORES).toBe('/api/v1/admin/orchestration/quiz-scores');
    });

    it('MCP_SETTINGS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MCP_SETTINGS).toBe('/api/v1/admin/orchestration/mcp/settings');
    });

    it('MCP_TOOLS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MCP_TOOLS).toBe('/api/v1/admin/orchestration/mcp/tools');
    });

    it('MCP_RESOURCES equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MCP_RESOURCES).toBe(
        '/api/v1/admin/orchestration/mcp/resources'
      );
    });

    it('MCP_KEYS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MCP_KEYS).toBe('/api/v1/admin/orchestration/mcp/keys');
    });

    it('MCP_AUDIT equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MCP_AUDIT).toBe('/api/v1/admin/orchestration/mcp/audit');
    });

    it('MCP_SESSIONS equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.MCP_SESSIONS).toBe('/api/v1/admin/orchestration/mcp/sessions');
    });

    it('AUDIT_LOG equals expected path', () => {
      expect(API.ADMIN.ORCHESTRATION.AUDIT_LOG).toBe('/api/v1/admin/orchestration/audit-log');
    });
  });

  describe('CHAT endpoints', () => {
    it('AGENTS equals expected path', () => {
      expect(API.CHAT.AGENTS).toBe('/api/v1/chat/agents');
    });

    it('STREAM equals expected path', () => {
      expect(API.CHAT.STREAM).toBe('/api/v1/chat/stream');
    });

    it('CONVERSATIONS equals expected path', () => {
      expect(API.CHAT.CONVERSATIONS).toBe('/api/v1/chat/conversations');
    });

    it('CONVERSATIONS_SEARCH equals expected path', () => {
      expect(API.CHAT.CONVERSATIONS_SEARCH).toBe('/api/v1/chat/conversations/search');
    });

    it('conversationById produces correct path', () => {
      // Arrange/Act
      const path = API.CHAT.conversationById('c-1');
      // Assert
      expect(path).toBe('/api/v1/chat/conversations/c-1');
    });

    it('conversationMessages produces correct path', () => {
      const path = API.CHAT.conversationMessages('c-1');
      expect(path).toBe('/api/v1/chat/conversations/c-1/messages');
    });

    it('validateToken produces correct path', () => {
      const path = API.CHAT.validateToken('my-slug');
      expect(path).toBe('/api/v1/chat/agents/my-slug/validate-token');
    });
  });

  describe('WEBHOOKS trigger', () => {
    it('trigger produces correct path', () => {
      // Arrange/Act
      const path = API.WEBHOOKS.trigger('my-slug');
      // Assert
      expect(path).toBe('/api/v1/webhooks/trigger/my-slug');
    });
  });

  describe('ORCHESTRATION dynamic paths — URL-significant character behaviour', () => {
    // These tests document the CURRENT behaviour: builders do NOT encode segments.
    // Callers are responsible for passing clean IDs. Do not change the expected
    // values without updating the callers accordingly.

    it('agentCapabilityById — slashes in args are NOT encoded (raw interpolation)', () => {
      // Arrange — IDs containing "/" would break routing if sent to a real server,
      // but the builder does not encode them. This test documents that contract.
      const path = API.ADMIN.ORCHESTRATION.agentCapabilityById('a/b', 'c/d');
      // Assert — raw slash passes through, no %2F encoding
      expect(path).toBe('/api/v1/admin/orchestration/agents/a/b/capabilities/c/d');
    });

    it('workflowScheduleById — question marks in args are NOT encoded (raw interpolation)', () => {
      const path = API.ADMIN.ORCHESTRATION.workflowScheduleById('wf?x=1', 'sched?y=2');
      // Assert — raw "?" passes through
      expect(path).toBe('/api/v1/admin/orchestration/workflows/wf?x=1/schedules/sched?y=2');
    });

    it('agentVersionRestore — slashes in args are NOT encoded (raw interpolation)', () => {
      const path = API.ADMIN.ORCHESTRATION.agentVersionRestore('ag/1', 'v/2');
      expect(path).toBe('/api/v1/admin/orchestration/agents/ag/1/versions/v/2/restore');
    });

    it('invitationByEmail — @ and + ARE encoded via encodeURIComponent', () => {
      // invitationByEmail uses encodeURIComponent — this is the intentional exception
      const path = API.ADMIN.invitationByEmail('user+tag@example.com');
      expect(path).toBe('/api/v1/admin/invitations/user%2Btag%40example.com');
    });

    it('invitationByEmail — slash in local-part IS encoded via encodeURIComponent', () => {
      // encodeURIComponent encodes "/" as %2F, unlike the raw-interpolation builders
      const path = API.ADMIN.invitationByEmail('user/name@example.com');
      expect(path).toBe('/api/v1/admin/invitations/user%2Fname%40example.com');
    });
  });
});
