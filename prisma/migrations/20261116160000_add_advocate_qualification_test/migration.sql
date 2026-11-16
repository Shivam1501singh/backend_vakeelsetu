-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN "testPassedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AdvocateTestQuestion" (
    "id" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "correctOption" INTEGER NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "deletedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "updatedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocateTestQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvocateTestInvite" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sendAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvocateTestInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvocateTestAttempt" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "inviteId" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "answers" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "autoSubmitted" BOOLEAN NOT NULL DEFAULT false,
    "totalQuestions" INTEGER NOT NULL,
    "correctCount" INTEGER,
    "wrongCount" INTEGER,
    "passed" BOOLEAN,

    CONSTRAINT "AdvocateTestAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvocateTestQuestion_isActive_deletedAt_idx" ON "AdvocateTestQuestion"("isActive", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateTestInvite_tokenHash_key" ON "AdvocateTestInvite"("tokenHash");

-- CreateIndex
CREATE INDEX "AdvocateTestInvite_advocateId_createdAt_idx" ON "AdvocateTestInvite"("advocateId", "createdAt");

-- CreateIndex
CREATE INDEX "AdvocateTestInvite_status_sendAt_idx" ON "AdvocateTestInvite"("status", "sendAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateTestAttempt_inviteId_key" ON "AdvocateTestAttempt"("inviteId");

-- CreateIndex
CREATE INDEX "AdvocateTestAttempt_advocateId_startedAt_idx" ON "AdvocateTestAttempt"("advocateId", "startedAt");

-- AddForeignKey
ALTER TABLE "AdvocateTestInvite" ADD CONSTRAINT "AdvocateTestInvite_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateTestAttempt" ADD CONSTRAINT "AdvocateTestAttempt_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateTestAttempt" ADD CONSTRAINT "AdvocateTestAttempt_inviteId_fkey" FOREIGN KEY ("inviteId") REFERENCES "AdvocateTestInvite"("id") ON DELETE CASCADE ON UPDATE CASCADE;

