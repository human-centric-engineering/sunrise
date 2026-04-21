import { describe, it, expect, vi } from 'vitest';

// Suppress any transitive logger imports
vi.mock('@/lib/logging', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import {
  updateMcpSettingsSchema,
  createExposedToolSchema,
  updateExposedToolSchema,
  createApiKeySchema,
  updateApiKeySchema,
  mcpAuditQuerySchema,
  jsonRpcRequestSchema,
  mcpToolCallParamsSchema,
  mcpResourceReadParamsSchema,
  mcpPromptGetParamsSchema,
  listExposedToolsQuerySchema,
  listExposedResourcesQuerySchema,
  listApiKeysQuerySchema,
  createExposedResourceSchema,
  updateExposedResourceSchema,
} from '@/lib/validations/mcp';

// ---------------------------------------------------------------------------
// Shared test data
// ---------------------------------------------------------------------------

const VALID_CUID = 'clhjkv4xb000008l60m0b6fxt';
const FUTURE_DATE = new Date(Date.now() + 86_400_000); // +1 day
const PAST_DATE = new Date(Date.now() - 86_400_000); // -1 day

// ---------------------------------------------------------------------------
// updateMcpSettingsSchema
// ---------------------------------------------------------------------------

describe('updateMcpSettingsSchema', () => {
  it('accepts a valid partial update with isEnabled', () => {
    expect(updateMcpSettingsSchema.safeParse({ isEnabled: true }).success).toBe(true);
  });

  it('accepts serverName within limit', () => {
    expect(updateMcpSettingsSchema.safeParse({ serverName: 'My MCP Server' }).success).toBe(true);
  });

  it('accepts serverVersion', () => {
    expect(updateMcpSettingsSchema.safeParse({ serverVersion: '2.0.0' }).success).toBe(true);
  });

  it('accepts maxSessionsPerKey within range', () => {
    expect(updateMcpSettingsSchema.safeParse({ maxSessionsPerKey: 10 }).success).toBe(true);
  });

  it('accepts globalRateLimit within range', () => {
    expect(updateMcpSettingsSchema.safeParse({ globalRateLimit: 500 }).success).toBe(true);
  });

  it('accepts auditRetentionDays at zero', () => {
    expect(updateMcpSettingsSchema.safeParse({ auditRetentionDays: 0 }).success).toBe(true);
  });

  it('accepts all fields together', () => {
    const input = {
      isEnabled: false,
      serverName: 'Test',
      serverVersion: '1.0.0',
      maxSessionsPerKey: 5,
      globalRateLimit: 60,
      auditRetentionDays: 90,
    };
    expect(updateMcpSettingsSchema.safeParse(input).success).toBe(true);
  });

  it('rejects an empty object (at least one field required)', () => {
    expect(updateMcpSettingsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects serverName exceeding 100 chars', () => {
    expect(updateMcpSettingsSchema.safeParse({ serverName: 'a'.repeat(101) }).success).toBe(false);
  });

  it('rejects maxSessionsPerKey below 1', () => {
    expect(updateMcpSettingsSchema.safeParse({ maxSessionsPerKey: 0 }).success).toBe(false);
  });

  it('rejects maxSessionsPerKey above 100', () => {
    expect(updateMcpSettingsSchema.safeParse({ maxSessionsPerKey: 101 }).success).toBe(false);
  });

  it('rejects globalRateLimit above 10000', () => {
    expect(updateMcpSettingsSchema.safeParse({ globalRateLimit: 10001 }).success).toBe(false);
  });

  it('rejects auditRetentionDays above 3650', () => {
    expect(updateMcpSettingsSchema.safeParse({ auditRetentionDays: 3651 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createExposedToolSchema
// ---------------------------------------------------------------------------

describe('createExposedToolSchema', () => {
  const validInput = {
    capabilityId: VALID_CUID,
  };

  it('accepts minimal valid input', () => {
    expect(createExposedToolSchema.safeParse(validInput).success).toBe(true);
  });

  it('defaults isEnabled to false', () => {
    const result = createExposedToolSchema.safeParse(validInput);
    expect(result.success && result.data.isEnabled).toBe(false);
  });

  it('accepts a valid customName', () => {
    expect(
      createExposedToolSchema.safeParse({ ...validInput, customName: 'search_kb' }).success
    ).toBe(true);
  });

  it('accepts a null customName', () => {
    expect(createExposedToolSchema.safeParse({ ...validInput, customName: null }).success).toBe(
      true
    );
  });

  it('rejects customName starting with a digit', () => {
    expect(
      createExposedToolSchema.safeParse({ ...validInput, customName: '1invalid' }).success
    ).toBe(false);
  });

  it('rejects customName with uppercase letters', () => {
    expect(createExposedToolSchema.safeParse({ ...validInput, customName: 'Search' }).success).toBe(
      false
    );
  });

  it('rejects customName with hyphens', () => {
    expect(
      createExposedToolSchema.safeParse({ ...validInput, customName: 'search-kb' }).success
    ).toBe(false);
  });

  it('rejects missing capabilityId', () => {
    expect(createExposedToolSchema.safeParse({}).success).toBe(false);
  });

  it('rejects invalid capabilityId format', () => {
    expect(createExposedToolSchema.safeParse({ capabilityId: 'not-a-cuid' }).success).toBe(false);
  });

  it('accepts rateLimitPerKey within valid range', () => {
    expect(createExposedToolSchema.safeParse({ ...validInput, rateLimitPerKey: 100 }).success).toBe(
      true
    );
  });

  it('rejects rateLimitPerKey above 10000', () => {
    expect(
      createExposedToolSchema.safeParse({ ...validInput, rateLimitPerKey: 10001 }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateExposedToolSchema
// ---------------------------------------------------------------------------

describe('updateExposedToolSchema', () => {
  it('accepts a valid partial update with isEnabled', () => {
    expect(updateExposedToolSchema.safeParse({ isEnabled: true }).success).toBe(true);
  });

  it('accepts a valid customName', () => {
    expect(updateExposedToolSchema.safeParse({ customName: 'my_tool' }).success).toBe(true);
  });

  it('accepts null customName', () => {
    expect(updateExposedToolSchema.safeParse({ customName: null }).success).toBe(true);
  });

  it('rejects an empty object (at least one field required)', () => {
    expect(updateExposedToolSchema.safeParse({}).success).toBe(false);
  });

  it('rejects customName with uppercase', () => {
    expect(updateExposedToolSchema.safeParse({ customName: 'MyTool' }).success).toBe(false);
  });

  it('accepts rateLimitPerKey within range', () => {
    expect(updateExposedToolSchema.safeParse({ rateLimitPerKey: 50 }).success).toBe(true);
  });

  it('rejects rateLimitPerKey of 0', () => {
    expect(updateExposedToolSchema.safeParse({ rateLimitPerKey: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createApiKeySchema
// ---------------------------------------------------------------------------

describe('createApiKeySchema', () => {
  const validInput = {
    name: 'My API Key',
    scopes: ['tools:list'],
  };

  it('accepts minimal valid input', () => {
    expect(createApiKeySchema.safeParse(validInput).success).toBe(true);
  });

  it('accepts all valid scopes', () => {
    const input = {
      ...validInput,
      scopes: ['tools:list', 'tools:execute', 'resources:read', 'prompts:read'],
    };
    expect(createApiKeySchema.safeParse(input).success).toBe(true);
  });

  it('accepts a future expiresAt', () => {
    expect(createApiKeySchema.safeParse({ ...validInput, expiresAt: FUTURE_DATE }).success).toBe(
      true
    );
  });

  it('rejects a past expiresAt', () => {
    expect(createApiKeySchema.safeParse({ ...validInput, expiresAt: PAST_DATE }).success).toBe(
      false
    );
  });

  it('accepts null expiresAt', () => {
    expect(createApiKeySchema.safeParse({ ...validInput, expiresAt: null }).success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(createApiKeySchema.safeParse({ scopes: ['tools:list'] }).success).toBe(false);
  });

  it('rejects empty scopes array', () => {
    expect(createApiKeySchema.safeParse({ name: 'Key', scopes: [] }).success).toBe(false);
  });

  it('rejects invalid scope value', () => {
    expect(createApiKeySchema.safeParse({ name: 'Key', scopes: ['invalid:scope'] }).success).toBe(
      false
    );
  });

  it('rejects duplicate scopes', () => {
    expect(
      createApiKeySchema.safeParse({ name: 'Key', scopes: ['tools:list', 'tools:list'] }).success
    ).toBe(false);
  });

  it('accepts rateLimitOverride within range', () => {
    expect(createApiKeySchema.safeParse({ ...validInput, rateLimitOverride: 100 }).success).toBe(
      true
    );
  });

  it('rejects rateLimitOverride above 10000', () => {
    expect(createApiKeySchema.safeParse({ ...validInput, rateLimitOverride: 10001 }).success).toBe(
      false
    );
  });

  it('rejects name exceeding 100 chars', () => {
    expect(
      createApiKeySchema.safeParse({ name: 'a'.repeat(101), scopes: ['tools:list'] }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateApiKeySchema
// ---------------------------------------------------------------------------

describe('updateApiKeySchema', () => {
  it('accepts a valid name update', () => {
    expect(updateApiKeySchema.safeParse({ name: 'New Name' }).success).toBe(true);
  });

  it('accepts isActive toggle', () => {
    expect(updateApiKeySchema.safeParse({ isActive: false }).success).toBe(true);
  });

  it('accepts null expiresAt', () => {
    expect(updateApiKeySchema.safeParse({ expiresAt: null }).success).toBe(true);
  });

  it('rejects an empty object (at least one field required)', () => {
    expect(updateApiKeySchema.safeParse({}).success).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    expect(updateApiKeySchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('accepts rateLimitOverride within range', () => {
    expect(updateApiKeySchema.safeParse({ rateLimitOverride: 200 }).success).toBe(true);
  });

  it('rejects rateLimitOverride of 0', () => {
    expect(updateApiKeySchema.safeParse({ rateLimitOverride: 0 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcpAuditQuerySchema
// ---------------------------------------------------------------------------

describe('mcpAuditQuerySchema', () => {
  it('accepts empty object (all optional)', () => {
    expect(mcpAuditQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts valid method filter', () => {
    expect(mcpAuditQuerySchema.safeParse({ method: 'tools/call' }).success).toBe(true);
  });

  it('accepts valid responseCode', () => {
    expect(mcpAuditQuerySchema.safeParse({ responseCode: 'success' }).success).toBe(true);
    expect(mcpAuditQuerySchema.safeParse({ responseCode: 'error' }).success).toBe(true);
    expect(mcpAuditQuerySchema.safeParse({ responseCode: 'rate_limited' }).success).toBe(true);
  });

  it('rejects invalid responseCode', () => {
    expect(mcpAuditQuerySchema.safeParse({ responseCode: 'unknown' }).success).toBe(false);
  });

  it('accepts valid apiKeyId cuid', () => {
    expect(mcpAuditQuerySchema.safeParse({ apiKeyId: VALID_CUID }).success).toBe(true);
  });

  it('rejects invalid apiKeyId', () => {
    expect(mcpAuditQuerySchema.safeParse({ apiKeyId: 'not-a-cuid' }).success).toBe(false);
  });

  it('applies default pagination values', () => {
    const result = mcpAuditQuerySchema.safeParse({});
    expect(result.success && result.data.page).toBe(1);
    expect(result.success && result.data.limit).toBe(10);
  });

  it('accepts dateFrom and dateTo', () => {
    expect(
      mcpAuditQuerySchema.safeParse({
        dateFrom: new Date('2024-01-01').toISOString(),
        dateTo: new Date('2024-12-31').toISOString(),
      }).success
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// jsonRpcRequestSchema
// ---------------------------------------------------------------------------

describe('jsonRpcRequestSchema', () => {
  it('accepts a valid minimal JSON-RPC request', () => {
    expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', method: 'tools/list' }).success).toBe(
      true
    );
  });

  it('accepts a request with id and params', () => {
    const input = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_kb' },
    };
    expect(jsonRpcRequestSchema.safeParse(input).success).toBe(true);
  });

  it('accepts null id', () => {
    expect(
      jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: null, method: 'ping' }).success
    ).toBe(true);
  });

  it('accepts string id', () => {
    expect(
      jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', id: 'req-1', method: 'ping' }).success
    ).toBe(true);
  });

  it('rejects wrong jsonrpc version', () => {
    expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '1.0', method: 'tools/list' }).success).toBe(
      false
    );
  });

  it('rejects missing method', () => {
    expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0' }).success).toBe(false);
  });

  it('rejects empty method string', () => {
    expect(jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', method: '' }).success).toBe(false);
  });

  it('rejects method exceeding 100 chars', () => {
    expect(
      jsonRpcRequestSchema.safeParse({ jsonrpc: '2.0', method: 'a'.repeat(101) }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcpToolCallParamsSchema
// ---------------------------------------------------------------------------

describe('mcpToolCallParamsSchema', () => {
  it('accepts valid name', () => {
    expect(mcpToolCallParamsSchema.safeParse({ name: 'search_kb' }).success).toBe(true);
  });

  it('accepts name with optional arguments', () => {
    const input = { name: 'search_kb', arguments: { query: 'agents' } };
    expect(mcpToolCallParamsSchema.safeParse(input).success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(mcpToolCallParamsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty name', () => {
    expect(mcpToolCallParamsSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    expect(mcpToolCallParamsSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcpResourceReadParamsSchema
// ---------------------------------------------------------------------------

describe('mcpResourceReadParamsSchema', () => {
  it('accepts a valid URI', () => {
    expect(
      mcpResourceReadParamsSchema.safeParse({ uri: 'sunrise://knowledge/search?q=test' }).success
    ).toBe(true);
  });

  it('rejects missing uri', () => {
    expect(mcpResourceReadParamsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty uri', () => {
    expect(mcpResourceReadParamsSchema.safeParse({ uri: '' }).success).toBe(false);
  });

  it('rejects uri exceeding 500 chars', () => {
    expect(
      mcpResourceReadParamsSchema.safeParse({ uri: 'sunrise://' + 'a'.repeat(491) }).success
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mcpPromptGetParamsSchema
// ---------------------------------------------------------------------------

describe('mcpPromptGetParamsSchema', () => {
  it('accepts a valid prompt name', () => {
    expect(mcpPromptGetParamsSchema.safeParse({ name: 'code-review' }).success).toBe(true);
  });

  it('accepts name with optional arguments', () => {
    const input = { name: 'summarize', arguments: { text: 'some text' } };
    expect(mcpPromptGetParamsSchema.safeParse(input).success).toBe(true);
  });

  it('rejects missing name', () => {
    expect(mcpPromptGetParamsSchema.safeParse({}).success).toBe(false);
  });

  it('rejects empty name', () => {
    expect(mcpPromptGetParamsSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    expect(mcpPromptGetParamsSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listExposedToolsQuerySchema
// ---------------------------------------------------------------------------

describe('listExposedToolsQuerySchema', () => {
  it('accepts empty object with defaults', () => {
    const result = listExposedToolsQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.page).toBe(1);
    expect(result.success && result.data.limit).toBe(10);
  });

  it('accepts isEnabled as coerced boolean true', () => {
    const result = listExposedToolsQuerySchema.safeParse({ isEnabled: 'true' });
    expect(result.success && result.data.isEnabled).toBe(true);
  });

  it('accepts isEnabled as coerced boolean — string "false" coerces to true (JS Boolean cast)', () => {
    // z.coerce.boolean() uses Boolean('false') which is truthy in JavaScript
    const result = listExposedToolsQuerySchema.safeParse({ isEnabled: 'false' });
    expect(result.success && result.data.isEnabled).toBe(true);
  });

  it('accepts page and limit overrides', () => {
    const result = listExposedToolsQuerySchema.safeParse({ page: '2', limit: '20' });
    expect(result.success && result.data.page).toBe(2);
    expect(result.success && result.data.limit).toBe(20);
  });

  it('rejects limit above 100', () => {
    expect(listExposedToolsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listExposedResourcesQuerySchema
// ---------------------------------------------------------------------------

describe('listExposedResourcesQuerySchema', () => {
  it('accepts empty object with defaults', () => {
    const result = listExposedResourcesQuerySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('accepts a valid resourceType', () => {
    expect(
      listExposedResourcesQuerySchema.safeParse({ resourceType: 'knowledge_search' }).success
    ).toBe(true);
  });

  it('accepts all valid resourceTypes', () => {
    const types = ['knowledge_search', 'agent_list', 'pattern_detail', 'workflow_list'];
    for (const resourceType of types) {
      expect(listExposedResourcesQuerySchema.safeParse({ resourceType }).success).toBe(true);
    }
  });

  it('rejects an invalid resourceType', () => {
    expect(
      listExposedResourcesQuerySchema.safeParse({ resourceType: 'unknown_type' }).success
    ).toBe(false);
  });

  it('accepts isEnabled as coerced boolean', () => {
    expect(listExposedResourcesQuerySchema.safeParse({ isEnabled: 'true' }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listApiKeysQuerySchema
// ---------------------------------------------------------------------------

describe('listApiKeysQuerySchema', () => {
  it('accepts empty object with defaults', () => {
    const result = listApiKeysQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data.page).toBe(1);
  });

  it('accepts isActive as coerced boolean', () => {
    const result = listApiKeysQuerySchema.safeParse({ isActive: 'true' });
    expect(result.success && result.data.isActive).toBe(true);
  });

  it('accepts pagination overrides', () => {
    const result = listApiKeysQuerySchema.safeParse({ page: '3', limit: '50' });
    expect(result.success && result.data.page).toBe(3);
    expect(result.success && result.data.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// createExposedResourceSchema
// ---------------------------------------------------------------------------

describe('createExposedResourceSchema', () => {
  const validInput = {
    uri: 'sunrise://knowledge/search',
    name: 'Knowledge Search',
    description: 'Searches the knowledge base',
    resourceType: 'knowledge_search',
  };

  it('accepts a valid resource creation payload', () => {
    expect(createExposedResourceSchema.safeParse(validInput).success).toBe(true);
  });

  it('defaults mimeType to application/json', () => {
    const result = createExposedResourceSchema.safeParse(validInput);
    expect(result.success && result.data.mimeType).toBe('application/json');
  });

  it('defaults isEnabled to false', () => {
    const result = createExposedResourceSchema.safeParse(validInput);
    expect(result.success && result.data.isEnabled).toBe(false);
  });

  it('rejects URI not starting with sunrise://', () => {
    expect(
      createExposedResourceSchema.safeParse({ ...validInput, uri: 'https://example.com' }).success
    ).toBe(false);
  });

  it('rejects missing uri', () => {
    const { uri: _uri, ...rest } = validInput;
    expect(createExposedResourceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing name', () => {
    const { name: _name, ...rest } = validInput;
    expect(createExposedResourceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing description', () => {
    const { description: _desc, ...rest } = validInput;
    expect(createExposedResourceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects missing resourceType', () => {
    const { resourceType: _rt, ...rest } = validInput;
    expect(createExposedResourceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects invalid resourceType', () => {
    expect(
      createExposedResourceSchema.safeParse({ ...validInput, resourceType: 'bad_type' }).success
    ).toBe(false);
  });

  it('accepts all valid resourceTypes', () => {
    const types = ['knowledge_search', 'agent_list', 'pattern_detail', 'workflow_list'];
    for (const resourceType of types) {
      expect(createExposedResourceSchema.safeParse({ ...validInput, resourceType }).success).toBe(
        true
      );
    }
  });

  it('accepts optional handlerConfig record', () => {
    expect(
      createExposedResourceSchema.safeParse({
        ...validInput,
        handlerConfig: { maxResults: 10 },
      }).success
    ).toBe(true);
  });

  it('accepts null handlerConfig', () => {
    expect(
      createExposedResourceSchema.safeParse({ ...validInput, handlerConfig: null }).success
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateExposedResourceSchema
// ---------------------------------------------------------------------------

describe('updateExposedResourceSchema', () => {
  it('accepts a valid name update', () => {
    expect(updateExposedResourceSchema.safeParse({ name: 'New Name' }).success).toBe(true);
  });

  it('accepts isEnabled toggle', () => {
    expect(updateExposedResourceSchema.safeParse({ isEnabled: true }).success).toBe(true);
  });

  it('accepts mimeType update', () => {
    expect(updateExposedResourceSchema.safeParse({ mimeType: 'text/plain' }).success).toBe(true);
  });

  it('accepts null handlerConfig', () => {
    expect(updateExposedResourceSchema.safeParse({ handlerConfig: null }).success).toBe(true);
  });

  it('accepts a handlerConfig record', () => {
    expect(updateExposedResourceSchema.safeParse({ handlerConfig: { key: 'value' } }).success).toBe(
      true
    );
  });

  it('rejects an empty object (at least one field required)', () => {
    expect(updateExposedResourceSchema.safeParse({}).success).toBe(false);
  });

  it('rejects name exceeding 100 chars', () => {
    expect(updateExposedResourceSchema.safeParse({ name: 'a'.repeat(101) }).success).toBe(false);
  });

  it('rejects description exceeding 5000 chars', () => {
    expect(updateExposedResourceSchema.safeParse({ description: 'a'.repeat(5001) }).success).toBe(
      false
    );
  });
});
