-- AlterTable Advocate: Add new pricing and duration columns
ALTER TABLE "Advocate" 
  ADD COLUMN "voiceCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "videoCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "officeVisitDurationMinutes" INTEGER;

-- AlterTable DeletedAdvocate: Add new pricing and duration columns for snapshot integrity
ALTER TABLE "DeletedAdvocate" 
  ADD COLUMN "voiceCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "videoCallPricePer15Min" DECIMAL(65,30),
  ADD COLUMN "officeVisitDurationMinutes" INTEGER;

-- Data copy for Advocate: voiceCallPricePer15Min = voiceCallChargePerMinute * 15
UPDATE "Advocate" 
  SET "voiceCallPricePer15Min" = "voiceCallChargePerMinute" * 15
  WHERE "voiceCallChargePerMinute" IS NOT NULL AND "voiceCallPricePer15Min" IS NULL;

-- Data copy for Advocate: videoCallPricePer15Min = videoCallChargePerMinute * 15
UPDATE "Advocate" 
  SET "videoCallPricePer15Min" = "videoCallChargePerMinute" * 15
  WHERE "videoCallChargePerMinute" IS NOT NULL AND "videoCallPricePer15Min" IS NULL;

-- Data copy for Advocate: officeVisitDurationMinutes = 60 if offlineVisitingFee is set
UPDATE "Advocate" 
  SET "officeVisitDurationMinutes" = 60
  WHERE "offlineVisitingFee" IS NOT NULL AND "officeVisitDurationMinutes" IS NULL;

-- Data copy for DeletedAdvocate snapshot
UPDATE "DeletedAdvocate" 
  SET "voiceCallPricePer15Min" = "voiceCallChargePerMinute" * 15
  WHERE "voiceCallChargePerMinute" IS NOT NULL AND "voiceCallPricePer15Min" IS NULL;

UPDATE "DeletedAdvocate" 
  SET "videoCallPricePer15Min" = "videoCallChargePerMinute" * 15
  WHERE "videoCallChargePerMinute" IS NOT NULL AND "videoCallPricePer15Min" IS NULL;

UPDATE "DeletedAdvocate" 
  SET "officeVisitDurationMinutes" = 60
  WHERE "offlineVisitingFee" IS NOT NULL AND "officeVisitDurationMinutes" IS NULL;

-- Update pendingProfileChange in drafts: voiceCallChargePerMinute -> voiceCallPricePer15Min (* 15)
UPDATE "Advocate"
  SET "pendingProfileChange" = (
    ("pendingProfileChange"::jsonb - 'voiceCallChargePerMinute' - 'voiceChargePerMinute')
    || CASE
         WHEN "pendingProfileChange"::jsonb -> 'voiceCallChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'voiceCallChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'voiceCallChargePerMinute') <> 'null'
         THEN jsonb_build_object('voiceCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'voiceCallChargePerMinute')::numeric * 15))
         WHEN "pendingProfileChange"::jsonb -> 'voiceChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'voiceChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'voiceChargePerMinute') <> 'null'
         THEN jsonb_build_object('voiceCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'voiceChargePerMinute')::numeric * 15))
         ELSE jsonb_build_object('voiceCallPricePer15Min', null)
       END
  )
  WHERE "pendingProfileChange" IS NOT NULL 
    AND ("pendingProfileChange"::jsonb ? 'voiceCallChargePerMinute' OR "pendingProfileChange"::jsonb ? 'voiceChargePerMinute');

-- Update pendingProfileChange in drafts: videoCallChargePerMinute -> videoCallPricePer15Min (* 15)
UPDATE "Advocate"
  SET "pendingProfileChange" = (
    ("pendingProfileChange"::jsonb - 'videoCallChargePerMinute' - 'videoChargePerMinute')
    || CASE
         WHEN "pendingProfileChange"::jsonb -> 'videoCallChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'videoCallChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'videoCallChargePerMinute') <> 'null'
         THEN jsonb_build_object('videoCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'videoCallChargePerMinute')::numeric * 15))
         WHEN "pendingProfileChange"::jsonb -> 'videoChargePerMinute' IS NOT NULL 
              AND "pendingProfileChange"::jsonb ->> 'videoChargePerMinute' IS NOT NULL
              AND jsonb_typeof("pendingProfileChange"::jsonb -> 'videoChargePerMinute') <> 'null'
         THEN jsonb_build_object('videoCallPricePer15Min', (("pendingProfileChange"::jsonb ->> 'videoChargePerMinute')::numeric * 15))
         ELSE jsonb_build_object('videoCallPricePer15Min', null)
       END
  )
  WHERE "pendingProfileChange" IS NOT NULL 
    AND ("pendingProfileChange"::jsonb ? 'videoCallChargePerMinute' OR "pendingProfileChange"::jsonb ? 'videoChargePerMinute');

-- Backfill draft officeVisitDurationMinutes to 60 if offlineVisitingFee is drafted without duration
UPDATE "Advocate"
  SET "pendingProfileChange" = "pendingProfileChange"::jsonb || jsonb_build_object('officeVisitDurationMinutes', 60)
  WHERE "pendingProfileChange" IS NOT NULL
    AND "pendingProfileChange"::jsonb ? 'offlineVisitingFee'
    AND jsonb_typeof("pendingProfileChange"::jsonb -> 'offlineVisitingFee') <> 'null'
    AND NOT ("pendingProfileChange"::jsonb ? 'officeVisitDurationMinutes');
