ALTER TABLE slots ADD COLUMN external_id TEXT;
UPDATE slots SET external_id = id::text;
ALTER TABLE slots ALTER COLUMN external_id SET NOT NULL;
ALTER TABLE slots ALTER COLUMN external_id SET DEFAULT gen_random_uuid()::text;
ALTER TABLE slots ADD CONSTRAINT slots_external_id_key UNIQUE (external_id);
ALTER TABLE slots ADD COLUMN provider TEXT NOT NULL DEFAULT 'Clinic';
ALTER TABLE slots DROP CONSTRAINT slots_starts_at_key;
CREATE INDEX slots_provider_chronological ON slots (provider, starts_at, external_id);

ALTER TABLE bookings ALTER COLUMN name TYPE TEXT;
ALTER TABLE idempotency_keys ALTER COLUMN key TYPE TEXT;
ALTER TABLE idempotency_keys ADD COLUMN request_body JSONB;

-- Bring historical replay snapshots into the new public response contract.
UPDATE idempotency_keys
SET response_body = (response_body->'booking') - 'cancelled_at'
WHERE response_body ? 'booking';

UPDATE idempotency_keys
SET response_status = CASE
        WHEN response_body->'error'->>'message' = 'This appointment slot has already started.' THEN 400
        ELSE response_status
    END,
    response_body = jsonb_build_object('error', response_body->'error'->>'message')
WHERE jsonb_typeof(response_body->'error') = 'object';