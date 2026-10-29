-- AlterTable
ALTER TABLE "Advocate" ADD COLUMN     "pendingProfileChange" JSONB,
ADD COLUMN     "profileChangeRejectionReason" TEXT,
ADD COLUMN     "profileChangeReviewedAt" TIMESTAMP(3),
ADD COLUMN     "profileChangeReviewedBy" TEXT,
ADD COLUMN     "profileChangeStatus" TEXT,
ADD COLUMN     "profileChangeSubmittedAt" TIMESTAMP(3),
ADD COLUMN     "profileChangeUpdatedAt" TIMESTAMP(3);

