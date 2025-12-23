# Simple Test Template - Validation Schemas

**Use Case**: Zod schemas, pure validators, utility functions with no side effects

**Complexity**: Simple (Full Autonomy)
**Dependencies**: None (pure functions)
**Mocking**: Not required

## Template Structure

```typescript
// __tests__/lib/validations/auth.test.ts
import { describe, it, expect } from 'vitest';
import { passwordSchema, emailSchema, signUpSchema } from '@/lib/validations/auth';

describe('Password Validation Schema', () => {
  describe('valid passwords', () => {
    it('should accept password with all requirements', () => {
      const result = passwordSchema.safeParse('SecurePass123!');
      expect(result.success).toBe(true);
    });

    it('should accept password with minimum length', () => {
      const result = passwordSchema.safeParse('Abcd123!');
      expect(result.success).toBe(true);
    });
  });

  describe('invalid passwords', () => {
    it('should reject password without uppercase letter', () => {
      const result = passwordSchema.safeParse('securepass123!');
      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toContain('uppercase');
    });

    it('should reject password without number', () => {
      const result = passwordSchema.safeParse('SecurePass!');
      expect(result.success).toBe(false);
    });

    it('should reject password too short', () => {
      const result = passwordSchema.safeParse('Ab1!');
      expect(result.success).toBe(false);
    });
  });
});

describe('Email Validation Schema', () => {
  it('should accept valid email', () => {
    const result = emailSchema.safeParse('user@example.com');
    expect(result.success).toBe(true);
  });

  it('should normalize email to lowercase', () => {
    const result = emailSchema.safeParse('USER@EXAMPLE.COM');
    expect(result.data).toBe('user@example.com');
  });

  it('should trim whitespace', () => {
    const result = emailSchema.safeParse('  user@example.com  ');
    expect(result.data).toBe('user@example.com');
  });
});
```

## Testing Checklist

For validation schema tests, ensure you cover:

- [ ] **Valid inputs**: Test all valid variations
- [ ] **Invalid inputs**: Test each validation rule violation
- [ ] **Edge cases**: Empty strings, max length, special characters
- [ ] **Transformations**: Trimming, lowercasing, normalization
- [ ] **Custom refinements**: Test `.refine()` and `.superRefine()` logic
- [ ] **Error messages**: Verify correct error messages are returned

## Example Test Cases

### Password Schema

- ✅ Valid: "SecurePass123!", "MyP@ssw0rd", "Tr0ng!Pass"
- ❌ No uppercase: "securepass123!"
- ❌ No lowercase: "SECUREPASS123!"
- ❌ No number: "SecurePass!"
- ❌ No special char: "SecurePass123"
- ❌ Too short: "Ab1!"
- ❌ Too long: "A" \* 101 + "b1!"

### Email Schema

- ✅ Valid: "user@example.com", "test.user+tag@domain.co.uk"
- ✅ Normalized: "USER@Example.COM" → "user@example.com"
- ✅ Trimmed: " user@example.com " → "user@example.com"
- ❌ Invalid: "notanemail", "@example.com", "user@", "user"

### Signup Schema (with custom refine)

- ✅ Valid: password === confirmPassword
- ❌ Invalid: password !== confirmPassword
- ✅ All fields present: name, email, password, confirmPassword
- ❌ Missing fields: name missing, email missing, etc.

## Tips

1. **Test both success and failure**: Use `.safeParse()` for controlled testing
2. **Group related tests**: Use nested `describe` blocks for valid/invalid cases
3. **Be exhaustive**: Zod schemas are mission-critical - test every rule
4. **Verify error messages**: Ensure user-friendly errors are returned
5. **Test transformations**: Verify `.trim()`, `.toLowerCase()`, etc. work
6. **Parameterized tests**: Use `describe.each()` for multiple inputs

## Verification

```bash
# Run validation tests
npm test -- __tests__/lib/validations

# Expected: All tests pass, 95%+ coverage
```

## Related Files

- **Source**: `lib/validations/auth.ts`, `lib/validations/user.ts`, `lib/validations/common.ts`
- **Other templates**: See `medium.md` for functions with dependencies
