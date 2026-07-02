// RouteWing — Edge Function: POST /functions/v1/directions
// Proxies Google Directions API server-side so GOOGLE_SERVER_KEY never reaches the
// client. Body: { waypoints: {lat,lng}[], profile: "foot"|"driving" }.
// Returns { snappedPoints, allCoords, actual } — the exact shape the client's
// fetchMultiWaypointRoute() already returns — or `null` on any failure, so the
// client's existing BRouter/free-provider fallback chain keeps working unchanged.
//
// Also serves snapToRoad(): called with waypoints=[pt, pt] (origin===destination),
// same trick the old client-side DirectionsService call used to get a road-snapped
// point back in snappedPoints[0].
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → name
// "directions" → paste this file → Deploy. Requires the GOOGLE_SERVER_KEY secret
// (Edge Functions → Secrets) and the route_cache table (see ../../step3_schema.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://routewing.vercel.app",
  "https://pattanan-th.github.io",
  "http://localhost:8080",
];
// Vercel preview-deploy URLs are dynamic subdomains of this project.
const VERCEL_PREVIEW_RE = /^https:\/\/routewing-[a-z0-9]+-i-ton\.vercel\.app$/;

function corsHeaders(origin: string | null): HeadersInit {
  const allowed = !!origin && (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
    "Content-Type": "application/json",
  };
}

const GOOGLE_KEY = Deno.env.get("GOOGLE_SERVER_KEY")!;
const supabaseAdmin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;

async function sha256(str: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Standard Google encoded-polyline decoder (overview_polyline.points from the REST API
// — the JS SDK's overview_path did this decoding for us; the REST API doesn't).
function decodePolyline(encoded: string) {
  const points: { lat: number; lng: number }[] = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b: number;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers });

  try {
    const { waypoints, profile } = await req.json();
    if (!Array.isArray(waypoints) || waypoints.length < 2) {
      return new Response(JSON.stringify(null), { headers });
    }

    const mode = profile === "driving" ? "driving" : "walking";
    const cacheKeyStr = `directions|${mode}|` +
      waypoints.map((p: any) => `${round5(p.lat)},${round5(p.lng)}`).join(";");
    const cacheKey = await sha256(cacheKeyStr);

    const { data: cached } = await supabaseAdmin
      .from("route_cache").select("payload, hit_count").eq("cache_key", cacheKey).maybeSingle();

    if (cached) {
      // Fire-and-forget hit-count bump — doesn't block the response.
      supabaseAdmin.from("route_cache")
        .update({ hit_count: cached.hit_count + 1, last_hit_at: new Date().toISOString() })
        .eq("cache_key", cacheKey).then(() => {});
      return new Response(JSON.stringify(cached.payload), { headers });
    }

    const first = waypoints[0], last = waypoints[waypoints.length - 1];
    const mid = waypoints.slice(1, -1);
    const params = new URLSearchParams({
      origin: `${first.lat},${first.lng}`,
      destination: `${last.lat},${last.lng}`,
      mode,
      key: GOOGLE_KEY,
    });
    if (mid.length) params.set("waypoints", mid.map((p: any) => `${p.lat},${p.lng}`).join("|"));

    const gRes = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const gJson = await gRes.json();
    const route = gJson.status === "OK" ? gJson.routes?.[0] : null;
    if (!route) return new Response(JSON.stringify(null), { headers });

    const allCoords = decodePolyline(route.overview_polyline.points);
    const snappedPoints: { lat: number; lng: number }[] = [];
    let actual = 0;
    route.legs.forEach((leg: any, i: number) => {
      if (i === 0) snappedPoints.push({ lat: leg.start_location.lat, lng: leg.start_location.lng });
      snappedPoints.push({ lat: leg.end_location.lat, lng: leg.end_location.lng });
      actual += leg.distance.value;
    });

    const payload = { snappedPoints, allCoords, actual };

    await supabaseAdmin.from("route_cache").upsert(
      { cache_key: cacheKey, kind: "directions", payload, hit_count: 1, last_hit_at: new Date().toISOString() },
      { onConflict: "cache_key" },
    );

    return new Response(JSON.stringify(payload), { headers });
  } catch (e) {
    return new Response(JSON.stringify(null), { headers });
  }
});
