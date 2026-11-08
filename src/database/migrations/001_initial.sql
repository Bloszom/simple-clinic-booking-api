CREATE TABLE slots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    starts_at TIMESTAMPTZ NOT NULL UNIQUE,
    ends_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
    CONSTRAINT slots_positive_duration CHECK (ends_at > starts_at)
);

CREATE TABLE bookings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id UUID NOT NULL REFERENCES slots(id) ON DELETE RESTRICT,
    name VARCHAR(120) NOT NULL CHECK (length(btrim(name)) > 0),
    email VARCHAR(254) NOT NULL CHECK (email = lower(btrim(email)) AND length(email) > 0),
    status VARCHAR(16) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
    cancelled_at TIMESTAMPTZ,
    CONSTRAINT bookings_cancellation_consistent CHECK (
        (status = 'confirmed' AND cancelled_at IS NULL) OR
        (status = 'cancelled' AND cancelled_at IS NOT NULL)
    )
);

-- Only live bookings compete for a slot; cancellation retains history and frees it.
CREATE UNIQUE INDEX bookings_one_active_per_slot ON bookings (slot_id) WHERE status = 'confirmed';
CREATE INDEX bookings_email_page ON bookings (email, created_at DESC, id DESC);
CREATE INDEX bookings_page ON bookings (created_at DESC, id DESC);
CREATE INDEX slots_chronological ON slots (starts_at, id);

CREATE TABLE idempotency_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(128) NOT NULL UNIQUE,
    request_hash CHAR(64) NOT NULL,
    response_status SMALLINT CHECK (response_status BETWEEN 200 AND 599),
    response_body JSONB,
    response_headers JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT idempotency_response_complete CHECK (
        (response_status IS NULL AND response_body IS NULL AND response_headers IS NULL) OR
        (response_status IS NOT NULL AND response_body IS NOT NULL AND response_headers IS NOT NULL)
    )
);

CREATE TABLE booking_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(254) NOT NULL CHECK (email = lower(btrim(email))),
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX booking_attempts_email_window ON booking_attempts (email, attempted_at);
CREATE INDEX booking_attempts_retention ON booking_attempts (attempted_at);