/* eslint-disable no-console */
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

const { Pool } = pg
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const adapter = new PrismaPg(pool)

const prisma = new PrismaClient({ adapter })

async function main() {
  console.log('🌱 Seeding database...')

  // Clear existing data (in development only)
  if (process.env.NODE_ENV === 'development') {
    console.log('🗑️  Clearing existing data...')
    await prisma.verificationToken.deleteMany()
    await prisma.session.deleteMany()
    await prisma.account.deleteMany()
    await prisma.user.deleteMany()
  }

  // Create test users
  console.log('👤 Creating test users...')

  const testUser = await prisma.user.create({
    data: {
      email: 'test@example.com',
      name: 'Test User',
      emailVerified: new Date(),
      role: 'USER',
      // Note: In production, this would be a hashed password
      // For now, we'll add password hashing in Phase 1.4 (Authentication)
      password: null,
    },
  })

  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@example.com',
      name: 'Admin User',
      emailVerified: new Date(),
      role: 'ADMIN',
      password: null,
    },
  })

  console.log(`✅ Created test user: ${testUser.email}`)
  console.log(`✅ Created admin user: ${adminUser.email}`)

  console.log('🎉 Seeding complete!')
}

main()
  .catch((e) => {
    console.error('❌ Seeding failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
