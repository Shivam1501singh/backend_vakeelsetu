// scripts/seed-test-questions.js
// One-time seeding of the advocate qualification test question bank.
//
// Usage (from the backend repo root):
//   node scripts/seed-test-questions.js --dry-run   (default; no DB writes)
//   node scripts/seed-test-questions.js --apply
//
// Expects scripts/data/advocate_test_questions.json next to it.
// Idempotent: a question with the same text (case-insensitive) that is not soft-deleted is skipped.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';

const apply = process.argv.includes('--apply');
const prisma = new PrismaClient();

const dataPath = fileURLToPath(new URL('./data/advocate_test_questions.json', import.meta.url));
const questions = JSON.parse(readFileSync(dataPath, 'utf8'));

function validate(q, i) {
  const errs = [];
  if (typeof q.question !== 'string' || q.question.trim().length < 5 || q.question.length > 1000) errs.push('question length');
  if (!Array.isArray(q.options) || q.options.length !== 4) errs.push('needs exactly 4 options');
  else {
    const trimmed = q.options.map((o) => String(o).trim());
    if (trimmed.some((o) => o.length < 1 || o.length > 300)) errs.push('option length');
    if (new Set(trimmed.map((o) => o.toLowerCase())).size !== 4) errs.push('duplicate options');
  }
  if (!Number.isInteger(q.correctOption) || q.correctOption < 0 || q.correctOption > 3) errs.push('correctOption 0..3');
  if (errs.length) throw new Error(`Question #${i + 1} invalid: ${errs.join(', ')}`);
}

async function main() {
  const host = (process.env.DATABASE_URL || '').split('@')[1]?.split('/')[0] || 'unknown';
  console.log(`DB host: ${host}`);
  console.log(`Mode: ${apply ? 'APPLY' : 'DRY-RUN'}`);
  questions.forEach(validate);

  const existing = await prisma.advocateTestQuestion.findMany({
    where: { deletedAt: null },
    select: { question: true },
  });
  const existingSet = new Set(existing.map((e) => e.question.trim().toLowerCase()));

  const toCreate = questions.filter((q) => !existingSet.has(q.question.trim().toLowerCase()));
  console.log(`In file: ${questions.length} | already in DB: ${questions.length - toCreate.length} | to create: ${toCreate.length}`);

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to insert.');
    return;
  }

  let created = 0;
  for (const q of toCreate) {
    await prisma.advocateTestQuestion.create({
      data: {
        question: q.question.trim(),
        options: q.options.map((o) => String(o).trim()),
        correctOption: q.correctOption,
        isActive: q.isActive !== false,
        createdBy: 'seed-script',
      },
    });
    created += 1;
  }
  const active = await prisma.advocateTestQuestion.count({ where: { isActive: true, deletedAt: null } });
  console.log(`Created: ${created}. Active questions now: ${active}`);
}

main()
  .catch((e) => { console.error(e.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

