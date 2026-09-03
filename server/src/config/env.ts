import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

// Load server/.env first (if present), then the repo-root .env. Values already
// present in the real environment (e.g. injected by Render/Docker) always win.
for (const candidate of [
  path.join(__dirname, '..', '..', '.env'),
  path.join(__dirname, '..', '..', '..', '.env'),
]) {
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate });
}

const booleanish = z
  .string()
  .optional()
  .transform((v) => v === '1' || v?.toLowerCase() === 'true');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  REDIS_HOST: z.string().min(1).default('localhost'),
  REDIS_PORT: z.coerce.number().int().positive().default(6379),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: booleanish,

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('12h'),

  AWS_ACCESS_KEY_ID: z.string().min(1, 'AWS_ACCESS_KEY_ID is required'),
  AWS_SECRET_ACCESS_KEY: z.string().min(1, 'AWS_SECRET_ACCESS_KEY is required'),
  AWS_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1, 'S3_BUCKET is required'),
  S3_ENDPOINT: z.string().optional(),
  // Endpoint baked into presigned download URLs. Inside Docker the API reaches
  // storage at an internal hostname the browser cannot resolve, so signing must
  // use the externally reachable host. With Cloudflare R2 / AWS S3 both are the
  // same value and this can be left unset.
  S3_PUBLIC_ENDPOINT: z.string().optional(),
  S3_FORCE_PATH_STYLE: booleanish,
  S3_SIGNED_URL_TTL: z.coerce.number().int().positive().default(900),

  CLIENT_URL: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  EXPORT_BATCH_SIZE: z.coerce.number().int().positive().max(10000).default(1000),
  EXPORT_STALL_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(45),

  // Test-only fault injection. Empty/absent in production.
  EXPORT_CRASH_AFTER_ROWS: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() !== '' ? Number(v) : undefined)),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Fail loudly and immediately: a misconfigured process must never boot and
  // pretend to be healthy.
  const details = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;

/** Hard cap enforced by this assignment. */
export const MAX_ROW_LIMIT = 50_000;

/** CORS allowlist, comma separated. */
export const corsAllowlist = env.CLIENT_URL.split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export const isProduction = env.NODE_ENV === 'production';
