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
  - `prisma/schema/` - Database migrations

## `MIGRATE_DATABASE_URL`

- **Purpose:** The privileged (owner) DSN for migrations, seeds and `db:tenancy:*`
- **Required:** ❌ No
- **Type:** PostgreSQL connection string
- **Default:** falls back to `DATABASE_URL`
- **Used By:** `prisma.config.ts` (every `prisma migrate`), `prisma/seed.ts`
  (`db:seed`), `scripts/db/tenancy-enable.ts`, `scripts/db/tenancy-role.ts`

At `TENANCY_MODE=single` leave it unset: one DSN does everything, which is
the shape the template ships. At `multi` the app connects (`DATABASE_URL`) as
a restricted `NOBYPASSRLS` role that does not own the tables — a table's
owner, and any `BYPASSRLS` role such as Neon's `neondb_owner`, is never
subject to the isolation policies — while migrations, seeds and the enable
switch keep the owner. This variable names the owner. See
[`.context/tenancy/isolation.md#the-role-split`](../tenancy/isolation.md#the-role-split).

## `DATABASE_POOL_MAX`

- **Purpose:** Maximum pg connections held by this process
- **Required:** ❌ No
- **Type:** Positive integer
- **Default:** `10`
- **Used By:** `lib/db/client.ts` — the `pg` `Pool` constructor

The default of 10 is node-postgres's own, and it fits Sunrise's documented
deploy target: one long-running process that wants a warm pool.

**Set it to `1` on serverless.** On a function-per-request platform each warm
instance holds its own pool, so 20 instances × 10 = 200 connections against a
Postgres that may allow far fewer. The symptom is intermittent
`too many connections` / `remaining connection slots are reserved` errors that
track traffic rather than any particular query. `DATABASE_POOL_MAX=1` is only
safe **behind a transaction pooler**, which multiplexes those single connections:

| Platform | Pooled connection string      |
| -------- | ----------------------------- |
| Neon     | the `-pooler` host            |
| Supabase | port `:6543` (not `:5432`)    |
| Vercel   | `POSTGRES_PRISMA_URL`         |
| Self-run | PgBouncer in transaction mode |

Point `DATABASE_URL` at the pooled endpoint, then set `DATABASE_POOL_MAX=1`.
Setting it to 1 against a direct (unpooled) connection serialises every query in
the instance instead — slow, not broken, but not what you want.

The pool also sets `idleTimeoutMillis` and `connectionTimeoutMillis` to 10s,
neither configurable. The connection timeout is what makes exhaustion legible: a
request that cannot get a connection fails fast with an error instead of hanging
until the platform kills the function.

```bash
# Serverless, behind Neon's pooler
DATABASE_URL="postgresql://user:pass@ep-xxx-pooler.eu-west-2.aws.neon.tech/sunrise?sslmode=require"
DATABASE_POOL_MAX=1
```

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
