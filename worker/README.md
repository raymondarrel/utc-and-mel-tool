# BNE QantasLink FIDS Worker

This Cloudflare Worker keeps flight API keys out of `fids.html`.

The page currently defaults to `source=forecast`, which combines AirLabs airport schedules, AirLabs registered live/recent flights, and Airplanes.live's free public live aircraft endpoint near Brisbane. AirLabs historical lookup is flight-number based, so airport-wide day history comes from available schedule/live rows plus the saved operating-day log.

## Deploy

```powershell
npm install -g wrangler
wrangler login
cd worker
wrangler secret put AIRLABS_API_KEY
wrangler deploy
```

After deployment, paste the worker URL into the `Worker proxy URL` field on `fids.html`.

For the Airplanes.live-only test source, you can skip `wrangler secret put AIRLABS_API_KEY` and call `source=airplanes`.

For optional FR24 use later, add:

```powershell
wrangler secret put FR24_API_KEY
```

The frontend calls:

```text
/fids?airport=BNE&airportIcao=YBBN&direction=both&operators=QLK,NJS,SSQ,QFA&aircraft=DH8D,BCS1,BCS3&source=forecast
```

Defaults:

- Airport: Brisbane, `BNE` / `YBBN`
- Operators: `QLK,NJS,SSQ,QFA`
- Aircraft: `DH8D` for Q400, `BCS1` and `BCS3` for A220
- Refresh/cache: 30 minutes
- Current board: one row per aircraft registration, with arrivals and departures accumulated in browser storage for the Brisbane operating day from 04:00
