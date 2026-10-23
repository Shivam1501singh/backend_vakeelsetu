-- AlterTable
ALTER TABLE "ConsultancyRequest" ADD COLUMN "bookingId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ConsultancyRequest_bookingId_key" ON "ConsultancyRequest"("bookingId");
