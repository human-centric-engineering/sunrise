# Authentication Decisions & Best Practices

This document covers architectural decisions, performance considerations, and security best practices for authentication in Sunrise.

## Decision History & Trade-offs

### Proxy vs. Middleware

**Decision**: Use proxy file convention (Next.js 16+)

**Rationale**:

- Next.js 16 deprecated `middleware` in favor of `proxy` to clarify purpose
- Same functionality, better naming that reflects network boundary
- Aligns with Next.js direction moving forward

**Trade-offs**: Requires migration from older middleware convention

### better-auth vs. NextAuth.js

**Decision**: Use better-auth instead of NextAuth.js

**Rationale**:

- Simpler API with less boilerplate
- No provider wrapper needed for client hooks (uses nanostore)
- Built-in signup functionality (no custom API routes needed)
- Better TypeScript support
- More flexible session management
- Active development with modern patterns

**Trade-offs**: Smaller ecosystem than NextAuth.js, but rapidly growing

### Cookie-Based Session Check in Proxy

**Decision**: Check for session cookie existence in proxy, not full session validation

**Rationale**:

- Fast (no database query or API call in proxy)
- Sufficient for initial route protection
- Full validation happens in page/API route
- Better performance at scale

**Trade-offs**: Slight duplication of auth checks, but provides defense in depth

### Server-First Authentication

**Decision**: Perform authentication checks on server when possible

**Rationale**:

- More secure (client can't bypass)
- Better performance (no client-side redirect flash)
- SEO-friendly (correct status codes)
- Leverages React Server Components

**Trade-offs**: Requires understanding server vs. client components

### Callback URL Preservation

**Decision**: Pass `callbackUrl` in login redirects

**Rationale**:

- Better UX (return user to intended destination)
- Standard OAuth pattern
- Simple to implement

**Trade-offs**: Must validate callback URL to prevent open redirect (better-auth handles this)

### Auto-Login After Signup

**Decision**: Automatically sign in users after registration via better-auth

**Rationale**:

- Reduces friction (no need to login after signup)
- Common pattern in modern apps
- Built into better-auth by default

**Trade-offs**: Email verification handled separately (can be enabled in config)

## Performance Considerations

### Session Caching

better-auth caches session data using cookies and internal state management:

- Client-side: nanostore provides reactive state without re-fetching
- Server-side: Session validated once per request using headers
- No unnecessary database queries

### Proxy Efficiency

Proxy runs on every request to matched routes. Keep logic minimal:

- Use cookie existence check (fast, no I/O)
- Avoid database queries in proxy
- Full session validation in page/API route
- Cache static configuration

### Client Hook Optimization

The `useSession()` hook from better-auth is optimized:

- No provider wrapper needed (reduces React tree depth)
- Uses nanostore for efficient state management
- Only re-renders when session changes
- Automatic cleanup on unmount

### Database Query Optimization

When fetching user data, use Prisma's query optimization:

```typescript
// Select only needed fields
const user = await prisma.user.findUnique({
  where: { id: session.user.id },
  select: {
    id: true,
    name: true,
    email: true,
    role: true,
  },
});
```

## Security Best Practices

### Environment Variables

- Never commit `.env` or `.env.local`
- Use strong `BETTER_AUTH_SECRET` (min 32 characters)
- Generate secret: `openssl rand -base64 32`
- Rotate secrets periodically

### Session Security

- HTTPS in production (enforced by better-auth)
- Secure cookie flags set automatically
- Session expiration configured (30 days default)
- Automatic session refresh

### Input Validation

- Validate all inputs with Zod schemas
- Sanitize user input before database operations
- Use Prisma (prevents SQL injection)
- Validate on server, not just client

### Rate Limiting

Rate limiting is implemented for auth endpoints:

- Login endpoints: 5 requests/minute (prevent brute force)
- Signup endpoints: 5 requests/minute (prevent spam)
- Password reset endpoints: 5 requests/minute
- API endpoints: 60 requests/minute (general)
- Admin endpoints: 30 requests/minute

See [Security Overview](../security/overview.md) for rate limiting configuration.

### CSRF Protection

better-auth includes built-in CSRF protection:

- State parameter in OAuth flows
- Origin header validation
- Secure cookie configuration

## Related Documentation

- [Auth Overview](./overview.md) - Authentication architecture and configuration
- [Auth Security](./security.md) - Security model and threat mitigation
- [Auth Integration](./integration.md) - Route protection patterns
