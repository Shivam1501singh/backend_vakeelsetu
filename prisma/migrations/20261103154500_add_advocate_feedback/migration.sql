-- AlterTable
ALTER TABLE "Feedback" ADD COLUMN "userType" TEXT NOT NULL DEFAULT 'USER',
ADD COLUMN "advocateId" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Feedback_advocateId_idx" ON "Feedback"("advocateId");

-- CreateIndex
CREATE INDEX "Feedback_userType_idx" ON "Feedback"("userType");

-- AddForeignKey
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
