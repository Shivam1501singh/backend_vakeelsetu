-- CreateTable
CREATE TABLE "PincodeLocation" (
    "pincode" TEXT NOT NULL,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "formattedAddress" TEXT,
    "source" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PincodeLocation_pkey" PRIMARY KEY ("pincode")
);

-- CreateIndex
CREATE INDEX "PincodeLocation_fetchedAt_idx" ON "PincodeLocation"("fetchedAt");

