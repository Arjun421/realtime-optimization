CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS requests (
  id          uuid PRIMARY KEY,
  pickup      geography(Point, 4326) NOT NULL,
  priority    text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS requests_pickup_gix ON requests USING gist (pickup);
CREATE INDEX IF NOT EXISTS requests_created_at_idx ON requests (created_at);

-- Append-only history of everything that happened to a request. This is the
-- training data for the ETA / acceptance / demand models in later phases.
CREATE TABLE IF NOT EXISTS request_events (
  id          bigserial PRIMARY KEY,
  request_id  uuid NOT NULL,
  event       text NOT NULL,
  agent_id    text,
  data        jsonb,
  at          timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS request_events_request_idx ON request_events (request_id);
CREATE INDEX IF NOT EXISTS request_events_agent_idx ON request_events (agent_id, at);
