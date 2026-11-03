-- CreateTable
CREATE TABLE "AdvocateEarningLedger" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "advocateBookingId" TEXT,
    "withdrawalId" TEXT,
    "note" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvocateEarningLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvocatePayoutAccount" (
    "id" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocatePayoutAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvocateWithdrawal" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "ifsc" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankAccountChanged" BOOLEAN NOT NULL DEFAULT false,
    "holderNameMatches" BOOLEAN NOT NULL DEFAULT true,
    "approvedAt" TIMESTAMP(3),
    "approvedBy" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidBy" TEXT,
    "utr" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocateWithdrawal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvocateEarningLedger_advocateId_createdAt_idx" ON "AdvocateEarningLedger"("advocateId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateEarningLedger_type_advocateBookingId_key" ON "AdvocateEarningLedger"("type", "advocateBookingId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocatePayoutAccount_advocateId_key" ON "AdvocatePayoutAccount"("advocateId");

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateWithdrawal_withdrawalId_key" ON "AdvocateWithdrawal"("withdrawalId");

-- CreateIndex
CREATE INDEX "AdvocateWithdrawal_advocateId_status_idx" ON "AdvocateWithdrawal"("advocateId", "status");

-- CreateIndex
CREATE INDEX "AdvocateWithdrawal_status_createdAt_idx" ON "AdvocateWithdrawal"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "AdvocateEarningLedger" ADD CONSTRAINT "AdvocateEarningLedger_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateEarningLedger" ADD CONSTRAINT "AdvocateEarningLedger_advocateBookingId_fkey" FOREIGN KEY ("advocateBookingId") REFERENCES "AdvocateBooking"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateEarningLedger" ADD CONSTRAINT "AdvocateEarningLedger_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "AdvocateWithdrawal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocatePayoutAccount" ADD CONSTRAINT "AdvocatePayoutAccount_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateWithdrawal" ADD CONSTRAINT "AdvocateWithdrawal_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

