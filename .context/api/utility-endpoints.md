# Utility API Endpoints

System utility endpoints for health checks, security, and public forms.

## Health Check

✅ **Implemented in:** `app/api/health/route.ts`

**Purpose**: System health monitoring for load balancers and monitoring tools

```
GET /api/health
```

**Authentication**: None required

**Response** (200 OK):

```json
{
  "status": "ok",
  "timestamp": "2025-12-12T10:00:00.000Z",
  "version": "1.0.0",
  "uptime": 3600,
  "database": "connected"
}
```

**Response** (503 Service Unavailable - database disconnected):

```json
{
  "status": "error",
  "timestamp": "2025-12-12T10:00:00.000Z",
  "database": "disconnected"
}
```

**Use Cases**:

- Load balancer health checks
- Kubernetes liveness/readiness probes
- Uptime monitoring services (e.g., Pingdom, UptimeRobot)
- Container orchestration

## CSP Violation Report

✅ **Implemented in:** `app/api/csp-report/route.ts`

**Purpose**: Receive Content-Security-Policy violation reports from browsers

```
POST /api/csp-report
```

**Authentication**: None (browsers send reports automatically)

**Rate Limit**: 100 requests per minute per IP

**Request Body** (sent automatically by browser):

```json
{
  "csp-report": {
    "document-uri": "https://example.com/page",
    "violated-directive": "script-src",
    "blocked-uri": "https://evil.com/script.js",
    "source-file": "https://example.com/page",
    "line-number": 10
  }
}
```

**Response**: `204 No Content`

**Use Cases**:

- Monitor CSP violations in production
- Identify overly restrictive CSP policies
- Detect potential XSS attempts

**Note**: The CSP header in `proxy.ts` includes `report-uri /api/csp-report` to enable automatic reporting.

## Contact Form

✅ **Implemented in:** `app/api/v1/contact/route.ts`

**Purpose**: Submit a contact form message (public endpoint)

```
POST /api/v1/contact
```

**Authentication**: None (public endpoint)

**Rate Limit**: 5 requests per hour per IP

**Request Body**:

```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "subject": "Question about Sunrise",
  "message": "I'd like to learn more about your product...",
  "website": ""
}
```

**Validation**: Uses `contactWithHoneypotSchema` from `lib/validations/contact.ts`

- `name`: Required, max 100 characters
- `email`: Required, valid email format
- `subject`: Required, max 200 characters
- `message`: Required, min 10 characters, max 5000 characters
- `website`: Honeypot field - must be empty (hidden from real users)

**Response** (200 OK):

```json
{
  "success": true,
  "data": {
    "message": "Thank you for your message. We will get back to you soon."
  }
}
```

**Response Headers**:

```
X-RateLimit-Limit: 5
X-RateLimit-Remaining: 4
X-RateLimit-Reset: 1704067200
```

**Error Responses**:

- **400 Validation Error**: Invalid request body
  ```json
  {
    "success": false,
    "error": {
      "message": "Invalid request body",
      "code": "VALIDATION_ERROR",
      "details": {
        "errors": [{ "path": "email", "message": "Invalid email format" }]
      }
    }
  }
  ```
- **429 Rate Limit Exceeded**: Too many requests
  ```json
  {
    "success": false,
    "error": {
      "message": "Rate limit exceeded. Please try again later.",
      "code": "RATE_LIMIT_EXCEEDED"
    }
  }
  ```

### Processing Flow

1. Check rate limit (5/hour per IP)
2. Validate request body (including honeypot check)
3. Store submission in `ContactSubmission` database table
4. Send email notification to `CONTACT_EMAIL` or `EMAIL_FROM` (non-blocking)
5. Return success response

### Spam Prevention

- **Honeypot field**: The `website` field is hidden via CSS. Bots that auto-fill all fields will trigger this. When triggered, the API returns a success response (to not tip off the bot) but doesn't process the submission.
- **Rate limiting**: 5 submissions per hour per IP address prevents abuse.

### Email Notification

- Sent to `CONTACT_EMAIL` environment variable (falls back to `EMAIL_FROM`)
- If neither is configured, no email is sent (submission is still stored)
- Uses `ContactNotificationEmail` template from `emails/contact-notification.tsx`
- Includes sender's email in `Reply-To` header for easy response

**Note**: Submissions are always stored in the database regardless of email configuration.

## Related Documentation

- [API Overview](./endpoints.md) - API design principles and common patterns
- [Security Overview](../security/overview.md) - CSP and rate limiting configuration
- [Email Overview](../email/overview.md) - Email configuration
