# Breaking Changes from Original Plan

This document tracks significant version differences and breaking changes from the technologies specified in the original build plan.

**Last Updated:** 2025-12-15

---

## Authentication: better-auth (Plan specified NextAuth.js v5)

We're using **better-auth v1.4.7** instead of NextAuth.js v5 as specified in the original plan.

### Why the Change?

**Decision:** Use better-auth instead of NextAuth.js v5
**Official Recommendation:** NextAuth.js has become part of better-auth, and the official recommendation is to use better-auth for all new projects.

**Impact:** HIGH - Complete authentication architecture change

### Key Differences

#### 1. No Provider Wrapper Required

**What Changed:**

- NextAuth.js requires `<SessionProvider>` wrapper in client components
- better-auth uses nanostore - no provider wrapper needed
- Simpler client-side setup

**Migration:**

```typescript
// NextAuth.js v5 - OLD
import { SessionProvider } from 'next-auth/react'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  )
}

// better-auth - NEW
// No provider needed! Just use hooks directly
export default function RootLayout({ children }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  )
}
```

#### 2. API Route Structure Changed

**What Changed:**

- NextAuth.js uses catch-all: `app/api/auth/[...nextauth]/route.ts`
- better-auth uses catch-all: `app/api/auth/[...all]/route.ts`

**Migration:**

```typescript
// NextAuth.js v5 - OLD
// app/api/auth/[...nextauth]/route.ts
import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth/config';

const handler = NextAuth(authOptions);
export { handler as GET, handler as POST };

// better-auth - NEW
// app/api/auth/[...all]/route.ts
import { auth } from '@/lib/auth/config';
import { toNextJsHandler } from 'better-auth/next-js';

export const { POST, GET } = toNextJsHandler(auth);
```

#### 3. Configuration Structure Different

**What Changed:**

- NextAuth.js uses `NextAuthOptions` object exported separately
- better-auth uses `betterAuth()` function with inline config
- Different adapter syntax

**Migration:**

```typescript
// NextAuth.js v5 - OLD
import { NextAuthOptions } from 'next-auth'
import { PrismaAdapter } from '@auth/prisma-adapter'

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'jwt' },
  providers: [...]
}

// better-auth - NEW
import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true },
  socialProviders: { google: {...} }
})
```

#### 4. Environment Variables Renamed

**Impact:** MEDIUM - Must update all environment variables

**What Changed:**

- `NEXTAUTH_URL` → `BETTER_AUTH_URL`
- `NEXTAUTH_SECRET` → `BETTER_AUTH_SECRET`

**Migration:**

```bash
# .env - OLD (NextAuth.js v5)
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="your-secret-here"

# .env - NEW (better-auth)
BETTER_AUTH_URL="http://localhost:3000"
BETTER_AUTH_SECRET="your-secret-here"
```

#### 5. Session Access Patterns

**What Changed:**

- Server: Different import paths and function names
- Client: `useSession` from different package

**Migration:**

```typescript
// Server Components - OLD
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';

const session = await getServerSession(authOptions);

// Server Components - NEW
import { auth } from '@/lib/auth/config';
import { headers } from 'next/headers';

const requestHeaders = await headers();
const session = await auth.api.getSession({ headers: requestHeaders });

// Client Components - OLD
import { useSession } from 'next-auth/react';

// Client Components - NEW
import { useSession } from '@/lib/auth/client';
// (wrapper around better-auth's useSession)
```

#### 6. Database Schema Changes

**What Changed:**

- No `Role` enum - uses string-based role field
- Different field names and structure
- Model names: `VerificationToken` → `Verification`

**Migration:**

```prisma
// NextAuth.js v5 Schema - OLD
enum Role {
  USER
  ADMIN
}

model User {
  role Role @default(USER)
}

model VerificationToken {
  identifier String
  token      String @unique
  expires    DateTime
  @@unique([identifier, token])
}

// better-auth Schema - NEW
model User {
  role String? @default("USER")  // No enum
}

model Verification {
  id         String   @id @default(cuid())
  identifier String
  value      String
  expiresAt  DateTime
  @@index([identifier])
}
```

### Benefits of better-auth

Despite breaking changes, better-auth provides:

1. **Official Recommendation** - NextAuth team recommends better-auth for new projects
2. **Simpler Architecture** - No provider wrapper, cleaner client setup
3. **Modern Patterns** - Uses nanostore for state management
4. **Prisma 7 Support** - Native support for latest Prisma
5. **Active Development** - Actively maintained and improved
6. **TypeScript First** - Better type inference and safety

---

## Next.js 16 (Plan specified Next.js 14+)

We're using **Next.js 16.0.10** which has breaking changes from Next.js 14 and 15.

### Removed Features

#### 1. `next lint` Command Removed

**Impact:** HIGH - Changes development workflow

**What Changed:**

- The `next lint` command no longer exists
- `next build` no longer automatically runs linting
- Must use ESLint CLI directly: `eslint .`

**Migration:**

```json
// package.json - OLD (Next.js 14/15)
{
  "scripts": {
    "lint": "next lint",
    "lint:fix": "next lint --fix"
  }
}

// package.json - NEW (Next.js 16)
{
  "scripts": {
    "lint": "eslint . --cache --cache-location .next/cache/eslint/",
    "lint:fix": "eslint . --fix --cache --cache-location .next/cache/eslint/"
  }
}
```

**Why This Matters:**

- CI/CD pipelines need explicit linting steps
- Pre-commit hooks must call `eslint` directly
- Build processes won't catch linting errors automatically

**References:**

- https://nextjs.org/docs/app/guides/upgrading/version-16
- https://nextjs.org/docs/app/api-reference/config/eslint

#### 2. ESLint Configuration in next.config.js Removed

**Impact:** MEDIUM

**What Changed:**

- The `eslint` option in `next.config.js` is deprecated and ignored
- Must use `eslint.config.js` (flat config) instead

**Migration:**

```javascript
// next.config.js - OLD (Next.js 14/15)
module.exports = {
  eslint: {
    dirs: ['pages', 'components', 'lib'],
    ignoreDuringBuilds: false,
  },
};

// next.config.js - NEW (Next.js 16)
module.exports = {
  // No eslint config here anymore
};

// eslint.config.mjs - NEW (required)
export default tseslint.config({
  ignores: ['.next/**', 'node_modules/**'],
});
```

---

## ESLint 9 (Plan assumed ESLint 8)

We're using **ESLint 9.39.1** which requires a completely different configuration format.

### Flat Config Required

#### 1. `.eslintrc.json` Deprecated

**Impact:** HIGH - Complete configuration rewrite required

**What Changed:**

- Legacy config files (`.eslintrc.*`) are deprecated
- Must use flat config: `eslint.config.js`, `eslint.config.mjs`, or `eslint.config.cjs`
- Will be removed entirely in ESLint v10

**Migration:**

```javascript
// .eslintrc.json - OLD (ESLint 8)
{
  "extends": ["next/core-web-vitals", "next/typescript"],
  "rules": {
    "no-console": ["warn", { "allow": ["warn", "error"] }]
  }
}

// eslint.config.mjs - NEW (ESLint 9)
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import nextPlugin from '@next/eslint-plugin-next'
import reactPlugin from 'eslint-plugin-react'

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{js,jsx,ts,tsx}'],
    plugins: {
      react: reactPlugin,
      '@next/next': nextPlugin,
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }]
    }
  }
)
```

#### 2. Plugin Installation Changed

**Impact:** MEDIUM - Must install plugins explicitly

**What Changed:**

- Config packages like `eslint-config-next` can't automatically install peer dependencies
- Must install ESLint plugins directly

**Required Installations:**

```bash
npm install -D --save-exact \
  typescript-eslint \
  eslint-plugin-react \
  eslint-plugin-react-hooks \
  eslint-plugin-jsx-a11y \
  @next/eslint-plugin-next
```

**References:**

- https://eslint.org/docs/latest/use/configure/migration-guide
- https://chris.lu/web_development/tutorials/next-js-16-linting-setup-eslint-9-flat-config

---

## Tailwind CSS 4 (Plan specified Tailwind CSS 3)

We're using **Tailwind CSS 4.1.18** which has a new CSS architecture.

### New CSS Syntax

#### 1. Import Syntax Changed

**Impact:** LOW - Simple find/replace

**What Changed:**

- Removed `@tailwind` directives
- New unified `@import` syntax

**Migration:**

```css
/* globals.css - OLD (Tailwind v3) */
@tailwind base;
@tailwind components;
@tailwind utilities;

/* globals.css - NEW (Tailwind v4) */
@import 'tailwindcss';
```

#### 2. PostCSS Plugin Changed

**Impact:** LOW - Different package required

**What Changed:**

- `tailwindcss` no longer works as a PostCSS plugin directly
- Must use `@tailwindcss/postcss` package

**Migration:**

```javascript
// postcss.config.js - OLD (Tailwind v3)
module.exports = {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};

// postcss.config.js - NEW (Tailwind v4)
module.exports = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};
```

**Installation:**

```bash
npm install -D @tailwindcss/postcss
```

**References:**

- Tailwind CSS 4 Beta documentation
- Error messages from Next.js build process

---

## Impact on Build Plan

### Documentation Updates Needed

The following sections of `SUNRISE-BUILD-PLAN.md` reference outdated approaches:

1. **Phase 1.1 - Project Initialization**
   - ✅ Updated to note Next.js 16
   - ✅ Updated to note Tailwind CSS 4
   - ✅ Updated to note ESLint 9

2. **Phase 2.1 - Code Quality Tools**
   - ⚠️ References "Configure ESLint with Next.js recommended rules"
   - Should specify: "Configure ESLint 9 with flat config and Next.js plugins"

3. **Week 1 Build Order**
   - ⚠️ Implies `next lint` will be available
   - Should specify: "Configure ESLint CLI directly"

### CI/CD Implications

Any CI/CD pipelines must now include:

```yaml
# Example GitHub Actions workflow
- name: Lint
  run: npm run lint # Calls 'eslint .' not 'next lint'

- name: Build
  run: npm run build # No longer lints automatically
```

### Developer Onboarding

New developers should know:

1. `next lint` doesn't exist - use `npm run lint`
2. ESLint config is in `eslint.config.mjs`, not `.eslintrc.json`
3. Tailwind CSS uses `@import "tailwindcss"` syntax

---

## Compatibility Matrix

| Technology     | Plan Version   | Actual Version    | Breaking Changes       |
| -------------- | -------------- | ----------------- | ---------------------- |
| Next.js        | 14+            | 16.0.10           | Yes - Major            |
| React          | 18+            | 19.2.3            | Minor API changes      |
| Authentication | NextAuth.js v5 | better-auth 1.4.7 | Yes - Complete rewrite |
| ESLint         | 8.x            | 9.39.1            | Yes - Config format    |
| Tailwind CSS   | 3.x            | 4.1.18            | Yes - CSS syntax       |
| TypeScript     | 5+             | 5.9.3             | No                     |
| Prisma         | 6+             | 7.1.0             | Yes - Adapter pattern  |
| Node.js        | 20+            | 20+               | No                     |

---

## Benefits of Version Updates

Despite breaking changes, these versions provide:

### Next.js 16

- Better Turbopack performance
- Improved developer experience
- Latest React 19 features
- Future-proof for long-term maintenance

### ESLint 9

- Better performance with flat config
- Easier to understand configuration
- Improved plugin composition
- Aligned with ESLint's future direction

### Tailwind CSS 4

- Faster compilation
- Smaller CSS output
- Better IntelliSense support
- Simpler configuration

---

## Recommendations for Future Builds

1. **Always check latest docs** - Don't assume build plan versions are current
2. **Test linting early** - Catch ESLint config issues in Phase 1.1
3. **Document version changes** - Update this file when upgrading
4. **Keep build plan generic** - Specify "14+" not "14.x" to allow flexibility

---

## Questions & Troubleshooting

### Q: Can we downgrade to the original plan versions?

**A:** Yes, but not recommended:

- Next.js 14/15 + ESLint 8 would work with legacy `.eslintrc.json`
- Tailwind CSS 3 would use old `@tailwind` directives
- Would miss performance and feature improvements

### Q: Will this affect future phases?

**A:** Minimal impact:

- Database/Prisma: No changes needed
- Authentication/NextAuth: No changes needed
- Docker: Next.js standalone output works the same
- shadcn/ui: Works with Tailwind CSS 4

### Q: What if ESLint breaks during development?

**A:** Check:

1. `eslint.config.mjs` syntax is valid
2. All plugins are installed (`typescript-eslint`, etc.)
3. TypeScript files are in `tsconfig.json` include paths
4. Use `--debug` flag: `npx eslint --debug .`

---

## Version Update History

| Date       | Component      | From           | To                | Reason                                     |
| ---------- | -------------- | -------------- | ----------------- | ------------------------------------------ |
| 2025-12-15 | Authentication | NextAuth.js v5 | better-auth 1.4.7 | Official recommendation from NextAuth team |
| 2025-12-12 | Next.js        | 14+ (plan)     | 16.0.10           | Latest stable release                      |
| 2025-12-12 | ESLint         | 8.x (implied)  | 9.39.1            | Installed with latest packages             |
| 2025-12-12 | Tailwind       | 3.x (plan)     | 4.1.18            | Latest stable release                      |
| 2025-12-12 | React          | 18+ (plan)     | 19.2.3            | Required by Next.js 16                     |
| 2025-12-12 | Prisma         | 6+ (plan)      | 7.1.0             | Latest stable release                      |
