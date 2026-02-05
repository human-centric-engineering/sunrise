# Edge Cases and Error Testing

Patterns for testing error handling, parameterized tests, and edge case coverage in Sunrise.

---

## Error Testing Patterns

### Type-Safe Error Handling

```typescript
// GOOD - Type narrowing with instanceof
it('should throw ValidationError for invalid data', async () => {
  // Arrange
  const invalidData = { email: 'not-an-email' };
  const mockRequest = createMockRequest(invalidData);

  // Act & Assert
  try {
    await validateRequestBody(mockRequest, schema);
    expect.fail('Should have thrown ValidationError');
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    if (error instanceof ValidationError) {
      // Type-safe access to ValidationError properties
      expect(error.message).toBe('Invalid request body');
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.status).toBe(400);
      expect(error.details).toBeDefined();
    }
  }
});

// AVOID - Type assertion (no runtime safety)
try {
  await validateRequestBody(mockRequest, schema);
} catch (error) {
  expect((error as ValidationError).message).toBe('...'); // Could fail
}
```

### Testing Zod Validation Errors

```typescript
describe('passwordSchema', () => {
  it('should reject password without uppercase letter', () => {
    // Arrange
    const invalidPassword = 'password123!';

    // Act
    const result = passwordSchema.safeParse(invalidPassword);

    // Assert
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('uppercase letter');
    }
  });
});
```

### Testing Error Response Structure

```typescript
it('should return properly formatted error response', async () => {
  // Arrange
  const error = new ValidationError('Invalid input', {
    details: { field: 'email', message: 'Invalid format' },
  });

  // Act
  const response = handleAPIError(error);
  const body = await response.json();

  // Assert
  expect(response.status).toBe(400);
  expect(body).toEqual({
    success: false,
    error: {
      message: 'Invalid input',
      code: 'VALIDATION_ERROR',
      details: { field: 'email', message: 'Invalid format' },
    },
  });
});
```

---

## Parameterized Testing

### Using Test Case Arrays

```typescript
describe('skip calculation', () => {
  it('should correctly calculate skip = (page - 1) * limit', () => {
    // Arrange: Define test cases
    const testCases = [
      { page: 1, limit: 20, expectedSkip: 0 },
      { page: 2, limit: 20, expectedSkip: 20 },
      { page: 3, limit: 20, expectedSkip: 40 },
      { page: 5, limit: 10, expectedSkip: 40 },
      { page: 10, limit: 100, expectedSkip: 900 },
    ];

    testCases.forEach(({ page, limit, expectedSkip }) => {
      // Arrange
      const searchParams = new URLSearchParams(`page=${page}&limit=${limit}`);

      // Act
      const result = parsePaginationParams(searchParams);

      // Assert
      expect(result.skip).toBe(expectedSkip);
    });
  });
});
```

### Using describe.each

```typescript
describe.each([
  { password: 'Password123!', valid: true, reason: 'all criteria met' },
  { password: 'password123!', valid: false, reason: 'no uppercase' },
  { password: 'PASSWORD123!', valid: false, reason: 'no lowercase' },
  { password: 'Password!', valid: false, reason: 'no number' },
  { password: 'Password123', valid: false, reason: 'no special char' },
])('passwordSchema with $password', ({ password, valid, reason }) => {
  it(`should ${valid ? 'accept' : 'reject'} - ${reason}`, () => {
    const result = passwordSchema.safeParse(password);
    expect(result.success).toBe(valid);
  });
});
```

### Using it.each

```typescript
it.each([
  [200, 'OK'],
  [201, 'Created'],
  [400, 'Bad Request'],
  [401, 'Unauthorized'],
  [404, 'Not Found'],
  [500, 'Internal Server Error'],
])('should return correct status text for %i', (code, expected) => {
  const result = getStatusText(code);
  expect(result).toBe(expected);
});
```

---

## Testing Edge Cases

### Boundary Values

```typescript
describe('pagination limits', () => {
  it('should enforce minimum page of 1', () => {
    const testCases = [0, -1, -5, -999];

    testCases.forEach((invalidPage) => {
      const searchParams = new URLSearchParams(`page=${invalidPage}`);
      const result = parsePaginationParams(searchParams);
      expect(result.page).toBe(1);
    });
  });

  it('should enforce maximum limit of 100', () => {
    const testCases = [101, 500, 9999];

    testCases.forEach((invalidLimit) => {
      const searchParams = new URLSearchParams(`limit=${invalidLimit}`);
      const result = parsePaginationParams(searchParams);
      expect(result.limit).toBe(100);
    });
  });

  it('should enforce minimum limit of 1', () => {
    const testCases = [0, -1, -10];

    testCases.forEach((invalidLimit) => {
      const searchParams = new URLSearchParams(`limit=${invalidLimit}`);
      const result = parsePaginationParams(searchParams);
      expect(result.limit).toBe(1);
    });
  });
});
```

### Null/Undefined/Empty Values

```typescript
describe('edge cases', () => {
  it('should handle null data', async () => {
    const response = successResponse(null);
    const json = await parseSuccessResponse(response);
    expect(json.data).toBe(null);
  });

  it('should handle empty object', async () => {
    const response = successResponse({});
    const json = await parseSuccessResponse(response);
    expect(json.data).toEqual({});
  });

  it('should handle empty array', async () => {
    const response = successResponse([]);
    const json = await parseSuccessResponse(response);
    expect(json.data).toEqual([]);
  });

  it('should handle undefined optional fields', () => {
    const result = formatUser({ id: '123', email: 'test@example.com' });
    expect(result.name).toBeUndefined();
  });
});
```

### String Edge Cases

```typescript
describe('string handling', () => {
  it('should handle empty string', () => {
    const result = sanitizeInput('');
    expect(result).toBe('');
  });

  it('should handle whitespace-only string', () => {
    const result = sanitizeInput('   ');
    expect(result).toBe('');
  });

  it('should handle unicode characters', () => {
    const result = sanitizeInput('Hello 世界 🌍');
    expect(result).toBe('Hello 世界 🌍');
  });

  it('should handle very long strings', () => {
    const longString = 'a'.repeat(10000);
    const result = sanitizeInput(longString);
    expect(result.length).toBeLessThanOrEqual(1000); // Max length
  });
});
```

### Array Edge Cases

```typescript
describe('array handling', () => {
  it('should handle empty array', () => {
    const result = processItems([]);
    expect(result).toEqual([]);
  });

  it('should handle single item', () => {
    const result = processItems([{ id: '1' }]);
    expect(result).toHaveLength(1);
  });

  it('should handle duplicate items', () => {
    const result = processItems([
      { id: '1', name: 'Item' },
      { id: '1', name: 'Item' },
    ]);
    expect(result).toHaveLength(1); // Deduped
  });

  it('should handle large arrays', () => {
    const items = Array.from({ length: 10000 }, (_, i) => ({ id: String(i) }));
    const result = processItems(items);
    expect(result).toHaveLength(10000);
  });
});
```

---

## Testing Invalid Inputs

### Malformed JSON

```typescript
it('should handle malformed JSON in request', async () => {
  // Arrange
  const mockRequest = {
    json: vi.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
  } as unknown as NextRequest;

  // Act
  const response = await POST(mockRequest);
  const body = await response.json();

  // Assert
  expect(response.status).toBe(400);
  expect(body.error.code).toBe('INVALID_JSON');
});
```

### Missing Required Fields

```typescript
describe('required field validation', () => {
  it('should reject missing email', async () => {
    const data = { name: 'John' }; // Missing email

    const result = userSchema.safeParse(data);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('email');
    }
  });

  it('should reject missing name', async () => {
    const data = { email: 'john@example.com' }; // Missing name

    const result = userSchema.safeParse(data);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('name');
    }
  });
});
```

### Invalid Types

```typescript
describe('type validation', () => {
  it.each([
    ['number instead of string', { email: 123 }],
    ['array instead of string', { email: ['a', 'b'] }],
    ['object instead of string', { email: { value: 'test' } }],
    ['boolean instead of string', { email: true }],
  ])('should reject %s for email', (_, data) => {
    const result = userSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
```

---

## Summary

**Error Testing**:

- Use `instanceof` for type narrowing
- Test error response structure
- Use `safeParse` for Zod validation tests

**Parameterized Testing**:

- Use test case arrays for simple cases
- Use `describe.each` for complex scenarios
- Use `it.each` for single assertion variations

**Edge Cases to Cover**:

- Boundary values (min, max, zero, negative)
- Empty values (null, undefined, '', [], {})
- Invalid types
- Unicode and special characters
- Large inputs
- Malformed data

**Related Documentation**:

- [Testing Overview](./overview.md) - Testing philosophy
- [Testing Patterns](./patterns.md) - General patterns
- [Type Safety](./type-safety.md) - Type-safe assertions
- [Mocking Strategies](./mocking.md) - Mock patterns
