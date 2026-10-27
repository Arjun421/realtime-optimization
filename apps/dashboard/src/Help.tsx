import { useEffect } from 'react';

/** Plain-English guide to the dashboard, opened from the "?" button. */
export function Help({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={(e) => e.stopPropagation()}>
        <button className="help-close" onClick={onClose} aria-label="Close guide">×</button>
        <h2 id="help-title">How to read this dashboard</h2>
        <p>
          This is the control room of a ride or ambulance service in Delhi. A simulator invents the drivers and
          the customers; everything else (choosing a driver, sending the offer, handling a "no") is the real system.
        </p>

        <h3>The map</h3>
        <ul>
          <li><b>Small dots are drivers.</b> Blue are free, amber are deciding on an offer (they have 8 seconds), grey are busy.</li>
          <li><b>Big red circles are customers waiting for a driver.</b> When an offer goes out, an amber line joins the customer to that driver.</li>
          <li><b>Outlined squares</b> are areas that have been short of free drivers for a while.</li>
          <li>Hover anything for details. Click a dot to follow it in the side panel. <b>Click an empty spot to book a ride there</b> and watch it get a driver.</li>
        </ul>

        <h3>The numbers on top</h3>
        <ul>
          <li><b>Free drivers / Customers waiting</b>: right now, with the last 5 minutes as a line (hover it).</li>
          <li><b>Time to get a driver</b>: from booking until a driver says yes. <b>Time until pickup</b>: until the driver arrives.</li>
          <li>"Typical" is the median: half of customers waited less. "95% within" is the slow end.</li>
        </ul>

        <h3>The side panel</h3>
        <ul>
          <li><b>Overview</b>: what is happening, in plain words.</li>
          <li><b>Alerts</b>: areas short of drivers, and GPS readings the system threw away because they would mean driving at 1,000+ km/h.</li>
          <li><b>System</b>: engineering numbers: how many milliseconds each decision takes, and the request queue.</li>
        </ul>
      </div>
    </div>
  );
}
