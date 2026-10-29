-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN     "officeAddress" TEXT,
ADD COLUMN     "officeChangeRejectionReason" TEXT,
ADD COLUMN     "officeChangeRequestedAt" TIMESTAMP(3),
ADD COLUMN     "officeChangeReviewedAt" TIMESTAMP(3),
ADD COLUMN     "officeChangeStatus" TEXT,
ADD COLUMN     "pendingOfficeChange" JSONB;

-- AlterTable
ALTER TABLE "RegistrationSession" ADD COLUMN     "officeAddress" TEXT,
ADD COLUMN     "officeLatitude" DOUBLE PRECISION,
ADD COLUMN     "officeLongitude" DOUBLE PRECISION,
ADD COLUMN     "officePhotoPublicId" TEXT,
ADD COLUMN     "officePhotoUrl" TEXT;
