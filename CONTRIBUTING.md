# Contributing to Sunrise

Thank you for your interest in contributing to Sunrise! This guide will help you get started.

## Code of Conduct

Be respectful and constructive. We're all here to build something useful together.

## Getting Started

### Prerequisites

- Node.js 20.19+ (or 22.12+, 24+)
- PostgreSQL 15+ (local, Docker, or hosted)
- Git

### Development Setup

```bash
# Clone the repository
git clone https://github.com/human-centric-engineering/sunrise
cd sunrise

# Install dependencies
npm install

# Set up environment
cp .env.example .env.local
# Edit .env.local with your DATABASE_URL and BETTER_AUTH_SECRET

# Set up database and seed test data
npm run db:migrate
npm run db:seed

# Start development server
npm run dev
```

**Using Docker instead:**

```bash
docker-compose up                              # Start app + database
docker-compose exec web npx prisma migrate dev # Run migrations
docker-compose exec web npm run db:seed        # Seed test data
```

## How to Contribute

### Reporting Issues

- Search existing issues first to avoid duplicates
- Use a clear, descriptive title
- Include steps to reproduce for bugs
- Specify your environment (Node version, OS, browser)

### Suggesting Features

- Open an issue with the "feature request" label
- Explain the use case and why it would be valuable
- Be open to discussion about implementation approaches

### Submitting Pull Requests

1. **Fork and clone** the repository
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature
   # or
   git checkout -b fix/your-fix
   ```
3. **Make your changes** following our coding standards
4. **Test your changes**:
   ```bash
   npm run test
   npm run validate  # type-check + lint + format
   npm run build     # ensure it builds
   ```
5. **Commit** using [Conventional Commits](https://www.conventionalcommits.org/):
   ```bash
   git commit -m "feat: add new feature"
   git commit -m "fix: resolve issue with X"
   ```
6. **Push** and create a pull request

## Coding Standards

### TypeScript

- No `any` types—use proper typing or `unknown` with type guards
- Validate external data with Zod schemas
- Use `@/` import aliases, not relative paths

### Code Style

- Run `npm run validate` before committing (hooks do this automatically)
- Keep changes focused—don't mix features with unrelated refactoring
- Write tests for new functionality

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add user invitation flow
fix: resolve login redirect issue
docs: update API documentation
test: add validation tests
chore: update dependencies
```

## Pull Request Process

1. Ensure all checks pass (`npm run validate`, `npm run build`, `npm run test`)
2. Update documentation if you're changing behavior
3. Add tests for new functionality
4. Keep PRs focused—one feature or fix per PR
5. Be responsive to review feedback

### What We Look For

- Code follows existing patterns in the codebase
- Tests are included for new functionality
- No unnecessary dependencies added
- Documentation updated where needed
- Commit messages are clear and follow conventions

## Project Structure

See `.context/substrate.md` for full documentation. Key areas:

```
app/           # Next.js App Router pages and API routes
components/    # React components (ui/ for primitives)
lib/           # Core utilities and business logic
prisma/        # Database schema and migrations
.context/      # Project documentation
```

## Questions?

- Check the documentation in `.context/`
- Open a discussion or issue on GitHub

Thank you for contributing!
