import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { defineConfig } from 'prisma/config';

// Load server/.env first (if present), then fall back to the repo-root .env.
for (const candidate of [
  path.join(__dirname, '.env'),
  path.join(__dirname, '..', '.env'),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

/**
 * Prisma 7 moved the datasource connection URL out of schema.prisma.
 * The CLI (migrate/studio) reads it from here; the runtime PrismaClient gets it
 * through the pg driver adapter in src/config/prisma.ts.
 */
export default defineConfig({
  schema: path.join(__dirname, 'prisma', 'schema.prisma'),
  migrations: { path: path.join(__dirname, 'prisma', 'migrations') },
  // Only declared when present: `prisma generate` needs no database connection
  // (it runs during the Docker image build), while `prisma migrate` reports a
  // missing URL itself with a far better message than a config-load crash.
  ...(process.env.DATABASE_URL ? { datasource: { url: process.env.DATABASE_URL } } : {}),
});
