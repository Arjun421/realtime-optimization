# Demo script (3–4 minutes)

A walkthrough of the live dashboard for an interview or a screen share: what to click, and what to say.

## Before you start

Start everything about 5 minutes early, so the trend lines on top have filled in:

```bash
AGENTS=10000 REQUESTS_PER_SEC=10 npm run dev
```

Open the dashboard URL that Vite prints (usually http://localhost:5173). Add `?theme=dark` for dark mode.

## 1. The big picture (30 s)

**Show:** the whole map.

> "This is a live control room for a ride or ambulance service in Delhi. Every dot is a driver: 10,000 of them,
> simulated, all moving and sending GPS every 3 seconds. Blue are free, grey are busy. The red circles are customers
> waiting for a driver."

## 2. The four numbers on top (30 s)

**Point at:** the tiles.

> "These are what an operations team watches: free drivers, customers waiting, how long until a driver accepts
> (typically about 3 seconds) and how long until pickup. The lines are the last 5 minutes, live."

## 3. Book a ride live (60 s), the moment people remember

**Do:** click an empty spot on the map.

> "Let me book a ride right here."

**Point at:** the map zooming in to the red pin, the line to the driver, and the **Your ride** card at the top of the
panel as it ticks through *Looking for a driver* → *Offer sent* → *Driver on the way (distance, arriving in…)*. If the
first driver says no, the card says so and the next one is asked.

> "The system searched nearby drivers, ranked them, locked the best one so no other booking can take them, and sent
> an offer, in about 5 milliseconds. The amber line is the offer. The driver has 8 seconds; if they say no, it
> automatically asks the next best driver."

## 4. Smarter than "closest" (30 s)

**Hover:** the ⓘ next to *Choosing a driver*.

> "It doesn't just pick the closest driver. It weighs travel time, how likely that driver is to accept, and whether
> taking them would leave their own area empty. Against nearest-driver, that cut requests that found nobody from 7.3%
> to 5.4% in my benchmark."

## 5. Real-world problems (45 s)

**Click:** the **Alerts** tab. Tick *Blocked GPS jump* in the legend.

> "Areas running short of drivers are flagged, but only if it lasts, so one noisy second doesn't raise an alarm. And bad
> GPS: if a phone claims the driver jumped 10 km in 3 seconds, the reading is thrown away, because that would mean
> 10,000 km/h. The purple rings are blocked readings."

## 6. Engineering (45 s)

**Click:** the **System** tab.

> "Picking a driver takes about 5 milliseconds at the median. There's a request queue in front of dispatch: in k6 load
> tests the system collapsed around 700 requests a second without it, and stayed up at 1,500 a second with it, with
> extra bookings getting a quick 'try again' instead of everyone slowing down."

## 7. Machine learning (20 s)

> "I trained models on the system's own event log. Pickup-time prediction went from 20 seconds of error to 4, and the
> demand forecast per area improved by 22%. Driver acceptance turned out not to be predictable from this data, and the
> README says so rather than hiding it."

## Likely questions

- **How do you stop two bookings getting the same driver?** The claim is one atomic Redis Lua script: it checks the
  driver is free and the booking is still searching, and locks both in one step, so nothing can happen in between.
- **What if the server restarts mid-offer?** Offer deadlines live in Redis, not in memory, so they survive a restart and
  work across several API instances.
- **Where does the data come from?** A simulator. There's no real driver data; the models learn from the system's own
  event log of simulated runs. The point is the full pipeline, which works the same with real data.
- **Why is the ML so simple?** The simulated world is simple (straight-line driving, random accept rates), and more
  complex models (gradient boosting) were tried and did not do better on held-out data.
