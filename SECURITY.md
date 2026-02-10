# Security Policy

## Supported Versions

We release security updates for the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue in Sunrise, please report it responsibly.

### How to Report

**Please DO NOT open a public GitHub issue for security vulnerabilities.**

Instead, report security issues privately:

1. **GitHub Security Advisories** (preferred):
   - Go to the [Security tab](https://github.com/human-centric-engineering/sunrise/security/advisories)
   - Click "Report a vulnerability"
   - Provide detailed information about the vulnerability

2. **Email**:
   - Send details to: security@human-centric.engineering
   - Include "SECURITY" in the subject line

### What to Include

Please provide as much information as possible:

- Description of the vulnerability
- Steps to reproduce the issue
- Potential impact
- Suggested fix (if you have one)
- Your contact information for follow-up

### Response Timeline

- **Initial response**: Within 48 hours
- **Status update**: Within 7 days
- **Fix timeline**: Varies by severity (critical issues prioritized)

### Security Best Practices for Sunrise Users

When deploying Sunrise in production:

1. **Environment Variables**:
   - Never commit `.env.local` or `.env.production` to version control
   - Use strong, randomly-generated secrets for `BETTER_AUTH_SECRET`
   - Rotate secrets regularly

2. **Database**:
   - Use strong database passwords
   - Restrict database access to application servers only
   - Enable SSL/TLS for database connections in production

3. **Dependencies**:
   - Run `npm audit` regularly
   - Keep dependencies up to date
   - Monitor for security advisories

4. **Rate Limiting**:
   - Configure appropriate rate limits for your use case (see `lib/security/rate-limit.ts`)
   - Use Redis for distributed rate limiting in production

5. **Headers & CORS**:
   - Review security headers in `middleware.ts`
   - Configure CORS appropriately for your domain

6. **Monitoring**:
   - Enable error tracking (Sentry is pre-configured)
   - Monitor authentication logs for suspicious activity
   - Set up alerts for unusual patterns

### Known Security Features

Sunrise includes these security features out of the box:

- Rate limiting on authentication endpoints
- CSRF protection via better-auth
- Secure password hashing (bcrypt via better-auth)
- Input validation with Zod
- Security headers (CSP, HSTS, X-Frame-Options, etc.)
- SQL injection protection via Prisma
- XSS protection via React and input sanitization

### Acknowledgments

We appreciate security researchers who responsibly disclose vulnerabilities. With your permission, we'll acknowledge your contribution in our release notes.
