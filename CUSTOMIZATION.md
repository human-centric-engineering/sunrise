# Customizing Sunrise for Your Project

Quick guide to adapt Sunrise as your project starter. For detailed documentation, see [`.context/`](./.context/) folders.

---

## 1. First Steps

**Initial Setup:**

- [ ] Fork or clone this repository
- [ ] Update `package.json`:
  - `name`: your-project-name
  - `description`: Your project description
  - `version`: 0.1.0 (or your initial version)
  - `author`: Your name/organization
  - `repository`: Your repository URL
- [ ] Update `README.md`:
  - Replace "Sunrise" with your project name
  - Update description and features list
  - Update repository URLs
- [ ] Copy `.env.example` to `.env.local`
- [ ] Configure required environment variables (see `.env.example`)
- [ ] Generate auth secret: `openssl rand -base64 32`
- [ ] Set `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` in `.env.local`
- [ ] Run: `npm install`
- [ ] Initialize database: `npm run db:push`
- [ ] Start dev server: `npm run dev`
- [ ] Test at `http://localhost:3000`

---

## 2. Branding & Theming

**Project Name & Metadata:**

- `package.json` → `name`, `description`
- `app/layout.tsx` → `metadata.title`, `metadata.description`
- `README.md` → main heading, description

**Colors & Styling:**

- `tailwind.config.ts` → `theme.extend.colors`, `theme.extend.fontFamily`
- `app/globals.css` → CSS variables for light/dark themes (`:root`, `.dark`)
- Update primary, secondary, accent colors as needed

**Logo & Favicon:**

- Replace `public/favicon.ico`
- Add logo images to `public/images/`
- Update `app/layout.tsx` → `metadata.icons`
- Update landing page hero: `app/(public)/page.tsx`

**Fonts:**

- Import fonts in `app/layout.tsx` (currently uses Inter)
- Update font family in `tailwind.config.ts`

---

## 3. Authentication

**Remove OAuth Providers:**

- Edit `lib/auth/config.ts` → delete provider from `socialProviders` array
- Remove corresponding env vars from `.env.local` and `.env.example`
- Update login UI if needed: `app/(auth)/login/page.tsx`

**Add OAuth Providers:**

- Add provider to `lib/auth/config.ts` (follow Google OAuth pattern)
- Add credentials to `.env.local`:
  - `<PROVIDER>_CLIENT_ID`
  - `<PROVIDER>_CLIENT_SECRET`
- Update `.env.example` with placeholder values
- Add provider button to `app/(auth)/login/page.tsx`

**Email-Only Authentication:**

- Remove `socialProviders` section from `lib/auth/config.ts`
- Remove OAuth buttons from `app/(auth)/login/page.tsx`
- Remove OAuth env vars from `.env.example`

---

## 4. Database Schema

**Modifying Schema:**

- Edit `prisma/schema.prisma`
- Add/modify models as needed
- Run migration:
  - **Development:** `npm run db:push` (quick iteration)
  - **Production:** `npm run db:migrate` (versioned migrations)
- Update seed data: `prisma/seed.ts`
- Regenerate Prisma client: `npx prisma generate`

**Adding Fields to User Model:**

- Edit `User` model in `prisma/schema.prisma`
- Run `npm run db:push` or `npm run db:migrate`
- Update API types: `types/index.ts` → `PublicUser` interface
- Update forms if needed: `components/forms/`

---

## 5. Landing Page & Routes

**Customizing Pages:**

- **Landing page:** `app/(public)/page.tsx`
- **About page:** `app/(public)/about/page.tsx`
- **Contact page:** `app/(public)/contact/page.tsx`
- **Dashboard:** `app/(protected)/dashboard/page.tsx`
- **Settings:** `app/(protected)/settings/page.tsx`
- **Profile:** `app/(protected)/profile/page.tsx`

**Adding New Pages:**

- **Public page:** Create `app/(public)/pricing/page.tsx` (uses public layout)
- **Protected page:** Create `app/(protected)/analytics/page.tsx` (uses protected layout)
- **Different layout:** Create new route group `app/(admin)/layout.tsx`

**Navigation:**

- Update layouts in route groups: `app/(public)/layout.tsx`, `app/(protected)/layout.tsx`
- Update navigation components as needed

---

## 6. Removing Features

**Testing Framework:**

- [ ] Delete `tests/` directory
- [ ] Delete `vitest.config.ts`
- [ ] Remove test scripts from `package.json` (`test`, `test:watch`, `test:coverage`)
- [ ] Uninstall: `npm uninstall vitest @vitest/ui happy-dom @testing-library/react @testing-library/user-event`

**Docker:**

- [ ] Delete `Dockerfile`, `Dockerfile.dev`
- [ ] Delete `docker-compose.yml`, `docker-compose.prod.yml`
- [ ] Delete `.dockerignore`
- [ ] Delete `DOCKER-TESTING.md`
- [ ] Remove Docker references from `README.md`

**OAuth Providers:**

- [ ] Remove provider configs from `lib/auth/config.ts`
- [ ] Remove env vars from `.env.local` and `.env.example`
- [ ] Remove provider buttons from login page

**Specific Pages/Features:**

- [ ] Delete route folders you don't need (e.g., `app/(protected)/profile/`)
- [ ] Remove corresponding API endpoints: `app/api/v1/[resource]/`
- [ ] Clean up navigation references

---

## 7. Reference Documentation

**Detailed Guides:**

- [Architecture Overview](./.context/architecture/overview.md) - System design, component structure
- [Authentication](./.context/auth/overview.md) - better-auth integration, OAuth flows
- [API Endpoints](./.context/api/endpoints.md) - REST API reference, request/response formats
- [Database Schema](./.context/database/schema.md) - Prisma models, relationships, migrations
- [Environment Variables](./.context/environment/reference.md) - Complete variable reference
- [Build Plan](./.instructions/SUNRISE-BUILD-PLAN.md) - Full implementation details

**Quick References:**

- Commands: `CLAUDE.md` → Essential Commands section
- Common tasks: `CLAUDE.md` → Common Tasks section
- Testing: `tests/README.md`
- Deployment: `.instructions/DEPLOYMENT.md`
