# How to Use This Build Plan - Guide for Claude Code

This guide explains how to approach building Sunrise using the comprehensive build plan.

## Overview

You have three key documents:
1. **SUNRISE-BUILD-PLAN.md** - The comprehensive plan (source of truth)
2. **BUILD-PROGRESS-TRACKER.md** - Checklist to track progress
3. **This file** - How to use them effectively

## Approach

### 1. Read First, Code Second

Before writing any code:
- Read the entire section you're about to implement
- Understand the "why" not just the "what"
- Note any dependencies on other sections
- Check if environment variables are needed

### 2. One Feature at a Time

**DO:**
- Complete one feature fully before moving to the next
- Test each feature as you build it
- Check off items in the progress tracker
- Commit after each completed feature

**DON'T:**
- Skip ahead to exciting features
- Leave features half-finished
- Commit untested code
- Ignore the build order

### 3. Iterative Development

Think of this as building in layers:

**Layer 1: Make it work**
- Get the feature functioning
- Basic error handling
- Minimal styling

**Layer 2: Make it right**
- Proper error handling
- Type safety
- Validation
- Security considerations

**Layer 3: Make it nice**
- Good styling
- Loading states
- Error messages
- Documentation

### 4. When to Refer to the Plan

Reference the build plan when:
- Starting a new feature
- Unsure about architecture decisions
- Need to know what files to create
- Wondering about implementation details
- Making a decision that affects other features

The plan is your guide - use it liberally.

## Build Order (The Path)

### Start Here: Week 1
1. Set up the Next.js project
2. Get Tailwind and shadcn/ui working
3. Connect the database
4. Get basic auth working

**Checkpoint:** Can you run `npm run dev` and see a login page?

### Week 2: Authentication
5. Build all auth pages
6. Test login/signup flow
7. Add Google OAuth
8. Test password reset

**Checkpoint:** Can a user sign up, log in, and reset their password?

### Week 3: Core Features
9. Build the API structure
10. Create user management pages
11. Add validation

**Checkpoint:** Can users manage their profile? Does the API work?

### Week 4-5: Polish & Docker
12. Add developer tools (ESLint, Prettier, tests)
13. Create Docker setup
14. Test deployment locally

**Checkpoint:** Does everything work in Docker?

### Week 6-7: Production & Docs
15. Add email system
16. Build landing page
17. Write all documentation
18. Security hardening

**Checkpoint:** Is it production-ready?

### Week 8: Phase 4 Docs
19. Write optional feature guides
20. Final testing
21. Create examples

**Checkpoint:** Could someone fork this and customize it?

## Decision Making

When you need to make a decision not covered in the plan:

### Framework Questions
**Ask yourself:**
1. Does this follow Next.js best practices?
2. Is this the simplest solution?
3. Will AI agents understand this code?
4. Is this maintainable?

**Choose:**
- Simpler over clever
- Standard over custom
- Documented over undocumented
- Type-safe over loose

### Architecture Questions
**Ask yourself:**
1. Does this belong in `/lib` or `/components`?
2. Is this server-side or client-side?
3. Should this be a utility or a component?
4. Where will this be used?

**Guidelines:**
- `/lib` = utilities, business logic, clients
- `/components` = React components
- `/app` = pages and API routes
- `/types` = TypeScript types

### Styling Questions
**Ask yourself:**
1. Should I use shadcn/ui or custom?
2. Inline Tailwind or extracted component?
3. Does this need dark mode support?

**Guidelines:**
- Use shadcn/ui for standard components
- Use Tailwind utilities directly
- Support dark mode everywhere
- Responsive by default

## Code Quality Checks

Before marking a feature complete:

### Functionality
- [ ] Feature works as expected
- [ ] Edge cases handled
- [ ] Error states work
- [ ] Loading states work

### Code Quality
- [ ] TypeScript types are correct
- [ ] No `any` types (use proper types)
- [ ] Functions have clear names
- [ ] Comments explain "why" not "what"

### Standards
- [ ] Follows project structure
- [ ] Matches code style
- [ ] Has proper error handling
- [ ] Validates user input

### Documentation
- [ ] Feature documented in README or docs/
- [ ] Complex logic has comments
- [ ] Environment variables documented
- [ ] Examples provided if needed

## Common Patterns

### Creating a New Page
```typescript
// app/(group)/page-name/page.tsx
export default function PageName() {
  // Server component by default
  return <div>Content</div>
}
```

### Creating an API Route
```typescript
// app/api/v1/resource/route.ts
import { NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  try {
    // Logic
    return Response.json({ success: true, data: {} })
  } catch (error) {
    return Response.json({ 
      success: false, 
      error: { message: 'Error message' } 
    }, { status: 500 })
  }
}
```

### Creating a Form
```typescript
// components/forms/example-form.tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { exampleSchema } from '@/lib/validations/example'

export function ExampleForm() {
  const form = useForm({
    resolver: zodResolver(exampleSchema)
  })
  
  // Form implementation
}
```

### Creating a Utility
```typescript
// lib/utils/example.ts
/**
 * Description of what this does
 * @param input - What the parameter is
 * @returns What it returns
 */
export function exampleUtility(input: string): string {
  // Implementation
  return result
}
```

## Testing Strategy

### When to Test
- After each major feature
- Before committing
- When changing critical code
- Before deployment

### How to Test
1. **Manual Testing:**
   - Run the feature in the browser
   - Try to break it (bad input, edge cases)
   - Test on different screen sizes
   - Test dark mode

2. **Unit Tests (for critical code):**
   - Auth utilities
   - Validation functions
   - API utilities
   - Data transformations

3. **Integration Tests (for APIs):**
   - Test API endpoints
   - Test auth flows
   - Test database operations

### Testing Checklist
- [ ] Feature works on first try
- [ ] Feature handles errors gracefully
- [ ] Invalid input is rejected
- [ ] Loading states show
- [ ] Success messages show
- [ ] Works in dark mode
- [ ] Works on mobile

## Debugging Approach

When something doesn't work:

### 1. Check the Basics
- Is the server running?
- Are environment variables set?
- Is the database connected?
- Are there console errors?

### 2. Check the Code
- Review recent changes
- Check TypeScript errors
- Look at network requests
- Inspect database queries

### 3. Use the Tools
- Browser DevTools
- Next.js error messages
- Prisma Studio (for database)
- `console.log` (then remove it)

### 4. Refer to Docs
- Check the build plan
- Check Next.js docs
- Check library docs
- Check previous examples in codebase

## Git Workflow

### Commit Messages
```
feat: add user profile page
fix: resolve login redirect issue
docs: update deployment guide
refactor: simplify auth utilities
test: add validation tests
```

### Commit Frequency
- After completing each feature
- After fixing a bug
- After writing documentation
- Before switching context

### What to Commit
- All code changes
- Configuration changes
- Documentation updates
- Test files

### What NOT to Commit
- `.env.local` (only `.env.example`)
- `node_modules/`
- `.next/`
- Personal notes
- Debug code

## Progress Tracking

### Daily
1. Check progress tracker
2. Update status section
3. Note any blockers
4. Plan next steps

### Weekly
1. Review completed features
2. Test everything together
3. Update main README if needed
4. Commit all progress

### Phase Complete
1. Run full test suite
2. Review all documentation
3. Test deployment
4. Mark phase complete in tracker

## Communication with Human

When to ask for clarification:
- Requirements are unclear
- Multiple approaches seem valid
- Decision impacts architecture
- You're blocked on external factors

How to ask:
1. Explain what you're trying to do
2. Present the options you've considered
3. Explain pros/cons of each
4. Ask for guidance

## Staying on Track

### Red Flags 🚩
- Working on features out of order
- Skipping tests
- Ignoring errors
- Not updating documentation
- Creating complex solutions for simple problems

### Green Flags ✅
- Following the build order
- Testing as you go
- Writing clear code
- Documenting as you build
- Asking for clarification when needed

## Remember

1. **This is iterative** - You don't need to be perfect on the first pass
2. **Document as you go** - Future you will thank present you
3. **Test everything** - Bugs compound if not caught early
4. **Keep it simple** - Simple code is maintainable code
5. **Use the plan** - It's your roadmap, follow it

## Quick Reference

**Before starting a feature:**
- [ ] Read the relevant section in the build plan
- [ ] Check dependencies on other features
- [ ] Note environment variables needed
- [ ] Understand the acceptance criteria

**While building:**
- [ ] Follow the code patterns
- [ ] Add TypeScript types
- [ ] Handle errors properly
- [ ] Test as you go

**Before marking complete:**
- [ ] Feature works correctly
- [ ] Code is clean and documented
- [ ] Tests pass (if applicable)
- [ ] Progress tracker updated
- [ ] Changes committed

## Success Metrics

You're doing well if:
- Features work on first deployment
- Code is easy to understand
- Documentation is helpful
- New developers can onboard quickly
- The app is stable and secure

---

## Final Thought

Building Sunrise is like constructing a house:
- **Foundation first** (Phase 1)
- **Walls and roof** (Phase 2)  
- **Utilities and finishing** (Phase 3)
- **Landscaping plans** (Phase 4)

Don't try to landscape before you have walls. Follow the phases, build thoughtfully, and you'll create something great.

Happy building! 🚀
