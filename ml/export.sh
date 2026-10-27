#!/usr/bin/env bash
# Exports training data from the event history in Postgres to ml/data/*.csv.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p ml/data
psql() { docker compose exec -T postgres psql -U dispatch -q -c "$1"; }

# Every scored offer and how it ended: accepted, rejected or timed out.
psql "\copy (
  select o.request_id, o.agent_id, extract(epoch from o.at) * 1000 as at_ms,
         (o.data->>'pAccept')::float as p_accept, (o.data->>'distanceM')::float as distance_m,
         (o.data->>'attempt')::int as attempt, (o.data->>'candidates')::int as candidates,
         o.data->>'strategy' as strategy, r.priority, outcome.event as outcome
  from request_events o
  join requests r on r.id = o.request_id
  cross join lateral (
    select e.event from request_events e
    where e.request_id = o.request_id and e.agent_id = o.agent_id
      and e.event in ('ASSIGNED', 'OFFER_REJECTED', 'OFFER_TIMEOUT') and e.at >= o.at
    order by e.at limit 1
  ) outcome
  where o.event = 'OFFERED' and o.data ? 'pAccept'
) to stdout csv header" > ml/data/offers.csv

# Accepted offers: straight-line distance at offer time vs the real drive to pickup.
psql "\copy (
  select a.request_id, (o.data->>'distanceM')::float as distance_m,
         extract(epoch from (p.at - a.at)) as pickup_s, extract(epoch from a.at) * 1000 as at_ms
  from request_events a
  join request_events p on p.request_id = a.request_id and p.event = 'PICKED_UP'
  cross join lateral (
    select data from request_events o
    where o.request_id = a.request_id and o.agent_id = a.agent_id and o.event = 'OFFERED' and o.at <= a.at
    order by o.at desc limit 1
  ) o
  where a.event = 'ASSIGNED'
) to stdout csv header" > ml/data/pickups.csv

# Every booking's location and time, for demand.
psql "\copy (
  select id, st_y(pickup::geometry) as lat, st_x(pickup::geometry) as lng,
         extract(epoch from created_at) * 1000 as at_ms
  from requests
) to stdout csv header" > ml/data/requests.csv

wc -l ml/data/*.csv
