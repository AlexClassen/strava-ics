// File: api/strava-ics.ts
// Vercel Serverless Function that exposes an always-fresh ICS feed of your Strava activities.
// Subscribe to the resulting URL in Apple Calendar as a "Subscribed Calendar".
//
// ENV required (add in Vercel Project Settings → Environment Variables):
// - STRAVA_CLIENT_ID
// - STRAVA_CLIENT_SECRET
// - STRAVA_REFRESH_TOKEN  (long‑lived refresh token you obtain once; see README steps)
// Optional query params when subscribing:
// - sport=run,ride,swim (comma‑separated list to filter types) e.g. ?sport=run,ride
// - tz=Europe/Vienna (IANA timezone; defaults to activity.start_date_local from Strava)
// - sinceDays=30 (only include last N days; default 90)
// - max=300 (max activities to include; default 300)

import type { VercelRequest, VercelResponse } from "@vercel/node";

// Minimal helper: fetch wrapper
async function jfetch<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return res.json() as Promise<T>;
}

// Exchange refresh token for short‑lived access token
async function getAccessToken() {
  const client_id = process.env.STRAVA_CLIENT_ID;
  const client_secret = process.env.STRAVA_CLIENT_SECRET;
  const refresh_token = process.env.STRAVA_REFRESH_TOKEN;
  if (!client_id || !client_secret || !refresh_token) {
    throw new Error("Missing STRAVA env vars");
  }
  const token = await jfetch<{ access_token: string }>(
    "https://www.strava.com/oauth/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id,
        client_secret,
        grant_type: "refresh_token",
        refresh_token,
      }),
    }
  );
  return token.access_token;
}

// Types for the subset of Strava activity fields we care about
interface StravaActivity {
  id: number;
  name: string;
  type: string; // Deprecated in Strava, but still present; also see sport_type
  sport_type: string; // e.g., Run, Ride, Walk, Hike, Swim, VirtualRide
  start_date: string; // UTC
  start_date_local: string; // local ISO
  timezone: string; // e.g., "(GMT+01:00) Europe/Vienna"
  elapsed_time: number; // seconds
  moving_time: number; // seconds
  distance: number; // meters
  total_elevation_gain: number; // meters
  average_speed?: number; // m/s
  max_speed?: number; // m/s
  kudos_count?: number;
  location_city?: string | null;
  location_state?: string | null;
  location_country?: string | null;
  start_latlng?: [number, number] | null;
  end_latlng?: [number, number] | null;
  map?: { summary_polyline?: string };
}

function toTitleCase(s: string) {
  return s.replace(/\w\S*/g, (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());
}

function metersToKm(m: number) {
  return (m / 1000).toFixed(2);
}

function secondsToHMS(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

// ICS helpers
function icsEscape(text: string) {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function formatAsUTC(dt: Date) {
  // yyyymmddThhmmssZ
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    dt.getUTCFullYear().toString() +
    pad(dt.getUTCMonth() + 1) +
    pad(dt.getUTCDate()) +
    "T" +
    pad(dt.getUTCHours()) +
    pad(dt.getUTCMinutes()) +
    pad(dt.getUTCSeconds()) +
    "Z"
  );
}

function buildEvent(a: StravaActivity) {
  const start = new Date(a.start_date); // already UTC
  const end = new Date(start.getTime() + a.elapsed_time * 1000);

  const summary = `Strava: ${a.name || a.sport_type}`;
  const url = `https://www.strava.com/activities/${a.id}`;

  const descParts = [
    `Sport: ${a.sport_type || a.type}`,
    `Distance: ${metersToKm(a.distance)} km`,
    `Moving: ${secondsToHMS(a.moving_time)}`,
    `Elapsed: ${secondsToHMS(a.elapsed_time)}`,
  ];
  if (a.total_elevation_gain) descParts.push(`Elevation: ${Math.round(a.total_elevation_gain)} m`);
  descParts.push(url);

  const description = icsEscape(descParts.join("\n"));
  const uid = `${a.id}@strava-ics`;
  const dtstamp = formatAsUTC(new Date());

  let location = "";
  if (a.location_city || a.location_state || a.location_country) {
    const parts = [a.location_city, a.location_state, a.location_country].filter(Boolean);
    location = icsEscape(parts.join(", "));
  }

  return [
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${formatAsUTC(start)}`,
    `DTEND:${formatAsUTC(end)}`,
    `SUMMARY:${icsEscape(summary)}`,
    location ? `LOCATION:${location}` : "",
    `DESCRIPTION:${description}`,
    `URL:${url}`,
    "END:VEVENT",
  ]
    .filter(Boolean)
    .join("\r\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const accessToken = await getAccessToken();

    const sportsParam = (Array.isArray(req.query.sport) ? req.query.sport.at(0) : req.query.sport) as
      | string
      | undefined;
    const allowedSports = sportsParam ? sportsParam.split(",").map((s) => s.trim().toLowerCase()) : undefined;

    const sinceDays = Math.max(1, Math.min(365, Number(req.query.sinceDays ?? 90)));
    const after = Math.floor((Date.now() - sinceDays * 24 * 3600 * 1000) / 1000); // unix seconds

    const max = Math.max(1, Math.min(600, Number(req.query.max ?? 300)));

    // Page through activities until we hit 'max' or out of pages
    let page = 1;
    const per_page = 200; // Strava max per page
    const activities: StravaActivity[] = [];

    while (activities.length < max) {
      const batch = await jfetch<StravaActivity[]>(
        `https://www.strava.com/api/v3/athlete/activities?after=${after}&page=${page}&per_page=${per_page}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!batch.length) break;
      for (const a of batch) {
        if (activities.length >= max) break;
        const sport = (a.sport_type || a.type || "").toLowerCase();
        if (allowedSports && !allowedSports.includes(sport)) continue;
        activities.push(a);
      }
      page += 1;
    }

    // Build ICS
    const prodId = "-//NexClass//Strava ICS//EN";
    const calName = "Strava";
    const now = formatAsUTC(new Date());

    const events = activities.map(buildEvent).join("\r\n");

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      `PRODID:${prodId}`,
      `NAME:${calName}`,
      `X-WR-CALNAME:${calName}`,
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-TIMEZONE:UTC`,
      events,
      "END:VCALENDAR",
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=60"); // edge cache 5 min
    res.status(200).send(ics);
  } catch (err: any) {
    res.status(500).send(`BEGIN:VCALENDAR\r\nPRODID:-//Strava ICS Error//EN\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nSUMMARY:Strava ICS Error\r\nDESCRIPTION:${icsEscape(err.message || String(err))}\r\nDTSTART:${formatAsUTC(new Date())}\r\nDTEND:${formatAsUTC(new Date(Date.now() + 600000))}\r\nEND:VEVENT\r\nEND:VCALENDAR`);
  }
}
