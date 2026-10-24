-- CreateEnum
CREATE TYPE "AdvocateBookingMode" AS ENUM ('VOICE_CALL', 'VIDEO_CALL', 'IN_PERSON');

-- CreateEnum
CREATE TYPE "AdvocateBookingStatus" AS ENUM ('HOLD', 'CONFIRMED', 'COMPLETED', 'EXPIRED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('CONSULTANCY', 'ADVOCATE_BOOKING');

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "advocateBookingId" TEXT,
ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'CONSULTANCY',
ALTER COLUMN "callType" DROP NOT NULL,
ALTER COLUMN "duration" DROP NOT NULL;

-- CreateTable
CREATE TABLE "AdvocateBooking" (
    "id" TEXT NOT NULL,
    "bookingId" TEXT,
    "userId" TEXT NOT NULL,
    "advocateId" TEXT NOT NULL,
    "mode" "AdvocateBookingMode" NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "ratePerMinutePaise" INTEGER,
    "feePaise" INTEGER NOT NULL,
    "gstPercent" INTEGER NOT NULL,
    "gstPaise" INTEGER NOT NULL,
    "platformFeePaise" INTEGER NOT NULL,
    "totalPaise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "userName" TEXT NOT NULL,
    "userPhone" TEXT NOT NULL,
    "userEmail" TEXT NOT NULL,
    "advocateName" TEXT NOT NULL,
    "status" "AdvocateBookingStatus" NOT NULL DEFAULT 'HOLD',
    "holdExpiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "refundedAt" TIMESTAMP(3),
    "refundReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvocateBooking_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdvocateBooking_bookingId_key" ON "AdvocateBooking"("bookingId");

-- CreateIndex
CREATE INDEX "AdvocateBooking_advocateId_startAt_idx" ON "AdvocateBooking"("advocateId", "startAt");

-- CreateIndex
CREATE INDEX "AdvocateBooking_userId_createdAt_idx" ON "AdvocateBooking"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "AdvocateBooking_status_idx" ON "AdvocateBooking"("status");

-- CreateIndex
CREATE INDEX "AdvocateBooking_startAt_idx" ON "AdvocateBooking"("startAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_advocateBookingId_key" ON "Payment"("advocateBookingId");

-- CreateIndex
CREATE INDEX "Payment_purpose_idx" ON "Payment"("purpose");

-- AddForeignKey
ALTER TABLE "AdvocateBooking" ADD CONSTRAINT "AdvocateBooking_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvocateBooking" ADD CONSTRAINT "AdvocateBooking_advocateId_fkey" FOREIGN KEY ("advocateId") REFERENCES "Advocate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_advocateBookingId_fkey" FOREIGN KEY ("advocateBookingId") REFERENCES "AdvocateBooking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

