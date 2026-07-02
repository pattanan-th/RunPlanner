// RouteWing — Edge Function: POST /functions/v1/elevation
// Proxies Google Elevation API server-side so GOOGLE_SERVER_KEY never reaches the
// client. Body: { coords: {lat,lng}[] } (already pre-sampled to ~100 points by the
// client's fetchElevation()). Returns a plain number[] of elevations in the same
// order as `coords` — the exact shape fetchElevationGoogle() already returns to its
// caller — or `[]` on any failure, so fetchElevation()'s Open-Meteo/Open-Elevation
// fallback chain keeps working unchanged.
//
// Deploy: Supabase Dashboard → Edge Functions → Deploy a new function → name
// "elevation" → paste this file → Deploy. Requires the GOOGLE_SERVER_KEY secret
// (Edge Functions → Secrets) and the route_cache table (see ../../step3_schema.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGINS = [
  "https://routewing.vercel.app",
  "https://pattanan-th.github.io",
  "http://localhost:8080",
];
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

Deno.serve(async (req) => {
  const headers = corsHeaders(req.headers.get("origin"));
  if (req.method === "OPTIONS") return new Response("ok", { headers });

  try {
    const { coords } = await req.json();
    if (!Array.isArray(coords) || coords.length === 0) {
      return new Response(JSON.stringify([]), { headers });
    }

    const cacheKeyStr = "elevation|" + coords.map((p: any) => `${round5(p.lat)},${round5(p.lng)}`).join(";");
    const cacheKey = await sha256(cacheKeyStr);

    const { data: cached } = await supabaseAdmin
      .from("route_cache").select("payload, hit_count").eq("cache_key", cacheKey).maybeSingle();

    if (cached) {
      supabaseAdmin.from("route_cache")
        .update({ hit_count: cached.hit_count + 1, last_hit_at: new Date().toISOString() })
        .eq("cache_key", cacheKey).then(() => {});
      return new Response(JSON.stringify(cached.payload), { headers });
    }

    const locations = coords.map((c: any) => `${c.lat},${c.lng}`).join("|");
    const gRes = await fetch(
      `https://maps.googleapis.com/maps/api/elevation/json?locations=${locations}&key=${GOOGLE_KEY}`,
    );
    const gJson = await gRes.json();
    if (gJson.status !== "OK" || !Array.isArray(gJson.results)) {
      return new Response(JSON.stringify([]), { headers });
    }

    const elevations = gJson.results.map((r: any) => r.elevation);

    await supabaseAdmin.from("route_cache").upsert(
      { cache_key: cacheKey, kind: "elevation", payload: elevations, hit_count: 1, last_hit_at: new Date().toISOString() },
      { onConflict: "cache_key" },
    );

    return new Response(JSON.stringify(elevations), { headers });
  } catch (e) {
    return new Response(JSON.stringify([]), { headers });
  }
});
