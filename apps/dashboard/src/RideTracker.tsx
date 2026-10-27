import type { RequestState } from '@dispatch/shared';
import { fmtDistance, fmtDuration } from './format';
import type { Ride } from './useRide';

/** Typical speed of a simulated driver heading to a pickup, for a rough "arriving in". */
const APPROACH_MPS = 11;

const STEPS: { label: string; states: RequestState[] }[] = [
  { label: 'Booked, looking for a driver', states: ['CREATED', 'SEARCHING'] },
  { label: 'Offer sent, driver deciding', states: ['OFFERED'] },
  { label: 'Driver on the way', states: ['ASSIGNED'] },
  { label: 'Picked up, in the car', states: ['PICKED_UP'] },
  { label: 'Trip finished', states: ['COMPLETED'] },
];

interface Props {
  ride?: Ride;
  /** Live straight-line distance from the driver to the pickup, when there is a driver. */
  driverDistanceM?: number;
  now: number;
  onClose(): void;
}

/**
 * Step-by-step story of the booking the user is following, pinned above the
 * tabs so it stays visible whatever tab is open.
 */
export function RideTracker({ ride, driverDistanceM, now, onClose }: Props) {
  if (!ride) {
    return (
      <section className="ride">
        <div className="ride-head">
          <h2>Your ride</h2>
        </div>
        <p className="muted">Booking…</p>
      </section>
    );
  }

  const failed = ride.state === 'UNASSIGNED' || ride.state === 'CANCELLED';
  const current = STEPS.findIndex((s) => s.states.includes(ride.state));
  const finished = ride.state === 'COMPLETED' || failed;
  const elapsed = (finished ? ride.updatedAt : now) - ride.createdAt;

  let detail: string | undefined;
  if (ride.state === 'OFFERED' && ride.attempts > 1) detail = `Driver #${ride.attempts}: earlier ones said no or didn't answer`;
  if (ride.state === 'ASSIGNED' && driverDistanceM !== undefined) {
    detail = `${fmtDistance(driverDistanceM)} away · arriving in about ${fmtDuration((driverDistanceM / APPROACH_MPS) * 1000)}`;
  }

  return (
    <section className={`ride ${failed ? 'failed' : ''}`} aria-live="polite">
      <div className="ride-head">
        <h2>Your ride</h2>
        <button className="link" onClick={onClose}>Close</button>
      </div>

      {failed ? (
        <p className="ride-failed">
          {ride.state === 'UNASSIGNED'
            ? 'No free driver could be reached. Try booking somewhere else on the map.'
            : 'This booking was cancelled.'}
        </p>
      ) : (
        <ol className="steps">
          {STEPS.map((s, i) => (
            <li key={s.label} className={i < current || ride.state === 'COMPLETED' ? 'done' : i === current ? 'now' : ''}>
              {s.label}
            </li>
          ))}
        </ol>
      )}

      {detail && <p className="ride-detail">{detail}</p>}
      <p className="ride-meta">
        {ride.agentId ? `Driver ${ride.agentId} · ` : ''}
        {finished ? 'took' : 'for'} {fmtDuration(elapsed)}
        {ride.priority !== 'normal' ? ` · ${ride.priority} priority` : ''}
      </p>
    </section>
  );
}
