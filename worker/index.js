const FR24_BASE_URL = "https://fr24api.flightradar24.com/api/flight-summary/light";
const OPENSKY_BASE_URL = "https://opensky-network.org/api";
const AIRPLANES_LIVE_BASE_URL = "https://api.airplanes.live/v2";
const AIRLABS_BASE_URL = "https://airlabs.co/api/v9";
const DEFAULT_OPERATORS = ["QLK", "NJS", "SSQ", "QFA"];
const DEFAULT_AIRCRAFT = ["DH8D", "BCS1", "BCS3"];
const DEFAULT_AIRPORT_IATA = "BNE";
const DEFAULT_AIRPORT_ICAO = "YBBN";
const BNE_LAT = -27.3842;
const BNE_LON = 153.1175;
const DEFAULT_LIVE_RADIUS_NM = 250;
const CACHE_SECONDS = 30 * 60;
const AIRLABS_DETAIL_LIMIT = 12;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    if (url.pathname !== "/fids") {
      return json({ error: "Not found" }, 404, request);
    }

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), request);
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    try {
      const direction = normalizeDirection(url.searchParams.get("direction"));
      const filters = {
        airportIata: cleanCode(url.searchParams.get("airport")) || DEFAULT_AIRPORT_IATA,
        airportIcao: cleanCode(url.searchParams.get("airportIcao")) || DEFAULT_AIRPORT_ICAO,
        operators: codeList(url.searchParams.get("operators"), DEFAULT_OPERATORS),
        aircraft: codeList(url.searchParams.get("aircraft"), DEFAULT_AIRCRAFT)
      };

      const source = selectSource(url.searchParams.get("source"), env);
      const flights = await fetchFlightsForSource(source, url.searchParams, env, direction, filters);

      const response = json({
        fetchedAt: new Date().toISOString(),
        source,
        limitations: sourceLimitations(source),
        direction,
        data: flights
      }, 200, request, {
        "Cache-Control": `public, max-age=${CACHE_SECONDS}`
      });

      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    } catch (error) {
      return json({ error: error.message || "Unable to load FIDS data." }, 500, request);
    }
  }
};

async function fetchFlightsForSource(source, params, env, direction, filters) {
  if (direction === "both") {
    const arrivals = await fetchFlightsForSource(source, params, env, "arrivals", filters);
    const departures = await fetchFlightsForSource(source, params, env, "departures", filters);
    return [...arrivals, ...departures].sort(byBoardTime);
  }

  if (source === "forecast") return fetchForecastFlights(params, env, direction, filters);
  if (source === "airlabs") return fetchAirLabsSchedules(params, env, direction, filters);
  if (source === "fr24") return fetchFr24Flights(params, env, direction, filters);
  if (source === "opensky") return fetchOpenSkyFlights(params, direction, filters);
  return fetchAirplanesLiveFlights(params, direction, filters);
}

async function fetchForecastFlights(params, env, direction, filters) {
  const scheduled = await fetchAirLabsSchedules(params, env, direction, filters);
  const tracked = await fetchAirLabsTrackedFlights(params, env, direction, filters);
  const live = await fetchAirplanesLiveFlights(params, direction, filters);
  const typeTracked = await fetchAirplanesTypeFlights(filters);
  const enrichedScheduled = enrichSchedulesWithTypeTracked(scheduled, typeTracked, filters);
  return mergeFlights([...enrichedScheduled, ...tracked, ...live]).sort(byBoardTime);
}

async function fetchFr24Flights(params, env, direction, filters) {
  if (!env.FR24_API_KEY) {
    throw new Error("FR24_API_KEY secret is not configured. Use source=airplanes for the free test feed.");
  }

  const query = buildFr24Query(params);
  const fr24Url = `${FR24_BASE_URL}?${query.toString()}`;
  const fr24Response = await fetch(fr24Url, {
    headers: {
      "Authorization": `Bearer ${env.FR24_API_KEY}`,
      "Accept": "application/json",
      "Accept-Version": "v1"
    }
  });

  const payload = await fr24Response.json().catch(() => ({}));
  if (!fr24Response.ok) {
    throw new Error(payload.message || payload.error || `FR24 returned ${fr24Response.status}`);
  }

  return (payload.data || [])
    .map((flight) => trimFr24Flight(flight, direction))
    .filter((flight) => matchesBoard(flight, direction, filters))
    .sort(byBoardTime);
}

async function fetchAirplanesLiveFlights(params, direction, filters) {
  const radiusNm = clampNumber(params.get("liveRadiusNm"), 20, 250, DEFAULT_LIVE_RADIUS_NM);
  const response = await fetch(`${AIRPLANES_LIVE_BASE_URL}/point/${BNE_LAT}/${BNE_LON}/${radiusNm}`, {
    headers: { "Accept": "application/json" }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Airplanes.live returned ${response.status}`);
  }

  const now = Number(payload.now) || Date.now();
  return (payload.ac || payload.aircraft || [])
    .map((aircraft) => trimAirplanesLiveFlight(aircraft, direction, now))
    .filter((flight) => matchesOperator(flight, filters.operators))
    .filter((flight) => filters.aircraft.includes(flight.type))
    .filter((flight) => matchesLiveDirection(flight, direction))
    .sort((a, b) => a.distance_nm - b.distance_nm);
}

async function fetchAirplanesTypeFlights(filters) {
  const a220Types = filters.aircraft.filter((type) => /^BCS[13]$|^A22[13]$/.test(type));
  if (!a220Types.length) return [];

  const response = await fetch(`${AIRPLANES_LIVE_BASE_URL}/type/${a220Types.join(",")}`, {
    headers: { "Accept": "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) return [];

  return (payload.ac || payload.aircraft || [])
    .map(trimAirplanesAircraft)
    .filter((flight) => matchesOperator(flight, filters.operators))
    .filter((flight) => filters.aircraft.includes(flight.type));
}

async function fetchAirLabsSchedules(params, env, direction, filters) {
  if (!env.AIRLABS_API_KEY) {
    throw new Error("AIRLABS_API_KEY secret is not configured.");
  }

  const query = buildAirLabsQuery(params, env, direction, filters);
  const response = await fetch(`${AIRLABS_BASE_URL}/schedules?${query.toString()}`, {
    headers: { "Accept": "application/json" }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const message = payload.error?.message || payload.message || `AirLabs returned ${response.status}`;
    throw new Error(message);
  }

  const rows = Array.isArray(payload) ? payload : payload.response || payload.data || [];
  const flights = rows
    .map((flight) => trimAirLabsFlight(flight, direction))
    .filter((flight) => matchesOperator(flight, filters.operators))
    .filter((flight) => matchesScheduleAircraft(flight, filters.aircraft))
    .filter((flight) => flight.board_time)
    .sort(byBoardTime);

  return enrichAirLabsFlightDetails(flights, params, env, filters);
}

async function fetchAirLabsTrackedFlights(params, env, direction, filters) {
  if (!env.AIRLABS_API_KEY) {
    throw new Error("AIRLABS_API_KEY secret is not configured.");
  }

  const query = buildAirLabsQuery(params, env, direction, filters);
  const response = await fetch(`${AIRLABS_BASE_URL}/flights?${query.toString()}`, {
    headers: { "Accept": "application/json" }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    const message = payload.error?.message || payload.message || `AirLabs flights returned ${response.status}`;
    throw new Error(message);
  }

  const rows = Array.isArray(payload) ? payload : payload.response || payload.data || [];
  return rows
    .map((flight) => trimAirLabsFlight(flight, direction, { scheduled: false }))
    .filter((flight) => matchesOperator(flight, filters.operators))
    .filter((flight) => matchesScheduleAircraft(flight, filters.aircraft))
    .filter((flight) => flight.board_time)
    .sort(byBoardTime);
}

async function fetchOpenSkyFlights(params, direction, filters) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const lookBehindHours = clampNumber(params.get("lookBehindHours"), 1, 24, 12);
  const begin = nowSeconds - lookBehindHours * 60 * 60;
  const endpoint = direction === "arrivals" ? "arrival" : "departure";
  const openskyUrl = `${OPENSKY_BASE_URL}/flights/${endpoint}?${new URLSearchParams({
    airport: filters.airportIcao,
    begin: String(begin),
    end: String(nowSeconds)
  }).toString()}`;

  const response = await fetch(openskyUrl, {
    headers: { "Accept": "application/json" }
  });

  if (response.status === 404) return [];

  const payload = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(`OpenSky returned ${response.status}`);
  }

  return (Array.isArray(payload) ? payload : [])
    .map((flight) => trimOpenSkyFlight(flight, direction))
    .filter((flight) => matchesOperator(flight, filters.operators))
    .sort(byBoardTime);
}

function buildFr24Query(params) {
  const now = new Date();
  const lookBehindHours = clampNumber(params.get("lookBehindHours"), 1, 24, 6);
  const lookAheadHours = clampNumber(params.get("lookAheadHours"), 1, 24, 18);
  const from = new Date(now.getTime() - lookBehindHours * 60 * 60 * 1000);
  const to = new Date(now.getTime() + lookAheadHours * 60 * 60 * 1000);
  const direction = normalizeDirection(params.get("direction"));
  const airportIata = cleanCode(params.get("airport")) || DEFAULT_AIRPORT_IATA;
  const airportIcao = cleanCode(params.get("airportIcao")) || DEFAULT_AIRPORT_ICAO;
  const operators = codeList(params.get("operators"), DEFAULT_OPERATORS);
  const aircraft = codeList(params.get("aircraft"), DEFAULT_AIRCRAFT);
  const airportPrefix = direction === "arrivals" ? "inbound" : "outbound";

  return new URLSearchParams({
    flight_datetime_from: isoNoMs(from),
    flight_datetime_to: isoNoMs(to),
    operating_as: operators.join(","),
    aircraft: aircraft.join(","),
    airports: `${airportPrefix}:${airportIata},${airportPrefix}:${airportIcao}`,
    limit: "100",
    sort: "asc"
  });
}

function buildAirLabsQuery(params, env, direction, filters) {
  const query = new URLSearchParams({
    api_key: env.AIRLABS_API_KEY,
    airline_icao: filters.operators.join(","),
    limit: String(clampNumber(params.get("limit"), 1, 50, 50))
  });

  if (direction === "arrivals") {
    query.set("arr_iata", filters.airportIata);
  } else {
    query.set("dep_iata", filters.airportIata);
  }

  return query;
}

async function enrichAirLabsFlightDetails(flights, params, env, filters) {
  const detailLimit = clampNumber(params.get("detailLimit"), 0, 18, AIRLABS_DETAIL_LIMIT);
  const detailCandidates = flights
    .filter((flight) => needsAirLabsDetail(flight))
    .sort(prioritizeAirLabsDetail)
    .slice(0, detailLimit);
  const detailKeys = new Set(detailCandidates.map((flight) => flight.flight || flight.callsign).filter(Boolean));
  if (!detailKeys.size) return flights;

  const details = new Map();
  for (const flight of detailCandidates) {
    const detailed = await fetchAirLabsFlightDetail(flight, env);
    if (detailed) details.set(flight.flight || flight.callsign, detailed);
  }

  if (!details.size) return flights;

  return flights
    .map((flight) => {
      const detail = details.get(flight.flight || flight.callsign);
      if (!detail) return flight;
      const enriched = trimAirLabsFlight(detail, flight.movement === "departure" ? "departures" : "arrivals", {
        scheduled: flight.scheduled
      });
      return {
        ...flight,
        ...enriched,
        movement: flight.movement,
        board_time: enriched.board_time || flight.board_time,
        datetime_takeoff: enriched.datetime_takeoff || flight.datetime_takeoff,
        datetime_landed: enriched.datetime_landed || flight.datetime_landed,
        first_seen: enriched.first_seen || flight.first_seen,
        last_seen: enriched.last_seen || flight.last_seen,
        operated_as: enriched.operated_as || flight.operated_as,
        status: enriched.status || flight.status,
        scheduled: flight.scheduled
      };
    })
    .filter((flight) => matchesScheduleAircraft(flight, filters.aircraft));
}

async function fetchAirLabsFlightDetail(flight, env) {
  const flightIata = String(flight.flight_iata || "").trim().toUpperCase();
  const flightIcao = String(flight.flight_icao || flight.flight || flight.callsign || "").trim().toUpperCase();
  const lookups = [
    flightIata ? ["flight_iata", flightIata] : null,
    flightIcao ? ["flight_icao", flightIcao] : null
  ].filter(Boolean);

  for (const [param, value] of lookups) {
    const detail = await requestAirLabsFlightDetail(param, value, env);
    if (detail) return detail;
  }

  return null;
}

async function requestAirLabsFlightDetail(param, value, env) {
  const query = new URLSearchParams({
    api_key: env.AIRLABS_API_KEY,
    [param]: value
  });

  const response = await fetch(`${AIRLABS_BASE_URL}/flight?${query.toString()}`, {
    headers: { "Accept": "application/json" }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) return null;

  const rows = Array.isArray(payload) ? payload : payload.response || payload.data || [];
  if (Array.isArray(rows)) return rows[0] || null;
  return rows || null;
}

function needsAirLabsDetail(flight) {
  return Boolean((!flight.reg || flight.reg === "TBA" || !flight.type || flight.type === "TBA") && (flight.flight || flight.callsign));
}

function prioritizeAirLabsDetail(a, b) {
  return detailPriority(a) - detailPriority(b) || byBoardTime(a, b);
}

function detailPriority(flight) {
  const operator = String(flight.operated_as || "").toUpperCase();
  if (["NJS", "QLK", "SSQ"].includes(operator)) return 0;
  const flightNumber = Number(String(flight.flight || "").replace(/^[A-Z]+/, ""));
  if (operator === "QFA" && flightNumber >= 1200 && flightNumber <= 2999) return 1;
  if (operator === "QFA" && flightNumber >= 5000 && flightNumber <= 5999) return 2;
  return 3;
}

function enrichSchedulesWithTypeTracked(scheduledFlights, typeTrackedFlights, filters) {
  if (!typeTrackedFlights.length) return scheduledFlights;

  const byFlightNumber = new Map();
  for (const flight of typeTrackedFlights) {
    const number = flightNumber(flight.flight || flight.callsign);
    if (number) byFlightNumber.set(number, flight);
  }

  return scheduledFlights
    .map((flight) => {
      const tracked = byFlightNumber.get(flightNumber(flight.flight || flight.callsign));
      if (!tracked) return flight;
      return {
        ...flight,
        type: tracked.type || flight.type,
        reg: tracked.reg || flight.reg,
        flight: tracked.callsign || flight.flight,
        callsign: tracked.callsign || flight.callsign,
        live_tracking: true,
        flight_ended: false
      };
    })
    .filter((flight) => matchesScheduleAircraft(flight, filters.aircraft));
}

function flightNumber(value) {
  return String(value || "").replace(/^[A-Z]+/i, "").replace(/\D/g, "");
}

function trimFr24Flight(flight, direction) {
  const destination = flight.destination_icao_actual || flight.destination_icao || flight.dest_icao_actual || flight.dest_icao || "";
  const origin = flight.origin_icao || flight.orig_icao || "";
  return {
    fr24_id: flight.fr24_id || "",
    flight: flight.flight || "",
    callsign: flight.callsign || "",
    operated_as: flight.operated_as || "",
    painted_as: flight.painted_as || "",
    type: flight.type || "",
    reg: flight.reg || "",
    origin_icao: origin,
    destination_icao: destination,
    datetime_takeoff: flight.datetime_takeoff || "",
    datetime_landed: flight.datetime_landed || "",
    first_seen: flight.first_seen || "",
    last_seen: flight.last_seen || "",
    board_time: direction === "arrivals"
      ? flight.datetime_landed || flight.last_seen || flight.first_seen || ""
      : flight.datetime_takeoff || flight.first_seen || flight.last_seen || "",
    flight_ended: flight.flight_ended,
    movement: direction === "arrivals" ? "arrival" : "departure"
  };
}

function trimOpenSkyFlight(flight, direction) {
  const firstSeen = epochToIso(flight.firstSeen);
  const lastSeen = epochToIso(flight.lastSeen);
  const callsign = String(flight.callsign || "").trim();
  return {
    fr24_id: "",
    flight: callsign,
    callsign,
    operated_as: callsign.slice(0, 3),
    painted_as: "",
    type: "Unknown",
    reg: flight.icao24 ? flight.icao24.toUpperCase() : "",
    origin_icao: flight.estDepartureAirport || "",
    destination_icao: flight.estArrivalAirport || "",
    datetime_takeoff: firstSeen,
    datetime_landed: lastSeen,
    first_seen: firstSeen,
    last_seen: lastSeen,
    board_time: direction === "arrivals" ? lastSeen : firstSeen,
    flight_ended: true,
    movement: direction === "arrivals" ? "arrival" : "departure"
  };
}

function trimAirLabsFlight(flight, direction, options = {}) {
  const flightIcao = String(flight.flight_icao || "").trim().toUpperCase();
  const flightIata = String(flight.flight_iata || "").trim().toUpperCase();
  const callsign = flightIcao || flightIata;
  const type = cleanAircraftType(
    flight.aircraft_icao ||
    flight.aircraft_iata ||
    flight.aircraft_type ||
    flight.plane_icao ||
    flight.plane_iata ||
    flight.ac_icao ||
    flight.model_code ||
    ""
  );
  const reg = String(
    flight.reg_number ||
    flight.reg ||
    flight.aircraft_reg ||
    flight.aircraft_registration ||
    flight.plane_reg ||
    flight.registration ||
    ""
  ).trim().toUpperCase();
  const depTime = airLabsTime(flight.dep_actual_utc || flight.dep_estimated_utc || flight.dep_time_utc || flight.dep_actual || flight.dep_estimated || flight.dep_time);
  const arrTime = airLabsTime(flight.arr_actual_utc || flight.arr_estimated_utc || flight.arr_time_utc || flight.arr_actual || flight.arr_estimated || flight.arr_time);
  const boardTime = direction === "arrivals" ? arrTime : depTime;
  const status = String(flight.status || "scheduled").trim().toLowerCase();

  return {
    fr24_id: "",
    flight: callsign || String(flight.flight_number || "").trim(),
    callsign,
    flight_icao: flightIcao,
    flight_iata: flightIata,
    operated_as: String(flight.airline_icao || callsign.slice(0, 3)).trim().toUpperCase(),
    painted_as: "",
    type: type || "TBA",
    reg: reg || "TBA",
    origin_icao: flight.dep_icao || flight.dep_iata || "",
    destination_icao: flight.arr_icao || flight.arr_iata || "",
    datetime_takeoff: depTime,
    datetime_landed: arrTime,
    first_seen: depTime,
    last_seen: arrTime,
    board_time: boardTime,
    flight_ended: status === "landed" || status === "cancelled" || status === "diverted",
    movement: direction === "arrivals" ? "arrival" : "departure",
    status,
    scheduled: options.scheduled !== false
  };
}

function trimAirplanesLiveFlight(aircraft, direction, nowMs) {
  const seenSeconds = Number(aircraft.seen_pos ?? aircraft.seen ?? 0);
  const seenAt = new Date(nowMs - seenSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "");
  const callsign = String(aircraft.flight || "").trim();
  const verticalRate = numeric(aircraft.baro_rate ?? aircraft.geom_rate);
  const distanceNm = numeric(aircraft.dst);
  const altitude = aircraft.alt_baro === "ground" ? "ground" : numeric(aircraft.alt_baro);

  return {
    fr24_id: "",
    flight: callsign,
    callsign,
    operated_as: callsign.slice(0, 3),
    painted_as: "",
    type: aircraft.t || "Unknown",
    reg: aircraft.r || aircraft.hex || "",
    origin_icao: direction === "arrivals" ? "Live ADS-B" : DEFAULT_AIRPORT_IATA,
    destination_icao: direction === "arrivals" ? DEFAULT_AIRPORT_IATA : "Live ADS-B",
    datetime_takeoff: seenAt,
    datetime_landed: seenAt,
    first_seen: seenAt,
    last_seen: seenAt,
    board_time: seenAt,
    flight_ended: false,
    movement: direction === "arrivals" ? "arrival" : "departure",
    distance_nm: Number.isFinite(distanceNm) ? distanceNm : 999,
    vertical_rate_fpm: Number.isFinite(verticalRate) ? verticalRate : 0,
    altitude
  };
}

function trimAirplanesAircraft(aircraft) {
  const callsign = String(aircraft.flight || "").trim().toUpperCase();
  return {
    flight: callsign,
    callsign,
    operated_as: callsign.slice(0, 3),
    type: cleanAircraftType(aircraft.t || ""),
    reg: String(aircraft.r || aircraft.hex || "").trim().toUpperCase(),
    distance_nm: numeric(aircraft.dst),
    vertical_rate_fpm: numeric(aircraft.baro_rate ?? aircraft.geom_rate),
    altitude: aircraft.alt_baro === "ground" ? "ground" : numeric(aircraft.alt_baro)
  };
}

function matchesBoard(flight, direction, filters) {
  const airportCodes = new Set([filters.airportIata, filters.airportIcao]);
  const routeMatches = direction === "arrivals"
    ? airportCodes.has(flight.destination_icao)
    : airportCodes.has(flight.origin_icao);
  const operatorMatches = filters.operators.includes(flight.operated_as) || filters.operators.includes(flight.painted_as);
  const aircraftMatches = filters.aircraft.includes(flight.type);
  return routeMatches && operatorMatches && aircraftMatches;
}

function matchesOperator(flight, operators) {
  const callsign = String(flight.callsign || flight.flight || "").toUpperCase();
  return operators.some((operator) => callsign.startsWith(operator));
}

function matchesLiveDirection(flight, direction) {
  if (direction === "arrivals") {
    return flight.vertical_rate_fpm <= 0;
  }
  return flight.vertical_rate_fpm > 0;
}

function selectSource(value, env) {
  const source = String(value || "").toLowerCase();
  if (source === "forecast") return "forecast";
  if (source === "airlabs") return "airlabs";
  if (source === "fr24") return "fr24";
  if (source === "opensky") return "opensky";
  if (source === "airplanes") return "airplanes";
  if (env.AIRLABS_API_KEY) return "forecast";
  return env.FR24_API_KEY ? "fr24" : "airplanes";
}

function sourceLimitations(source) {
  if (source === "forecast") {
    return "AirLabs schedules and registered live/recent flights are combined with Airplanes.live ADS-B. AirLabs historical lookup is flight-number based, so airport-wide history depends on available schedule/live rows and the saved day log.";
  }
  if (source === "airlabs") {
    return "AirLabs free schedules are a rolling forecast, currently up to 10 hours ahead.";
  }
  if (source === "fr24") return "";
  return "Free ADS-B test feeds provide live nearby aircraft, not a scheduled airport FIDS.";
}

function mergeFlights(flights) {
  const byKey = new Map();
  for (const flight of flights) {
    const key = flightMergeKey(flight);
    byKey.set(key, { ...byKey.get(key), ...flight });
  }
  return [...byKey.values()];
}

function flightMergeKey(flight) {
  const reg = String(flight.reg || "").trim().toUpperCase();
  const type = String(flight.type || "").trim().toUpperCase();
  const movement = String(flight.movement || "").trim().toLowerCase();
  const time = String(flight.board_time || flight.last_seen || flight.first_seen || "").slice(0, 16);
  if (isKnownRegistration(reg)) return [movement, reg, type, time].join("|");
  return [movement, flightNumber(flight.flight || flight.callsign), type, time].join("|");
}

function byBoardTime(a, b) {
  return Date.parse(a.board_time || "") - Date.parse(b.board_time || "");
}

function normalizeDirection(value) {
  if (value === "both") return "both";
  return value === "departures" ? "departures" : "arrivals";
}

function codeList(value, fallback) {
  const codes = String(value || "")
    .split(",")
    .map(cleanCode)
    .filter(Boolean);
  return codes.length ? codes : fallback;
}

function cleanCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function cleanAircraftType(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function matchesScheduleAircraft(flight, aircraftTypes) {
  if (!flight.type || flight.type === "TBA" || flight.type === "UNKNOWN") return true;
  return aircraftTypes.includes(flight.type);
}

function isKnownRegistration(registration) {
  const reg = String(registration || "").trim().toUpperCase();
  return Boolean(reg && !["----", "TBA", "UNKNOWN", "N/A", "NA", "NULL"].includes(reg));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function isoNoMs(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function epochToIso(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds)) return "";
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "");
}

function airLabsTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d+$/.test(raw)) return epochToIso(raw);
  return raw
    .replace(" ", "T")
    .replace(/:\d{2}$/, (match) => match)
    .replace(/Z$/, "");
}

function json(payload, status, request, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders
    }
  });
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Vary": "Origin"
  };
}
