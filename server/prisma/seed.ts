/**
 * Prisma seed: creates a demo account and ensures the records table holds the
 * 60,000+ rows the export assignment requires.
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../src/config/prisma';
import { generateTestData } from '../src/scripts/generateTestData';

const DEMO_EMAIL = 'demo@exportvault.dev';
const DEMO_PASSWORD = 'ExportVault123!';

async function main(): Promise<void> {
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const user = await prisma.user.upsert({
    where: { email: DEMO_EMAIL },
    update: {},
    create: { name: 'Demo Operator', email: DEMO_EMAIL, passwordHash },
  });
  console.log(`Demo user ready: ${user.email} / ${DEMO_PASSWORD}`);

  const result = await generateTestData({ target: 60_000, reset: false });
  console.log(`Records available: ${result.total}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('Seed failed:', error);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
