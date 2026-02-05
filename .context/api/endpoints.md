# API Endpoints Overview

## Endpoint Documentation

| Category        | File                                           | Description                                         |
| --------------- | ---------------------------------------------- | --------------------------------------------------- |
| User Management | [user-endpoints.md](./user-endpoints.md)       | Profile, preferences, avatar, admin user operations |
| Authentication  | [auth-endpoints.md](./auth-endpoints.md)       | Sign-in, sign-up, OAuth, invitations                |
| Admin           | [admin-endpoints.md](./admin-endpoints.md)     | Stats, logs, feature flags, invitation management   |
| Utilities       | [utility-endpoints.md](./utility-endpoints.md) | Health check, CSP reports, contact form             |

## API Design Principles

Sunrise implements RESTful APIs through Next.js route handlers with the following principles:

- **Versioning**: All public APIs use `/api/v1/` prefix
- **Resource-Based**: URLs represent resources (nouns), not actions
- **HTTP Methods**: Standard methods (GET, POST, PUT, PATCH, DELETE)
- **Standard Responses**: Consistent `{ success, data, error }` format
- **Authentication**: Session-based using better-auth
- **Validation**: Zod schemas for all inputs

## Response Format

### Success Response

```typescript
{
  "success": true,
  "data": { /* response payload */ },
  "meta": { /* optional metadata (pagination, etc.) */ }
}
```

### Error Response

```typescript
{
  "success": false,
  "error": {
    "message": "Human-readable error message",
    "code": "ERROR_CODE",
    "details": { /* optional additional context */ }
  }
}
```

## Common Patterns

### Pagination

```typescript
// Standard pagination pattern
const page = parseInt(searchParams.get('page') || '1');
const limit = Math.min(parseInt(searchParams.get('limit') || '20'), 100);
const skip = (page - 1) * limit;

const [items, total] = await Promise.all([
  prisma.model.findMany({ skip, take: limit }),
  prisma.model.count(),
]);

return Response.json({
  success: true,
  data: items,
  meta: {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  },
});
```

### Search/Filtering

```typescript
// Case-insensitive search across multiple fields
const search = searchParams.get('search') || '';

const where = search
  ? {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    }
  : {};

const results = await prisma.user.findMany({ where });
```

### Sorting

```typescript
// Dynamic sorting
const sortBy = searchParams.get('sortBy') || 'createdAt';
const sortOrder = searchParams.get('sortOrder') || 'desc';

const validSortFields = ['name', 'email', 'createdAt'];
const orderBy = validSortFields.includes(sortBy) ? { [sortBy]: sortOrder } : { createdAt: 'desc' };

const results = await prisma.user.findMany({ orderBy });
```

## Error Codes

| Code                     | HTTP Status | Meaning                             |
| ------------------------ | ----------- | ----------------------------------- |
| `UNAUTHORIZED`           | 401         | No valid session                    |
| `FORBIDDEN`              | 403         | Authenticated but lacks permissions |
| `NOT_FOUND`              | 404         | Resource doesn't exist              |
| `VALIDATION_ERROR`       | 400         | Input validation failed             |
| `EMAIL_TAKEN`            | 400         | Email already registered            |
| `INVITATION_EXPIRED`     | 400         | Invitation token has expired        |
| `CONFLICT`               | 409         | Resource already exists             |
| `FILE_TOO_LARGE`         | 400         | File exceeds max upload size        |
| `INVALID_FILE_TYPE`      | 400         | Unsupported file format             |
| `STORAGE_NOT_CONFIGURED` | 503         | File storage backend not available  |
| `RATE_LIMIT_EXCEEDED`    | 429         | Too many requests                   |
| `INTERNAL_ERROR`         | 500         | Server error                        |

## Decision History & Trade-offs

### Versioned API Path

**Decision**: `/api/v1/` prefix for all public APIs

**Rationale**:

- Allows breaking changes in v2 without affecting v1 clients
- Clear separation from internal APIs (`/api/auth/`, `/api/health/`)
- Industry standard practice

**Trade-offs**: Slightly longer URLs

### Standard Response Format

**Decision**: `{ success, data, error }` over varying formats

**Rationale**:

- Client code can always check `success` field
- TypeScript type safety for responses
- Easy to add metadata without breaking changes

**Trade-offs**: Slightly verbose for simple responses

### Pagination Defaults

**Decision**: Default 20 items, max 100 per page

**Rationale**:

- 20 items: Good balance of data transfer and UX
- Max 100: Prevents excessive database load
- Standard across industry

**Trade-offs**: Some use cases may need larger limits (use cursor pagination instead)

## Performance Considerations

### Database Query Optimization

```typescript
// Good: Select only needed fields
const user = await prisma.user.findUnique({
  where: { id },
  select: { id: true, name: true, email: true },
});

// Bad: Fetch entire user object including password hash
const user = await prisma.user.findUnique({ where: { id } });
```

### Parallel Queries

```typescript
// Good: Parallel execution
const [users, total] = await Promise.all([prisma.user.findMany(), prisma.user.count()]);

// Bad: Sequential execution
const users = await prisma.user.findMany();
const total = await prisma.user.count(); // Waits for first query
```

### Response Caching

```typescript
// Add cache headers for static data
export async function GET(request: NextRequest) {
  const data = await fetchStaticData();

  return Response.json(
    { success: true, data },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate',
      },
    }
  );
}
```

## Related Documentation

- [API Headers](./headers.md) - HTTP headers, CORS, and middleware
- [API Examples](./examples.md) - Client implementation examples
- [Auth Integration](../auth/integration.md) - Authentication patterns
- [Database Models](../database/models.md) - Prisma schema and queries
