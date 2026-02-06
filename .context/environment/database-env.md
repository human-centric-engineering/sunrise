# Database Environment Variables

Configuration for PostgreSQL database connection via Prisma ORM.

## `DATABASE_URL`

- **Purpose:** PostgreSQL database connection string for Prisma ORM
- **Required:** ✅ Yes
- **Type:** URL (PostgreSQL format)
- **Format:** `postgresql://[user]:[password]@[host]:[port]/[database]?[params]`
- **Validation:** Must be a valid PostgreSQL connection string URL
- **Used By:**
  - `lib/db/client.ts` - Prisma client initialization
  - `prisma/schema.prisma` - Database migrations

## Examples

### Local Development

```bash
DATABASE_URL="postgresql://postgres:password@localhost:5432/sunrise_db"
```

### Docker Compose

Use the service name instead of localhost:

```bash
DATABASE_URL="postgresql://postgres:password@db:5432/sunrise_db"
```

### Production (with SSL)

```bash
DATABASE_URL="postgresql://user:pass@prod-db.example.com:5432/sunrise?sslmode=require"
```

## Common Parameters

| Parameter             | Description             | When to Use              |
| --------------------- | ----------------------- | ------------------------ |
| `sslmode=require`     | Enforce SSL connection  | Production (recommended) |
| `sslmode=disable`     | Disable SSL             | Local development only   |
| `schema=public`       | Use specific schema     | Multi-tenant setups      |
| `connection_limit=10` | Max connections in pool | High-traffic apps        |

## Environment-Specific Values

| Environment | Host                | SSL | Example                                                              |
| ----------- | ------------------- | --- | -------------------------------------------------------------------- |
| Local       | `localhost`         | No  | `postgresql://postgres:pass@localhost:5432/sunrise`                  |
| Docker      | `db` (service name) | No  | `postgresql://postgres:pass@db:5432/sunrise`                         |
| Production  | Cloud hostname      | Yes | `postgresql://user:pass@db.example.com:5432/sunrise?sslmode=require` |

## Troubleshooting

**Connection fails:**

- Ensure PostgreSQL is running: `pg_isready`
- Test connection: `psql $DATABASE_URL`
- Verify database exists: `psql -l`
- Check firewall rules if connecting to remote database

**"SSL required" error:**

- Add `?sslmode=require` to connection string
- Or for local dev: `?sslmode=disable`

**Docker connection fails:**

- Use service name (`db`) not `localhost`
- Ensure database service is running: `docker-compose ps`

## Related Documentation

- [Environment Overview](./overview.md) - Quick setup guide
- [Environment Reference](./reference.md) - All environment variables
- [Database Schema](../database/schema.md) - Prisma schema and migrations
