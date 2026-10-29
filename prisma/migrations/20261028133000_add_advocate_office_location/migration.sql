-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN     "officeLatitude" DOUBLE PRECISION,
ADD COLUMN     "officeLocationUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "officeLongitude" DOUBLE PRECISION,
ADD COLUMN     "officePhotoPublicId" TEXT,
ADD COLUMN     "officePhotoUrl" TEXT;

