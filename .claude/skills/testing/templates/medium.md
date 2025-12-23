# Medium Test Template - API Utilities

**Use Case**: Request validation, response formatters, error handlers, async functions with mockable dependencies

**Complexity**: Medium (Hybrid Autonomy)
**Dependencies**: NextRequest, Zod, custom utilities
**Mocking**: Required for some dependencies

## Template Structure

```typescript
// __tests__/lib/api/validation.test.ts
import { describe, it, expect, vi } from 'vitest';
import { validateRequestBody, parsePaginationParams } from '@/lib/api/validation';
import { z } from 'zod';

describe('validateRequestBody', () => {
  it('should parse and validate valid request body', async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const request = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'John', age: 30 }),
    });

    const result = await validateRequestBody(request, schema);

    expect(result).toEqual({ name: 'John', age: 30 });
  });

  it('should throw ValidationError for invalid data', async () => {
    const schema = z.object({ email: z.string().email() });
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ email: 'not-an-email' }),
    });

    await expect(validateRequestBody(request, schema)).rejects.toThrow('ValidationError');
  });

  it('should throw ValidationError for malformed JSON', async () => {
    const schema = z.object({ name: z.string() });
    const request = new Request('http://localhost', {
      method: 'POST',
      body: 'invalid json',
    });

    await expect(validateRequestBody(request, schema)).rejects.toThrow();
  });
});

describe('parsePaginationParams', () => {
  it('should use default values when params not provided', () => {
    const searchParams = new URLSearchParams();

    const result = parsePaginationParams(searchParams);

    expect(result).toEqual({
      page: 1,
      limit: 20,
      skip: 0,
    });
  });

  it('should parse valid pagination params', () => {
    const searchParams = new URLSearchParams({ page: '3', limit: '10' });

    const result = parsePaginationParams(searchParams);

    expect(result).toEqual({
      page: 3,
      limit: 10,
      skip: 20, // (3-1) * 10
    });
  });

  it('should clamp page to minimum 1', () => {
    const searchParams = new URLSearchParams({ page: '0' });

    const result = parsePaginationParams(searchParams);

    expect(result.page).toBe(1);
  });

  it('should clamp limit to maximum 100', () => {
    const searchParams = new URLSearchParams({ limit: '150' });

    const result = parsePaginationParams(searchParams);

    expect(result.limit).toBe(100);
  });
});
```

## Testing Checklist

For API utility tests, ensure you cover:

- [ ] **Happy path**: Valid inputs produce expected outputs
- [ ] **Validation errors**: Invalid inputs throw appropriate errors
- [ ] **Edge cases**: Boundary values, empty inputs, max values
- [ ] **Async operations**: Proper use of `async/await` and `.rejects`
- [ ] **Error messages**: Verify error messages are helpful
- [ ] **Type safety**: Ensure TypeScript types are tested implicitly

## Example Test Cases

### Request Validation

- ✅ Valid JSON body with correct schema
- ❌ Invalid JSON (malformed)
- ❌ Valid JSON but fails schema validation
- ❌ Missing required fields
- ✅ Extra fields ignored (if schema allows)
- ✅ Type coercion works (strings → numbers)

### Response Formatters

- ✅ Success response with data
- ✅ Success response with metadata
- ❌ Error response with message
- ❌ Error response with code and details
- ✅ Pagination metadata calculated correctly

### Error Handlers

- ❌ Prisma errors transformed (P2002, P2025, P2003)
- ❌ Zod errors transformed to ValidationError
- ❌ Generic errors wrapped correctly
- ✅ Stack traces included in development
- ✅ Stack traces excluded in production
- ✅ Errors logged with structured logger

## Mocking Patterns

### Mocking NextRequest

```typescript
const request = new Request('http://localhost/api/endpoint', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: 'Bearer token',
  },
  body: JSON.stringify({ data: 'value' }),
});
```

### Mocking URLSearchParams

```typescript
const searchParams = new URLSearchParams({
  page: '2',
  limit: '10',
  search: 'query',
  sortBy: 'createdAt',
  sortOrder: 'desc',
});
```

### Mocking Logger (if used)

```typescript
vi.mock('@/lib/logging', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));
```

## Tips

1. **Test async thoroughly**: Use `async/await` and `.rejects` for promises
2. **Test error paths**: Ensure errors are caught and handled correctly
3. **Verify error types**: Check that custom error classes are thrown
4. **Mock minimally**: Only mock external dependencies, not business logic
5. **Use real Request objects**: Better than mocking Next.js internals

## Verification

```bash
# Run API utility tests
npm test -- __tests__/lib/api

# Expected: All tests pass, 85%+ coverage
```

## Related Files

- **Source**: `lib/api/validation.ts`, `lib/api/errors.ts`, `lib/api/responses.ts`
- **Mocking**: See `../mocking/` for detailed mock strategies
- **Other templates**: See `complex.md` for integration tests
