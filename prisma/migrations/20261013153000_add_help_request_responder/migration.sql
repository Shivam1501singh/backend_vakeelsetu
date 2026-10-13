-- AlterTable
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "respondedById" TEXT;
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "respondedByType" TEXT;
ALTER TABLE "HelpRequest" ADD COLUMN IF NOT EXISTS "respondedByName" TEXT;
