# Utility API Endpoints

System utility endpoints for health checks, security, and public forms.

## Health Check

**Implemented in:** `app/api/health/route.ts`

**Purpose**: System health monitoring for load balancers and monitoring tools

```
GET /api/health
```

**Authentication**: None required

**Response** (200 OK):

```json
{
  "status": "ok",
  "version": "1.0.0",
  "uptime": 3600,
  "timestamp": "2026-01-15T10:00:00.000Z",
  "services": {
    "database": {
      "status": "operational",
      "connected": true,
      "latency": 5
    }
  }
}
```

**Response** (503 Service Unavailable - database disconnected):

```json
{
  "status": "error",
  "version": "1.0.0",
  "uptime": 3600,
  "timestamp": "2026-01-15T10:00:00.000Z",
  "services": {
    "database": {
      "status": "outage",
      "connected": false
    }
  }
}
```

**Response Fields**:

- `status`: Overall health (`ok` or `error`)
- `version`: Application version from package.json
- `uptime`: Server uptime in seconds
- `timestamp`: ISO timestamp of the check
- `services.database.status`: `operational`, `degraded` (latency > 500ms), or `outage`
- `services.database.connected`: Boolean connection status
- `services.database.latency`: Query latency in milliseconds (when connected)
- `memory`: Optional memory stats (enabled via `HEALTH_INCLUDE_MEMORY=true`)

**Use Cases**:

- Load balancer health checks
- Kubernetes liveness/readiness probes
- Uptime monitoring services (e.g., Pingdom, UptimeRobot)
- Container orchestration

## CSP Violation Report

**Implemented in:** `app/api/csp-report/route.ts`

**Purpose**: Receive Content-Security-Policy violation reports from browsers

```
POST /api/csp-report
```

**Authentication**: None (browsers send reports automatically)

**Rate Limit**: 20 requests per minute per IP

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

**Note**: The CSP header includes `report-uri /api/csp-report` to enable automatic reporting in production.

## Contact Form

**Implemented in:** `app/api/v1/contact/route.ts`

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

**Error Responses**:

- **400 Validation Error**: Invalid request body
- **429 Rate Limit Exceeded**: Too many requests

### Spam Prevention

- **Honeypot field**: The `website` field is hidden via CSS. Bots that auto-fill all fields trigger this. Returns success (to not tip off the bot) but doesn't process the submission.
- **Rate limiting**: 5 submissions per hour per IP.

### Email Notification

- Sent to `CONTACT_EMAIL` environment variable (falls back to `EMAIL_FROM`)
- If neither configured, submission is still stored but no email sent
- Uses `ContactNotificationEmail` template
- Includes sender's email in `Reply-To` header

**Note**: Submissions are always stored in the database regardless of email configuration.

## Related Documentation

- [API Overview](./endpoints.md) - API design principles and common patterns
- [API Headers](./headers.md) - CSP and rate limiting configuration
- [Email Overview](../email/overview.md) - Email configuration
