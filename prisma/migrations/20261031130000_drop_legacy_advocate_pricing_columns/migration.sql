-- Phase B: Drop legacy per-minute charge columns from Advocate and DeletedAdvocate
ALTER TABLE "Advocate" DROP COLUMN IF EXISTS "videoCallChargePerMinute";
ALTER TABLE "Advocate" DROP COLUMN IF EXISTS "voiceCallChargePerMinute";

ALTER TABLE "DeletedAdvocate" DROP COLUMN IF EXISTS "videoCallChargePerMinute";
ALTER TABLE "DeletedAdvocate" DROP COLUMN IF EXISTS "voiceCallChargePerMinute";
