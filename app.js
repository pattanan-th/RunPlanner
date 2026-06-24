/* global React, ReactDOM, L */
const { useState, useEffect, useRef, useMemo } = React;

/* ============ i18n ============ */
// Lightweight bilingual helper. CUR_LANG is kept in sync with React state at the top of
// App's render, so utility functions called during render (fmtDistance, ElevationChart, ...)
// pick up the active language without threading a param through every call site.
const LANG_KEY = "runplanner.lang";
let CUR_LANG = (() => { try { return localStorage.getItem(LANG_KEY) === "en" ? "en" : "th"; } catch { return "th"; } })();
const tr = (th, en) => (CUR_LANG === "en" ? en : th);

/* ============ Routing profile ============ */
// Routing profile mapped to a Google travel mode: "foot" → WALKING (footpaths / small alleys /
// sois); "driving" → DRIVING (vehicular roads only). Kept in sync with React state in App's render.
let ROUTE_PROFILE = "foot";

/* ============ Utilities ============ */
const R_EARTH = 6371000;
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLng = toRad(b.lng - a.lng);
    const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
    const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return 2 * R_EARTH * Math.asin(Math.sqrt(h));
}
function totalDistance(coords) {
    let d = 0;
    for (let i = 1; i < coords.length; i++) d += haversine(coords[i - 1], coords[i]);
    return d;
}
function destinationPoint(start, distMeters, bearingRad) {
    const lat1 = toRad(start.lat), lng1 = toRad(start.lng);
    const ang = distMeters / R_EARTH;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(ang) + Math.cos(lat1) * Math.sin(ang) * Math.cos(bearingRad));
    const lng2 = lng1 + Math.atan2(Math.sin(bearingRad) * Math.sin(ang) * Math.cos(lat1), Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2));
    return { lat: toDeg(lat2), lng: toDeg(lng2) };
}
function generateLoopWaypoints(start, targetDistMeters, numPoints, seed) {
    const detourFactor = 1.3;
    const radius = (targetDistMeters / detourFactor) / (2 * Math.PI);
    // Put the start ON the circle: offset the center by `radius` in a random direction so the loop
    // is a clean circle passing through the start — not spokes radiating from a central start point.
    const centerBearing = seed * 2 * Math.PI;
    const center = destinationPoint(start, radius, centerBearing);
    const startAngle = centerBearing + Math.PI;            // start's bearing as seen from the center
    const dir = ((seed * 7919) % 1) < 0.5 ? 1 : -1;        // random travel direction around the circle
    const points = [start];
    for (let i = 1; i <= numPoints; i++) {
        const ang = startAngle + dir * (i / (numPoints + 1)) * 2 * Math.PI;
        const r = radius * (0.92 + ((seed * 7919 * (i + 1)) % 1) * 0.16); // small ±8% wobble, stays circular
        points.push(destinationPoint(center, r, ang));
    }
    points.push(start);
    return points;
}

// One-way ("ไปไม่กลับ"): TWO waypoints only — the start and a single endpoint placed in a
// random compass direction at the target distance. Google then routes start→end along roads,
// so the editable route has exactly two points (start + end) with no intermediate waypoints.
function oneWayEndpoint(start, targetDistMeters, seed) {
    const detourFactor = 1.3;            // road path is typically ~1.3x the straight-line distance
    const bearing = seed * 2 * Math.PI;  // random direction
    return destinationPoint(start, targetDistMeters / detourFactor, bearing);
}
function fmtDistance(m) {
    if (m < 1000) return `${Math.round(m)} ${tr("ม.", "m")}`;
    return `${(m / 1000).toFixed(2)} ${tr("กม.", "km")}`;
}
function fmtTime(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
}
function defaultRouteName() {
    const d = new Date();
    const loc = tr("th-TH", "en-US");
    return `${tr("เส้นทาง", "Route")} ${d.toLocaleDateString(loc)} ${d.toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })}`;
}
function elevationGain(elevations) {
    if (!elevations || elevations.length < 2) return 0;
    let asc = 0;
    for (let i = 1; i < elevations.length; i++) {
        const d = elevations[i] - elevations[i - 1];
        if (d > 0) asc += d;
    }
    return asc;
}
function elevationLoss(elevations) {
    if (!elevations || elevations.length < 2) return 0;
    let desc = 0;
    for (let i = 1; i < elevations.length; i++) {
        const d = elevations[i] - elevations[i - 1];
        if (d < 0) desc -= d;
    }
    return desc;
}
// Average and max |grade| (%) along a route, from sampled elevations + total distance.
// Grades are 3-point smoothed so coarse-sample noise doesn't inflate the max.
function gradeStats(elevations, distanceM) {
    if (!elevations || elevations.length < 2 || !distanceM) return { avg: 0, max: 0 };
    const n = elevations.length;
    const segM = distanceM / (n - 1);
    const raw = [];
    for (let i = 1; i < n; i++) raw.push(((elevations[i] - elevations[i - 1]) / segM) * 100);
    const sm = raw.map((_, i) => {
        const a = raw[i - 1], c = raw[i + 1];
        let s = raw[i], k = 1;
        if (a !== undefined) { s += a; k++; }
        if (c !== undefined) { s += c; k++; }
        return s / k;
    });
    let sum = 0, max = 0;
    for (const g of sm) { const ag = Math.abs(g); sum += ag; if (ag > max) max = ag; }
    return { avg: sum / (sm.length || 1), max };
}
function perpendicularDistance(p, a, b) {
    if (a.lat === b.lat && a.lng === b.lng) return haversine(p, a);
    const dx = b.lng - a.lng, dy = b.lat - a.lat;
    const t = Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / (dx * dx + dy * dy)));
    return haversine(p, { lat: a.lat + t * dy, lng: a.lng + t * dx });
}
function douglasPeucker(points, epsilon) {
    if (points.length < 3) return points.slice();
    let dmax = 0, index = 0;
    const end = points.length - 1;
    for (let i = 1; i < end; i++) {
        const d = perpendicularDistance(points[i], points[0], points[end]);
        if (d > dmax) { index = i; dmax = d; }
    }
    if (dmax > epsilon) {
        const left = douglasPeucker(points.slice(0, index + 1), epsilon);
        const right = douglasPeucker(points.slice(index, end + 1), epsilon);
        return left.slice(0, -1).concat(right);
    }
    return [points[0], points[end]];
}
function optimizeWaypointOrder(points) {
    if (points.length < 3) return points.slice();
    const remaining = points.slice(1);
    const ordered = [points[0]];
    let current = points[0];
    while (remaining.length > 0) {
        let ni = 0, nd = haversine(current, remaining[0]);
        for (let i = 1; i < remaining.length; i++) {
            const d = haversine(current, remaining[i]);
            if (d < nd) { nd = d; ni = i; }
        }
        current = remaining[ni];
        ordered.push(current);
        remaining.splice(ni, 1);
    }
    return ordered;
}
function encodeRoute(coords) {
    return btoa(unescape(encodeURIComponent(coords.map(c => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join(";"))));
}
function decodeRoute(s) {
    try {
        return decodeURIComponent(escape(atob(s))).split(";").map(pair => {
            const [lat, lng] = pair.split(",").map(Number);
            return { lat, lng };
        }).filter(p => !isNaN(p.lat) && !isNaN(p.lng));
    } catch (e) { return []; }
}
function escapeXml(s) {
    return String(s).replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]);
}
function buildGpx(coords, name) {
    const pts = coords.map(c => `      <trkpt lat="${c.lat.toFixed(6)}" lon="${c.lng.toFixed(6)}"></trkpt>`).join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="RunPlanner" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${escapeXml(name)}</name><time>${new Date().toISOString()}</time></metadata>
  <trk><name>${escapeXml(name)}</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>`;
}
// Parse a GPX file's coordinates — track points first, then route points, then waypoints.
function parseGpx(text) {
    try {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        if (doc.querySelector("parsererror")) return [];
        let nodes = [...doc.getElementsByTagName("trkpt")];
        if (nodes.length === 0) nodes = [...doc.getElementsByTagName("rtept")];
        if (nodes.length === 0) nodes = [...doc.getElementsByTagName("wpt")];
        return nodes
            .map(n => ({ lat: parseFloat(n.getAttribute("lat")), lng: parseFloat(n.getAttribute("lon")) }))
            .filter(p => isFinite(p.lat) && isFinite(p.lng));
    } catch (e) { return []; }
}
function downloadGpx(coords, name) {
    const blob = new Blob([buildGpx(coords, name)], { type: "application/gpx+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name.replace(/[\\/:*?"<>|]/g, "_")}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 100);
}
function segmentsIntersect(a, b, c, d) {
    const ccw = (P, Q, R) => (R.lat - P.lat) * (Q.lng - P.lng) > (Q.lat - P.lat) * (R.lng - P.lng);
    return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d);
}
// Proximity-based check: route doubles back if two route points that are
// far apart along the route are physically close to each other.
// This catches both crossings AND running along the same road in either direction.
// `closedLoop` = true when first/last point are the same (skip wrap-around adjacency).
function detectRouteOverlap(coords, closedLoop = true) {
    if (coords.length < 4) return false;
    const step = Math.max(1, Math.floor(coords.length / 300));
    const s = coords.filter((_, i) => i % step === 0);
    if (s[s.length - 1] !== coords[coords.length - 1]) s.push(coords[coords.length - 1]);
    const cum = [0];
    for (let i = 1; i < s.length; i++) cum.push(cum[i - 1] + haversine(s[i - 1], s[i]));
    const total = cum[cum.length - 1];
    const minSepAlong = 250;   // ignore overlaps within 250m route distance (= legit road turns)
    const proximity = 22;      // meters — if two route points are this close, route doubles back
    for (let i = 0; i < s.length; i++) {
        for (let j = i + 1; j < s.length; j++) {
            const along = cum[j] - cum[i];
            if (along < minSepAlong) continue;
            // For closed loops, the start/end meet — skip wrap-around within minSepAlong
            if (closedLoop && total - along < minSepAlong) continue;
            if (haversine(s[i], s[j]) < proximity) return true;
        }
    }
    return false;
}

/* ============ Routing (Google Maps JS SDK — DirectionsService) ============ */
// Lazily created singleton. Returns null until the Google Maps SDK has finished loading.
let _dirService = null;
function dirService() {
    if (!_dirService && window.google && google.maps && google.maps.DirectionsService) {
        _dirService = new google.maps.DirectionsService();
    }
    return _dirService;
}
// ROUTE_PROFILE "foot" → WALKING (uses footpaths / sois); "driving" → DRIVING (vehicular roads).
function googleTravelMode() {
    if (window.google && google.maps) {
        return ROUTE_PROFILE === "driving" ? google.maps.TravelMode.DRIVING : google.maps.TravelMode.WALKING;
    }
    return "WALKING";
}

// Single multi-waypoint route via DirectionsService. Returns { snappedPoints, allCoords, actual }.
async function fetchMultiWaypointRoute(waypoints) {
    const svc = dirService();
    if (!svc || waypoints.length < 2) return null;
    const origin = { lat: waypoints[0].lat, lng: waypoints[0].lng };
    const destination = { lat: waypoints[waypoints.length - 1].lat, lng: waypoints[waypoints.length - 1].lng };
    const mid = waypoints.slice(1, -1).map(p => ({ location: { lat: p.lat, lng: p.lng }, stopover: true }));
    try {
        const res = await svc.route({
            origin, destination, waypoints: mid,
            travelMode: googleTravelMode(),
            optimizeWaypoints: false,
        });
        const route = res.routes && res.routes[0];
        if (!route) return null;
        const allCoords = route.overview_path.map(p => ({ lat: p.lat(), lng: p.lng() }));
        const snappedPoints = [];
        let actual = 0;
        route.legs.forEach((leg, i) => {
            if (i === 0) snappedPoints.push({ lat: leg.start_location.lat(), lng: leg.start_location.lng() });
            snappedPoints.push({ lat: leg.end_location.lat(), lng: leg.end_location.lng() });
            actual += leg.distance.value;
        });
        return { snappedPoints, allCoords, actual };
    } catch (e) { return null; }
}

// Snap routing via BRouter (free, CORS-ok). Default profile is "shortest" — the most direct
// foot route (uses roads AND trails, whichever is shorter), so the line doesn't take long
// detours. "หาเส้นทางอื่น" offers other styles (trekking, hiking) for scenic/trail options.
async function fetchTrailRoute(waypoints, profile = "shortest") {
    if (waypoints.length < 2) return null;
    const lonlats = waypoints.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join("|");
    const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error("brouter");
        const j = await res.json();
        const f = j.features && j.features[0];
        if (!f || !f.geometry) return null;
        const allCoords = f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        const actual = parseFloat(f.properties && f.properties["track-length"]) || totalDistance(allCoords);
        return { snappedPoints: waypoints, allCoords, actual };
    } catch (e) { return null; }
}

// Route a single leg A→B (for the cut-through hybrid). Returns {coords, dist} or null.
async function fetchLegRoute(a, b, profile = "shortest") {
    const lonlats = `${a.lng.toFixed(6)},${a.lat.toFixed(6)}|${b.lng.toFixed(6)},${b.lat.toFixed(6)}`;
    try {
        const res = await fetch(`https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`);
        if (!res.ok) return null;
        const f = (await res.json()).features[0];
        if (!f || !f.geometry) return null;
        const coords = f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
        const dist = parseFloat(f.properties["track-length"]) || totalDistance(coords);
        return { coords, dist };
    } catch (e) { return null; }
}

// Cut-through hybrid: route each leg separately; if a leg fails, or its snapped path detours
// unreasonably far vs. crow-flies, bridge it with a straight line — a sign the point sits on a
// private/unrouted lane (e.g. inside a gated estate) that the router won't enter, or a small
// "closed but passable" gap. The detour tolerance scales with gap size so genuinely winding
// long legs are kept, while short gaps get the tightest threshold.
function detourLimit(straightM) {
    if (straightM < 250) return 2.0;    // short gap: likely closed-but-passable
    if (straightM < 800) return 2.5;
    if (straightM < 2500) return 3.5;
    return 5;                           // long leg: only bridge truly extreme detours
}
async function fetchSnapHybrid(waypoints, profile = "shortest") {
    if (waypoints.length < 2) return null;
    const legs = await Promise.all(
        waypoints.slice(0, -1).map((a, i) => fetchLegRoute(a, waypoints[i + 1], profile))
    );
    let allCoords = [{ lat: waypoints[0].lat, lng: waypoints[0].lng }];
    let actual = 0;
    for (let i = 0; i < legs.length; i++) {
        const a = waypoints[i], b = waypoints[i + 1];
        const straight = haversine(a, b);
        const leg = legs[i];
        const blocked = !leg || leg.dist > straight * detourLimit(straight);
        if (blocked) {
            allCoords.push({ lat: b.lat, lng: b.lng });
            actual += straight;
        } else {
            allCoords = allCoords.concat(leg.coords.slice(1));
            actual += leg.dist;
        }
    }
    return { snappedPoints: waypoints, allCoords, actual };
}

// Alternative routes = different BRouter profiles: shortest (direct) → trekking → hiking (scenic).
// Returns [{coords, dist, ascend}] deduped by distance, shortest first.
async function fetchRouteAlternatives(waypoints) {
    if (waypoints.length < 2) return [];
    const lonlats = waypoints.map(p => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join("|");
    const out = [];
    for (const profile of ["shortest", "trekking", "hiking-beta"]) {
        try {
            const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${profile}&alternativeidx=0&format=geojson`;
            const res = await fetch(url);
            if (!res.ok) continue;
            const j = await res.json();
            const f = j.features && j.features[0];
            if (!f || !f.geometry) continue;
            const coords = f.geometry.coordinates.map(([lng, lat]) => ({ lat, lng }));
            const dist = parseFloat(f.properties && f.properties["track-length"]) || totalDistance(coords);
            const ascend = parseFloat(f.properties && f.properties["filtered ascend"]) || 0;
            out.push({ coords, dist, ascend });
        } catch (e) {}
    }
    out.sort((a, b) => a.dist - b.dist);
    const seen = new Set(), uniq = [];
    for (const r of out) { const k = Math.round(r.dist / 50); if (!seen.has(k)) { seen.add(k); uniq.push(r); } }
    return uniq;
}

// Snap a single point to the nearest road by routing it to itself and reading the snapped leg start.
async function snapToRoad(pt) {
    const svc = dirService();
    if (!svc) return pt;
    try {
        const res = await svc.route({
            origin: { lat: pt.lat, lng: pt.lng },
            destination: { lat: pt.lat, lng: pt.lng },
            travelMode: googleTravelMode(),
        });
        const leg = res.routes && res.routes[0] && res.routes[0].legs[0];
        if (leg) return { lat: leg.start_location.lat(), lng: leg.start_location.lng() };
    } catch (e) {}
    return pt;
}

// Fast loop generator using single multi-waypoint route requests.
// Target: actual ∈ [target, target+500]. No self-overlap. Best fit n picked auto.
async function generateSmoothLoop(start, targetMeters, seed, minPoints, maxPoints) {
    const upperBound = targetMeters + 500;
    let best = null;
    let bestPenalty = Infinity;

    for (let n = minPoints; n <= maxPoints; n++) {
        let scale = 1.0;
        let currentSeed = seed;
        let seedTried = 0;
        for (let iter = 0; iter < 6; iter++) {
            const candidates = generateLoopWaypoints(start, targetMeters * scale, n, currentSeed);
            const result = await fetchMultiWaypointRoute(candidates);
            if (!result) break;
            const { snappedPoints, allCoords, actual } = result;

            const inRange = actual >= targetMeters && actual <= upperBound;
            const overlap = detectRouteOverlap(allCoords, true);

            if (inRange && !overlap) {
                return { points: snappedPoints, allCoords, n: snappedPoints.length - 2, actual, smooth: true };
            }

            let penalty = 0;
            if (actual < targetMeters) penalty += (targetMeters - actual);
            if (actual > upperBound) penalty += (actual - upperBound);
            if (overlap) penalty += 2000;
            if (penalty < bestPenalty) {
                bestPenalty = penalty;
                best = { points: snappedPoints, allCoords, n: snappedPoints.length - 2, actual, smooth: false };
            }

            if (overlap && inRange) {
                if (seedTried >= 2) break;
                currentSeed = (currentSeed + 0.31415) % 1;
                seedTried++;
                continue;
            }
            if (actual < targetMeters) {
                // Prefer GROWING the circle to reach the target. Only treat it as a dead direction
                // (e.g. into water) once we've scaled up a lot but it's still far too short.
                if (scale >= 5.0 && actual < targetMeters * 0.7 && seedTried < 3) {
                    currentSeed = (currentSeed + 0.137) % 1;
                    seedTried++;
                    scale = 1.0;
                    continue;
                }
                scale = Math.min(scale * (targetMeters + 250) / Math.max(actual, 100), 6.0);
            } else if (actual > upperBound) {
                scale *= (targetMeters + 250) / actual;
            } else {
                break;
            }
        }
    }
    return best;
}

// One-way variant: TWO waypoints (start + end). Pick a random direction, place the endpoint,
// let Google route start→end along roads. Scale the endpoint distance until actual ∈ [target,
// target+500]; retry other directions if a bearing is unreachable (too short) or curls back.
// minPoints/maxPoints are unused here (kept for call-signature compatibility with the loop gen).
async function generateSmoothOneWay(start, targetMeters, seed, minPoints, maxPoints) {
    const upperBound = targetMeters + 500;
    let best = null;
    let bestPenalty = Infinity;
    let scale = 1.0;
    let currentSeed = seed;
    let seedTried = 0;
    for (let iter = 0; iter < 10; iter++) {
        const end = oneWayEndpoint(start, targetMeters * scale, currentSeed);
        const result = await fetchMultiWaypointRoute([start, end]);
        if (!result) break;
        const { snappedPoints, allCoords, actual } = result;
        const inRange = actual >= targetMeters && actual <= upperBound;
        // One-way must END FAR FROM START — reject directions that curl back near the origin.
        const endGap = haversine(start, snappedPoints[snappedPoints.length - 1]);
        const tooClose = endGap < targetMeters * 0.45;
        if (inRange && !tooClose) {
            return { points: snappedPoints, allCoords, n: snappedPoints.length, actual, smooth: true };
        }
        let penalty = 0;
        if (actual < targetMeters) penalty += (targetMeters - actual);
        if (actual > upperBound) penalty += (actual - upperBound);
        if (tooClose) penalty += 4000 + (targetMeters * 0.45 - endGap); // strongly disfavor loop-back
        if (penalty < bestPenalty) {
            bestPenalty = penalty;
            best = { points: snappedPoints, allCoords, n: snappedPoints.length, actual, smooth: false };
        }
        // Bad direction (too short even when scaled up, or curled back) → try a different bearing
        if ((actual < targetMeters * 0.6 || tooClose) && seedTried < 5) {
            currentSeed = (currentSeed + 0.137) % 1;
            seedTried++;
            scale = 1.0;
            continue;
        }
        // Otherwise scale the endpoint distance toward the target road distance
        if (actual < targetMeters) {
            scale = Math.min(scale * (targetMeters + 200) / Math.max(actual, 100), 5.0);
        } else if (actual > upperBound) {
            scale *= (targetMeters + 200) / actual;
        } else {
            break;
        }
    }
    return best;
}

// Google Elevation (same key/SDK as routing). Lazy singleton — null until the SDK has loaded.
let _elevService = null;
function elevService() {
    if (!_elevService && window.google && google.maps && google.maps.ElevationService) {
        _elevService = new google.maps.ElevationService();
    }
    return _elevService;
}
// Returns elevations aligned to `sampled`, or [] if Google isn't ready / Elevation API errors.
// A timeout is essential: errors like RefererNotAllowedMapError never invoke the callback, so
// without it the Promise would hang forever and elevation would never fall back to a free provider.
function fetchElevationGoogle(sampled) {
    return new Promise((resolve) => {
        const svc = elevService();
        if (!svc) return resolve([]);
        let done = false;
        const finish = (v) => { if (!done) { done = true; resolve(v); } };
        const timer = setTimeout(() => finish([]), 4000);
        svc.getElevationForLocations(
            { locations: sampled.map(c => ({ lat: c.lat, lng: c.lng })) },
            (results, status) => {
                clearTimeout(timer);
                if (status === "OK" && Array.isArray(results)) finish(results.map(r => r.elevation));
                else finish([]); // e.g. Elevation API not enabled / over quota → caller falls back
            }
        );
    });
}

// Elevation lookup. Up to ~100 points per request, so we sample the route down to ~100 coords.
// Primary: Google Elevation (reliable, no free-tier daily cap — uses the same key as routing).
// Fallbacks: Open-Meteo, then Open-Elevation, in case Google's Elevation API isn't enabled or
// errors — so elevation gain never silently breaks.
async function fetchElevation(coords) {
    if (coords.length === 0) return [];
    const step = Math.max(1, Math.floor(coords.length / 100));
    let sampled = coords.filter((_, i) => i % step === 0);
    if (sampled.length > 100) sampled = sampled.slice(0, 100);

    // Primary: Google Elevation
    try {
        const g = await fetchElevationGoogle(sampled);
        if (g.length) return g;
    } catch (e) { /* fall through */ }

    // Fallback 1: Open-Meteo
    try {
        const lats = sampled.map(c => c.lat.toFixed(5)).join(",");
        const lngs = sampled.map(c => c.lng.toFixed(5)).join(",");
        const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lngs}`);
        if (res.ok) {
            const j = await res.json();
            if (Array.isArray(j.elevation) && j.elevation.length) return j.elevation;
        }
    } catch (e) { /* fall through to backup */ }

    // Fallback 2: Open-Elevation (GET, CORS-enabled — no preflight)
    try {
        const locs = sampled.map(c => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join("|");
        const res = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${locs}`);
        if (res.ok) {
            const j = await res.json();
            if (Array.isArray(j.results)) return j.results.map(r => r.elevation);
        }
    } catch (e) { /* give up — caller treats [] as "no data" */ }

    return [];
}

// Base map tile layers — all free, no API key.
const TILE_LAYERS = {
    standard:  { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", opts: { maxZoom: 19, attribution: "&copy; OSM" } },
    satellite: { url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", opts: { maxZoom: 19, attribution: "&copy; Esri" } },
    terrain:   { url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", opts: { maxZoom: 17, attribution: "&copy; OpenTopoMap" } },
    trail:     { url: "https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", opts: { maxZoom: 20, attribution: "&copy; CyclOSM" } },
};
// Monotone CARTO basemaps for the "standard" layer: Positron (light) / Dark Matter (dark).
const DARK_TILES = { url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png", opts: { maxZoom: 20, attribution: "&copy; CARTO" } };
// Light "standard" = OSM standard. Unlike the minimal CARTO styles (Positron/Voyager) its road
// lines and labels are genuinely dark, so grayscaling it gives a true monotone map whose lines
// stay sharp instead of washing out to near-white.
const LIGHT_TILES = { url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", opts: { maxZoom: 19, attribution: "&copy; OpenStreetMap" } };
// Fine zoom control: map a 0-100% slider onto a usable Leaflet zoom range.
const ZOOM_MIN = 3;   // ~country level
const ZOOM_MAX = 19;  // ~building level
const pctToZoom = (p) => ZOOM_MIN + (Math.max(0, Math.min(100, p)) / 100) * (ZOOM_MAX - ZOOM_MIN);
const zoomToPct = (z) => Math.round(((z - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN)) * 100);
function baseTileCfg(layer, theme) {
    if (layer === "standard") return theme === "dark" ? DARK_TILES : LIGHT_TILES;
    return TILE_LAYERS[layer] || TILE_LAYERS.standard;
}

// Transparent overlay of marked hiking/walking trails (Waymarked Trails) — sits on top of any base.
const TRAIL_OVERLAY = { url: "https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png", opts: { maxZoom: 18, opacity: 0.7, attribution: "&copy; Waymarked Trails" } };

// Continuous color ramp by grade (% slope): steep-down blue → flat green → steep-up red.
// Interpolated (not bucketed) so adjacent segments blend into a smooth gradient along the route.
const GRADE_STOPS = [[-12, "#1d4ed8"], [-6, "#38bdf8"], [0, "#10b981"], [6, "#f59e0b"], [12, "#ef4444"]];
function lerpColor(a, b, t) {
    const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
    const r = Math.round((ah >> 16) + (((bh >> 16) - (ah >> 16)) * t));
    const g = Math.round(((ah >> 8) & 255) + ((((bh >> 8) & 255) - ((ah >> 8) & 255)) * t));
    const bl = Math.round((ah & 255) + (((bh & 255) - (ah & 255)) * t));
    return `#${((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1)}`;
}
function gradeColor(g) {
    const x = Math.max(-12, Math.min(12, g));
    for (let i = 1; i < GRADE_STOPS.length; i++) {
        if (x <= GRADE_STOPS[i][0]) {
            const [g0, c0] = GRADE_STOPS[i - 1], [g1, c1] = GRADE_STOPS[i];
            return lerpColor(c0, c1, (x - g0) / (g1 - g0));
        }
    }
    return GRADE_STOPS[GRADE_STOPS.length - 1][1];
}

// Out-and-back: route out to a point ~half the target away, then mirror the path back.
// Reuses the one-way endpoint search for the outbound leg, then reverses its geometry —
// guarantees the return follows the exact same path, and the distance is exactly 2× the leg.
async function generateSmoothOutBack(start, targetMeters, seed, minPoints, maxPoints) {
    const leg = await generateSmoothOneWay(start, targetMeters / 2, seed, minPoints, maxPoints);
    if (!leg) return null;
    const back = leg.allCoords.slice().reverse();
    const allCoords = leg.allCoords.concat(back.slice(1));
    const endPt = leg.points[leg.points.length - 1];
    return { points: [start, endPt, start], allCoords, n: 1, actual: leg.actual * 2, smooth: leg.smooth };
}

function ElevationChart({ elevations, totalDistanceM }) {
    if (!elevations || elevations.length < 2) return <div className="text-xs text-gray-400 text-center py-6">{tr("ยังไม่มีข้อมูลความสูง", "No elevation data yet")}</div>;
    const min = Math.min(...elevations), max = Math.max(...elevations);
    const range = max - min || 1;
    const w = 300, h = 80;
    const points = elevations.map((e, i) => `${((i / (elevations.length - 1)) * w).toFixed(1)},${(h - ((e - min) / range) * h).toFixed(1)}`).join(" ");

    // Distance markers along X-axis
    const totalKm = (totalDistanceM || 0) / 1000;
    let kmStep = 1;
    if (totalKm > 20) kmStep = 5;
    else if (totalKm > 10) kmStep = 2;
    else if (totalKm > 4) kmStep = 1;
    else if (totalKm > 1.5) kmStep = 0.5;
    else kmStep = 0.25;
    const markers = [];
    if (totalKm > 0) {
        for (let km = 0; km <= totalKm + 0.001; km += kmStep) {
            markers.push(km);
        }
        // ensure last (total) marker is shown
        if (markers[markers.length - 1] < totalKm - 0.01) markers.push(totalKm);
    }

    // Y-axis gridlines (3 horizontal lines at 25/50/75% of range)
    const yLines = [0.25, 0.5, 0.75];

    return (
        <div className="text-xs">
            <div className="relative">
                <svg viewBox={`0 0 ${w} ${h}`} className="elevation-svg block" preserveAspectRatio="none"
                     style={{ width: "100%", height: "70%" }}>
                    {/* Horizontal grid (elevation) */}
                    {yLines.map((t, i) => (
                        <line key={`h${i}`} x1={0} y1={h * t} x2={w} y2={h * t}
                              stroke="#e5e7eb" strokeWidth="0.5" strokeDasharray="2 2" />
                    ))}
                    {/* Vertical grid (distance) */}
                    {markers.map((km, i) => {
                        const x = totalKm > 0 ? (km / totalKm) * w : 0;
                        return (
                            <line key={`v${i}`} x1={x} y1={0} x2={x} y2={h}
                                  stroke="#d1d5db" strokeWidth="0.5" strokeDasharray="2 2" />
                        );
                    })}
                    <polygon points={`0,${h} ${points} ${w},${h}`} fill="#10b98133" />
                    <polyline points={points} fill="none" stroke="#10b981" strokeWidth="2" />
                </svg>
                {/* X-axis km labels (HTML overlay, doesn't get stretched by preserveAspectRatio) */}
                <div className="relative h-3 mt-0.5">
                    {markers.map((km, i) => {
                        const pct = totalKm > 0 ? (km / totalKm) * 100 : 0;
                        return (
                            <span key={i}
                                  className="absolute text-[9px] text-gray-500 dark:text-gray-400 whitespace-nowrap"
                                  style={{ left: `${pct}%`, transform: "translateX(-50%)" }}>
                                {km < 1 ? `${Math.round(km * 1000)}${tr("ม", "m")}` : `${km.toFixed(km % 1 === 0 ? 0 : 1)}${tr("กม", "km")}`}
                            </span>
                        );
                    })}
                </div>
            </div>
            <div className="flex justify-between text-[10px] text-gray-600 dark:text-gray-300 mt-1">
                <span>{tr("ต่ำ", "Low")} {Math.round(min)}{tr("ม", "m")}</span>
                <span className="text-green-700">↑{Math.round(elevationGain(elevations))}{tr("ม", "m")}</span>
                <span className="text-red-700">↓{Math.round(elevationLoss(elevations))}{tr("ม", "m")}</span>
                <span>{tr("สูง", "High")} {Math.round(max)}{tr("ม", "m")}</span>
            </div>
        </div>
    );
}

// Large, interactive elevation profile for the detail modal. Distance + elevation axes with
// labels, the profile line colored by grade (steepness), and a scrubber: move/touch to read
// the distance, elevation and grade at any point along the route.
function DetailedElevationChart({ elevations, totalDistanceM }) {
    const [hover, setHover] = React.useState(null); // sample index under the cursor
    const wrapRef = React.useRef(null);
    if (!elevations || elevations.length < 2) {
        return <div className="text-sm text-gray-400 text-center py-16">{tr("ยังไม่มีข้อมูลความสูง", "No elevation data yet")}</div>;
    }
    const n = elevations.length;
    const min = Math.min(...elevations), max = Math.max(...elevations);
    const range = max - min || 1;
    const totalKm = (totalDistanceM || 0) / 1000;
    const segM = n > 1 ? (totalDistanceM || 0) / (n - 1) : 0;

    const W = 1000, H = 360, padL = 48, padR = 14, padT = 14, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const xAt = (i) => padL + (i / (n - 1)) * plotW;
    const yAt = (e) => padT + (1 - (e - min) / range) * plotH;
    const gradeBetween = (i) => (segM > 0 ? ((elevations[i] - elevations[i - 1]) / segM) * 100 : 0);

    const areaPts = `${padL},${padT + plotH} ` + elevations.map((e, i) => `${xAt(i).toFixed(1)},${yAt(e).toFixed(1)}`).join(" ") + ` ${padL + plotW},${padT + plotH}`;

    // X (distance) ticks
    let kmStep = totalKm > 20 ? 5 : totalKm > 10 ? 2 : totalKm > 4 ? 1 : totalKm > 1.5 ? 0.5 : 0.25;
    const xticks = [];
    for (let km = 0; km <= totalKm + 1e-6; km += kmStep) xticks.push(km);
    // Y (elevation) ticks
    const yticks = [0, 0.25, 0.5, 0.75, 1].map(t => min + range * t);

    const onMove = (ev) => {
        const r = wrapRef.current.getBoundingClientRect();
        const cx = ((ev.clientX - r.left) / r.width) * W;
        const frac = Math.max(0, Math.min(1, (cx - padL) / plotW));
        setHover(Math.round(frac * (n - 1)));
    };

    const hg = hover != null && hover > 0 ? gradeBetween(hover) : (hover === 0 ? gradeBetween(1) : 0);
    const hKm = hover != null ? (hover / (n - 1)) * totalKm : 0;

    return (
        <div className="w-full">
            <div ref={wrapRef} className="relative w-full touch-none"
                 onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
                <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height: "auto" }}>
                    {/* Y gridlines + labels */}
                    {yticks.map((e, i) => (
                        <g key={`y${i}`}>
                            <line x1={padL} y1={yAt(e)} x2={padL + plotW} y2={yAt(e)} stroke="#9ca3af" strokeWidth="0.5" strokeOpacity="0.35" />
                            <text x={padL - 6} y={yAt(e) + 3} textAnchor="end" fontSize="11" fill="#9ca3af">{Math.round(e)}</text>
                        </g>
                    ))}
                    {/* X gridlines + labels */}
                    {xticks.map((km, i) => {
                        const x = totalKm > 0 ? padL + (km / totalKm) * plotW : padL;
                        return (
                            <g key={`x${i}`}>
                                <line x1={x} y1={padT} x2={x} y2={padT + plotH} stroke="#9ca3af" strokeWidth="0.5" strokeOpacity="0.25" />
                                <text x={x} y={H - 10} textAnchor="middle" fontSize="11" fill="#9ca3af">
                                    {km < 1 ? `${Math.round(km * 1000)}${tr("ม", "m")}` : `${km.toFixed(km % 1 === 0 ? 0 : 1)}`}
                                </text>
                            </g>
                        );
                    })}
                    {/* Area fill + grade-colored profile line */}
                    <polygon points={areaPts} fill="#10b98122" />
                    {elevations.slice(1).map((e, idx) => {
                        const i = idx + 1;
                        return <line key={`s${i}`} x1={xAt(i - 1)} y1={yAt(elevations[i - 1])} x2={xAt(i)} y2={yAt(e)}
                                     stroke={gradeColor(gradeBetween(i))} strokeWidth="3" strokeLinecap="round" />;
                    })}
                    {/* Hover scrubber */}
                    {hover != null && (
                        <g>
                            <line x1={xAt(hover)} y1={padT} x2={xAt(hover)} y2={padT + plotH} stroke="#6b7280" strokeWidth="1" strokeDasharray="3 3" />
                            <circle cx={xAt(hover)} cy={yAt(elevations[hover])} r="4.5" fill="#fff" stroke="#111827" strokeWidth="2" />
                        </g>
                    )}
                </svg>
                {/* Readout chip following the scrubber */}
                {hover != null && (
                    <div className="absolute top-1 px-2 py-1 rounded-md bg-gray-900/90 text-white text-[11px] leading-tight pointer-events-none whitespace-nowrap"
                         style={{ left: `${(xAt(hover) / W) * 100}%`, transform: `translateX(${hover > n / 2 ? "-105%" : "5%"})` }}>
                        <div>{hKm < 1 ? `${Math.round(hKm * 1000)} ${tr("ม.", "m")}` : `${hKm.toFixed(2)} ${tr("กม.", "km")}`}</div>
                        <div>{tr("สูง", "Elev")} {Math.round(elevations[hover])} {tr("ม.", "m")}</div>
                        <div style={{ color: gradeColor(hg) }}>{tr("ชัน", "Grade")} {hg >= 0 ? "+" : ""}{hg.toFixed(1)}%</div>
                    </div>
                )}
            </div>
            <div className="flex justify-between flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300 mt-2">
                <span>{tr("ต่ำสุด", "Low")} {Math.round(min)}{tr("ม", "m")}</span>
                <span>{tr("สูงสุด", "High")} {Math.round(max)}{tr("ม", "m")}</span>
                <span className="text-green-700 dark:text-green-400">↑{Math.round(elevationGain(elevations))}{tr("ม", "m")}</span>
                <span className="text-red-700 dark:text-red-400">↓{Math.round(elevationLoss(elevations))}{tr("ม", "m")}</span>
                <span>{tr("ระยะ", "Dist")} {totalKm.toFixed(2)}{tr("กม", "km")}</span>
            </div>
        </div>
    );
}

const COMPARE_COLORS = ["#10b981", "#ef4444", "#3b82f6", "#f59e0b", "#8b5cf6", "#ec4899", "#14b8a6", "#6b7280"];

// Overlay of several routes' climb profiles on one chart. X = % of each route's distance (so
// routes of different lengths line up); Y = elevation above each route's own low point (so the
// shape of the climb compares regardless of absolute altitude).
function CompareChart({ routes }) {
    if (!routes || routes.length === 0) return null;
    const W = 1000, H = 300, padL = 38, padR = 12, padT = 12, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const series = routes.map(r => {
        const mn = Math.min(...r.elevations);
        return { ...r, rel: r.elevations.map(e => e - mn) };
    });
    const gmax = Math.max(1, ...series.map(s => Math.max(...s.rel)));
    const xAt = (i, n) => padL + (n > 1 ? (i / (n - 1)) : 0) * plotW;
    const yAt = (v) => padT + (1 - v / gmax) * plotH;
    const yTicks = [0, 0.5, 1].map(t => gmax * t);
    const xTicks = [0, 25, 50, 75, 100];
    return (
        <div className="w-full">
            <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" style={{ height: "auto" }}>
                {yTicks.map((v, i) => (
                    <g key={`y${i}`}>
                        <line x1={padL} y1={yAt(v)} x2={padL + plotW} y2={yAt(v)} stroke="#9ca3af" strokeWidth="0.5" strokeOpacity="0.35" />
                        <text x={padL - 5} y={yAt(v) + 3} textAnchor="end" fontSize="11" fill="#9ca3af">{Math.round(v)}</text>
                    </g>
                ))}
                {xTicks.map((p, i) => (
                    <text key={`x${i}`} x={padL + (p / 100) * plotW} y={H - 8} textAnchor="middle" fontSize="11" fill="#9ca3af">{p}%</text>
                ))}
                {series.map((s, si) => {
                    const n = s.rel.length;
                    const pts = s.rel.map((v, i) => `${xAt(i, n).toFixed(1)},${yAt(v).toFixed(1)}`).join(" ");
                    return <polyline key={si} points={pts} fill="none" stroke={s.color} strokeWidth={s.current ? 3.5 : 2.5} strokeOpacity="0.95" strokeDasharray={s.current ? "" : ""} />;
                })}
            </svg>
            <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-[11px]">
                {series.map((s, si) => (
                    <span key={si} className="inline-flex items-center gap-1 text-gray-700 dark:text-gray-300">
                        <span className="inline-block w-3 h-0.5 rounded" style={{ background: s.color }} />{s.name}{s.current ? ` (${tr("ปัจจุบัน", "current")})` : ""}
                    </span>
                ))}
            </div>
        </div>
    );
}

const LOOP_PRESETS = [
    { km: 5 }, { km: 10 }, { km: 21 },
];

function App() {
    const [lang, setLang] = useState(CUR_LANG);
    CUR_LANG = lang; // keep module-level lang in sync so utils render in the active language
    const toggleLang = () => setLang(l => {
        const nl = l === "en" ? "th" : "en";
        try { localStorage.setItem(LANG_KEY, nl); } catch {}
        return nl;
    });

    // Theme (light/dark). Initial value is read before paint by an inline script in index.html
    // (which adds `dark` to <html>), so we just mirror that into React state on first render.
    const [theme, setTheme] = useState(() => {
        try { return localStorage.getItem("runplanner.theme") === "dark" ? "dark" : "light"; } catch { return "light"; }
    });
    useEffect(() => {
        const root = document.documentElement;
        if (theme === "dark") root.classList.add("dark"); else root.classList.remove("dark");
        try { localStorage.setItem("runplanner.theme", theme); } catch {}
    }, [theme]);
    const toggleTheme = () => setTheme(t => t === "dark" ? "light" : "dark");

    const [routeProfile, setRouteProfile] = useState(() => {
        try { return localStorage.getItem("runplanner.profile") === "driving" ? "driving" : "foot"; } catch { return "foot"; }
    });
    ROUTE_PROFILE = routeProfile; // keep module-level routing profile in sync for the API helpers
    const changeRouteProfile = (p) => {
        generatedRouteRef.current = null;        // drop cached geometry so routes re-fetch with the new profile
        try { localStorage.setItem("runplanner.profile", p); } catch {}
        setRouteProfile(p);
    };

    const mapInstanceRef = useRef(null);
    const markersRef = useRef([]);
    const routeLineRef = useRef(null);
    const userLocMarkerRef = useRef(null);
    const userLocCircleRef = useRef(null);
    const passiveWatchIdRef = useRef(null);
    const elevationDebounceRef = useRef(null);
    const lastElevatedKeyRef = useRef("");
    const generatedRouteRef = useRef(null); // {key, coords} — cached route from auto-generator
    const tileLayerRef = useRef(null);
    const trailOverlayRef = useRef(null);
    const kmMarkersRef = useRef(null);
    const altLayerRef = useRef(null);
    const fileInputRef = useRef(null);
    const undoStack = useRef([]);   // past waypoint snapshots
    const redoStack = useRef([]);   // undone snapshots, for redo
    const skipHistory = useRef(false); // true when a waypoints change came from undo/redo itself
    const prevWpRef = useRef([]);   // last committed waypoints, pushed to undo on next change

    const [userLocation, setUserLocation] = useState(null);
    const [waypoints, setWaypoints] = useState([]);
    const [routedCoords, setRoutedCoords] = useState([]);
    const [snapToRoads, setSnapToRoads] = useState(true);
    const [loadingRoute, setLoadingRoute] = useState(false);

    const [loopMode, setLoopMode] = useState(false);
    const [loopKm, setLoopKm] = useState(5);
    const [customKm, setCustomKm] = useState("");
    const [loopPoints, setLoopPoints] = useState(3);
    const [loopType, setLoopType] = useState("loop"); // "loop" | "oneway"
    const [generatingLoop, setGeneratingLoop] = useState(false);
    const [loopStart, setLoopStart] = useState(null);

    const [elevations, setElevations] = useState([]);
    const [loadingElev, setLoadingElev] = useState(false);
    const [laps, setLaps] = useState(1);                       // run the drawn loop N times (cumulative distance/elevation)
    const [elevModalOpen, setElevModalOpen] = useState(false); // full-screen detailed elevation graph
    const [compareOpen, setCompareOpen] = useState(false);     // route-comparison modal
    const [savedRoutes, setSavedRoutes] = useState(() => {
        try { return JSON.parse(localStorage.getItem("routewing.compareRoutes") || "[]"); } catch { return []; }
    });
    const persistSaved = (list) => {
        setSavedRoutes(list);
        try { localStorage.setItem("routewing.compareRoutes", JSON.stringify(list)); } catch {}
    };

    const [paceMin, setPaceMin] = useState(6);
    const [paceSec, setPaceSec] = useState(0);
    const [paceOpen, setPaceOpen] = useState(false);

    const [uiVisible, setUiVisible] = useState(true);
    const [panelOpen, setPanelOpen] = useState(false); // mobile drawer (left panel) open/closed; desktop always shows inline
    const [toolsCollapsed, setToolsCollapsed] = useState(false);
    const [altCollapsed, setAltCollapsed] = useState(false);
    const [elevCollapsed, setElevCollapsed] = useState(false);
    const [bottomCollapsed, setBottomCollapsed] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [simplifyEpsilon, setSimplifyEpsilon] = useState(30);
    const [elevPopupOpen, setElevPopupOpen] = useState(false);
    const [elevPopupOpacity, setElevPopupOpacity] = useState(0.95);
    const [elevPopupPos, setElevPopupPos] = useState(null);          // {x,y} top-left in px; null = default bottom-right
    const [elevPopupDims, setElevPopupDims] = useState({ w: 300, h: 170 });
    const [altRoutes, setAltRoutes] = useState([]);   // alternative routes [{coords, dist, ascend}]
    const [altOpen, setAltOpen] = useState(false);
    const [altLoading, setAltLoading] = useState(false);
    const [activeAltIdx, setActiveAltIdx] = useState(0);
    const [mapLayer, setMapLayer] = useState("standard"); // standard | satellite | terrain | trail
    const [showTrails, setShowTrails] = useState(false);  // Waymarked Trails hiking overlay
    const [showKm, setShowKm] = useState(false);          // show km distance markers along the route
    const [colorByGrade, setColorByGrade] = useState(false); // color the route line by slope steepness
    const [cutThrough, setCutThrough] = useState(true);   // default on: bridge short "closed" gaps with straight lines
    const [histVer, setHistVer] = useState(0);            // bumps to refresh undo/redo button state
    const [zoomPct, setZoomPct] = useState(69);           // fine zoom as 0-100% (mapped to ZOOM_MIN..ZOOM_MAX)
    const [toast, setToast] = useState(null);

    const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

    useEffect(() => {
        if (mapInstanceRef.current) return;
        const map = L.map("map", {
            center: [13.7563, 100.5018], zoom: 14, zoomControl: false,
            minZoom: ZOOM_MIN, maxZoom: ZOOM_MAX,
            zoomSnap: 0, zoomDelta: 0.5, // allow smooth fractional zoom for the 1%-step slider
        });
        // (no default L.control.zoom — replaced by the fine 0-100% slider on the map)
        // Keep the fine-zoom slider (%) in sync whenever the map zoom changes (buttons/scroll/pinch).
        map.on("zoom", () => setZoomPct(zoomToPct(map.getZoom())));
        setZoomPct(zoomToPct(map.getZoom()));
        const base = baseTileCfg("standard", theme);
        tileLayerRef.current = L.tileLayer(base.url, base.opts).addTo(map);
        mapInstanceRef.current = map;

        const t1 = setTimeout(() => map.invalidateSize(), 100);
        const t2 = setTimeout(() => map.invalidateSize(), 500);

        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                (pos) => {
                    const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
                    setUserLocation(loc);
                    map.setView([loc.lat, loc.lng], 15);
                },
                () => {}, { timeout: 15000, enableHighAccuracy: false }
            );
            passiveWatchIdRef.current = navigator.geolocation.watchPosition(
                (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy }),
                () => {}, { enableHighAccuracy: false, maximumAge: 30000, timeout: 30000 }
            );
        }

        if (location.hash.startsWith("#r=")) {
            const decoded = decodeRoute(location.hash.slice(3));
            if (decoded.length > 0) {
                setWaypoints(decoded);
                setSnapToRoads(false);
                showToast(`${tr("โหลดเส้นทางที่แชร์", "Loaded shared route")} (${decoded.length} ${tr("จุด", "pts")})`);
            }
        }

        return () => {
            clearTimeout(t1); clearTimeout(t2);
            if (passiveWatchIdRef.current !== null && navigator.geolocation) {
                navigator.geolocation.clearWatch(passiveWatchIdRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map || !tileLayerRef.current) return;
        const cfg = baseTileCfg(mapLayer, theme);
        tileLayerRef.current.remove();
        tileLayerRef.current = L.tileLayer(cfg.url, cfg.opts).addTo(map);
        tileLayerRef.current.bringToBack();
        // Night look, kept bright enough to read: lighten the dark standard tiles; invert the
        // drawn maps (terrain/trail) with a brightness boost; only lightly dim satellite.
        let filter = "none";
        if (theme === "dark") {
            if (mapLayer === "satellite") filter = "brightness(1.1)";
            else if (mapLayer === "terrain" || mapLayer === "trail") filter = "invert(1) hue-rotate(180deg) brightness(1.85) contrast(0.9)";
            else filter = "brightness(2.5)"; // standard = CARTO Dark Matter, +50% brighter so streets are clearly visible
        } else if (mapLayer === "standard") {
            filter = "grayscale(1) contrast(1.1) brightness(0.97)"; // OSM → monotone, slightly punchier so dark roads/labels read clearly
        }
        const cont = tileLayerRef.current.getContainer && tileLayerRef.current.getContainer();
        if (cont) cont.style.filter = filter;
        if (trailOverlayRef.current) trailOverlayRef.current.bringToFront();
    }, [mapLayer, theme]);

    // Waymarked Trails hiking overlay — transparent tiles on top of the base layer.
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        if (trailOverlayRef.current) { trailOverlayRef.current.remove(); trailOverlayRef.current = null; }
        if (!showTrails) return;
        trailOverlayRef.current = L.tileLayer(TRAIL_OVERLAY.url, TRAIL_OVERLAY.opts).addTo(map);
        trailOverlayRef.current.bringToFront();
    }, [showTrails]);

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        const handler = async (e) => {
            const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
            if (loopMode) {
                const km = parseFloat(customKm) || loopKm;
                if (!km || km <= 0) { showToast(tr("เลือกระยะทางก่อน", "Choose a distance first")); return; }
                if (generatingLoop) return;
                setLoopStart(pt);
                setGeneratingLoop(true);
                const typeName = loopType === "oneway" ? tr("ไปไม่กลับ", "one-way")
                    : loopType === "outback" ? tr("ไป-กลับทางเดิม", "out & back")
                    : tr("วงกลม", "loop");
                showToast(`${tr("กำลังสร้างเส้นทาง", "Creating route")} ${typeName} ${km} ${tr("กม.", "km")} ...`);
                const seed = Math.random();
                const result = loopType === "oneway"
                    ? await generateSmoothOneWay(pt, km * 1000, seed, loopPoints, 8)
                    : loopType === "outback"
                    ? await generateSmoothOutBack(pt, km * 1000, seed, loopPoints, 8)
                    : await generateSmoothLoop(pt, km * 1000, seed, loopPoints, 8);
                setGeneratingLoop(false);
                if (!result) { showToast(tr("สร้างเส้นทางไม่สำเร็จ", "Failed to create route")); return; }
                // Cache the road-following geometry so the markers useEffect doesn't re-fetch
                generatedRouteRef.current = {
                    key: result.points.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|"),
                    coords: result.allCoords,
                };
                setWaypoints(result.points);
                showToast(result.smooth
                    ? `✓ ${typeName} ${fmtDistance(result.actual)} (${result.n} ${tr("จุด", "pts")})`
                    : `⚠ ${tr("คุณภาพต่ำ", "low quality")} ${fmtDistance(result.actual)} (${result.n} ${tr("จุด", "pts")})`);
            } else {
                setWaypoints(prev => [...prev, pt]);
            }
        };
        map.on("click", handler);
        return () => { map.off("click", handler); };
    }, [loopMode, loopKm, customKm, loopPoints, generatingLoop, loopType]);

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        const isClosed = waypoints.length > 1
            && waypoints[0].lat === waypoints[waypoints.length - 1].lat
            && waypoints[0].lng === waypoints[waypoints.length - 1].lng;
        const visibleWps = isClosed ? waypoints.slice(0, -1) : waypoints;

        visibleWps.forEach((wp, i) => {
            const isStart = i === 0;
            const isEnd = !isStart && !isClosed && i === visibleWps.length - 1;
            // International route symbols (not numbers) so waypoints don't clash with km markers:
            // ▶ start · 🏁 finish · small dot = draggable via-point.
            let cls, glyph, size;
            if (isStart) { cls = "wp-start"; glyph = "▶"; size = 30; }
            else if (isEnd) { cls = "wp-end"; glyph = "🏁"; size = 30; }
            else { cls = "wp-via"; glyph = ""; size = 16; }
            const html = `<div class="wp-marker ${cls}">${glyph}</div>`;
            const icon = L.divIcon({ html, className: "", iconSize: [size, size], iconAnchor: [size / 2, size / 2] });
            const m = L.marker([wp.lat, wp.lng], { icon, draggable: true }).addTo(map);
            m.on("dragend", (e) => {
                const ll = e.target.getLatLng();
                setWaypoints(prev => {
                    const next = [...prev];
                    next[i] = { lat: ll.lat, lng: ll.lng };
                    if (i === 0 && next.length > 1
                        && prev[0].lat === prev[prev.length - 1].lat
                        && prev[0].lng === prev[prev.length - 1].lng) {
                        next[next.length - 1] = { lat: ll.lat, lng: ll.lng };
                    }
                    return next;
                });
            });
            m.on("click", () => {
                setWaypoints(prev => {
                    const next = prev.filter((_, idx) => idx !== i);
                    if (i === 0 && next.length > 0 && prev.length > 1
                        && prev[0].lat === prev[prev.length - 1].lat
                        && prev[0].lng === prev[prev.length - 1].lng) {
                        next.pop();
                    }
                    return next;
                });
                showToast(tr("ลบจุดแล้ว", "Point deleted"));
            });
            markersRef.current.push(m);
        });

        if (waypoints.length < 2) {
            setRoutedCoords([]);
            return;
        }

        // If these waypoints just came from the auto-generator, reuse its routed geometry —
        // skips an extra routing round-trip and prevents straight-line fallback on transient failures.
        const wpKey = waypoints.map(w => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join("|");
        if (generatedRouteRef.current && generatedRouteRef.current.key === wpKey) {
            setRoutedCoords(generatedRouteRef.current.coords);
            return;
        }

        let cancelled = false;
        (async () => {
            if (!snapToRoads) {
                if (cancelled) return;
                setRoutedCoords(waypoints);
                return;
            }
            setLoadingRoute(true);
            // Manual snap uses BRouter (shortest) — roads + trails in one. "Cut through" bridges
            // short closed gaps. Falls back to Google road routing if BRouter is unavailable.
            const result = (cutThrough ? await fetchSnapHybrid(waypoints) : await fetchTrailRoute(waypoints))
                || await fetchMultiWaypointRoute(waypoints);
            if (cancelled) return;
            setLoadingRoute(false);
            setRoutedCoords(result ? result.allCoords : waypoints);
        })();
        return () => { cancelled = true; };
    }, [waypoints, snapToRoads, routeProfile, cutThrough]);

    // Draw the route line. Plain green, or — when colorByGrade is on and elevation data exists —
    // split into segments colored by slope. Elevations are sampled (~100 pts), so each full-res
    // segment inherits the grade of the sampled band it falls in (keeps the line on the road).
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;

        const step = Math.max(1, Math.floor(routedCoords.length / 100));
        const canGrade = colorByGrade && elevations.length >= 2;

        // Per-band smoothed grade (computed once; independent of zoom).
        let bandGrade = [];
        if (canGrade) {
            const last = routedCoords.length - 1;
            const raw = [];
            for (let b = 0; b < elevations.length - 1; b++) {
                const a = routedCoords[Math.min(b * step, last)];
                const c = routedCoords[Math.min((b + 1) * step, last)];
                const dx = haversine(a, c) || 1;
                raw[b] = ((elevations[b + 1] - elevations[b]) / dx) * 100;
            }
            // 3-point moving average so coarse elevation noise doesn't make the gradient flicker.
            bandGrade = raw.map((_, b) => {
                const a = raw[b - 1], c = raw[b + 1];
                let s = raw[b], n = 1;
                if (a !== undefined) { s += a; n++; }
                if (c !== undefined) { s += c; n++; }
                return s / n;
            });
        }

        // Offset each vertex to the RIGHT of travel direction by a fixed number of screen pixels.
        // An out-and-back on the same path then renders as two parallel lines: the return pass
        // travels the opposite way, so its "right" is the other side. Recomputed on zoom so the
        // on-screen gap stays constant regardless of zoom level.
        const OFFSET_PX = 4;
        const offsetLatLngs = (coords) => {
            const pts = coords.map(c => map.latLngToLayerPoint([c.lat, c.lng]));
            return pts.map((pt, i) => {
                const prev = pts[i - 1] || pt, next = pts[i + 1] || pt;
                const dx = next.x - prev.x, dy = next.y - prev.y;
                const len = Math.hypot(dx, dy) || 1;
                const ll = map.layerPointToLatLng(L.point(pt.x + (dy / len) * OFFSET_PX, pt.y - (dx / len) * OFFSET_PX));
                return [ll.lat, ll.lng];
            });
        };

        const draw = () => {
            if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null; }
            if (routedCoords.length < 2) return;
            const off = offsetLatLngs(routedCoords);
            const grp = L.layerGroup();
            if (canGrade) {
                // Thin dark casing under the colored segments for a crisp edge.
                L.polyline(off, { color: "#003300", weight: 5, opacity: 0.9 }).addTo(grp);
                for (let i = 1; i < routedCoords.length; i++) {
                    const band = Math.min(Math.floor((i - 1) / step), bandGrade.length - 1);
                    L.polyline([off[i - 1], off[i]], { color: gradeColor(bandGrade[band] || 0), weight: 3, opacity: 0.97 }).addTo(grp);
                }
            } else {
                // Thin deep-green line over a dark casing.
                L.polyline(off, { color: "#003b00", weight: 5, opacity: 0.95 }).addTo(grp);
                L.polyline(off, { color: "#008a00", weight: 3, opacity: 1 }).addTo(grp);
            }
            grp.addTo(map);
            routeLineRef.current = grp;
        };

        draw();
        map.on("zoomend", draw);
        return () => {
            map.off("zoomend", draw);
            if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null; }
        };
    }, [routedCoords, colorByGrade, elevations]);

    // Km distance markers along the route — small numbered dots every 1 km.
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        if (kmMarkersRef.current) { kmMarkersRef.current.remove(); kmMarkersRef.current = null; }
        if (!showKm || routedCoords.length < 2) return;
        const grp = L.layerGroup();
        let acc = 0, nextKm = 1000;
        for (let i = 1; i < routedCoords.length; i++) {
            acc += haversine(routedCoords[i - 1], routedCoords[i]);
            while (acc >= nextKm) {
                const km = nextKm / 1000;
                const icon = L.divIcon({
                    html: `<div class="km-marker">${km}</div>`, className: "",
                    iconSize: [22, 22], iconAnchor: [11, 11],
                });
                L.marker([routedCoords[i].lat, routedCoords[i].lng], { icon, interactive: false, zIndexOffset: -50 }).addTo(grp);
                nextKm += 1000;
            }
        }
        grp.addTo(map);
        kmMarkersRef.current = grp;
    }, [routedCoords, showKm]);

    // Draw the non-selected alternative routes as faint gray dashed lines (Google-Maps style).
    // The selected one is drawn by the main route effect (green/graded). Click a gray line to pick it.
    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        if (altLayerRef.current) { altLayerRef.current.remove(); altLayerRef.current = null; }
        if (!altOpen || altRoutes.length < 2) return;
        const grp = L.layerGroup();
        altRoutes.forEach((a, i) => {
            if (i === activeAltIdx) return;
            const pl = L.polyline(a.coords.map(c => [c.lat, c.lng]), { color: "#66FF66", weight: 6, opacity: 0.7 });
            pl.on("click", () => applyAlt(i));
            pl.addTo(grp);
        });
        grp.addTo(map);
        altLayerRef.current = grp;
    }, [altOpen, altRoutes, activeAltIdx]);

    // Stale alternatives clear whenever the waypoints change.
    useEffect(() => { setAltOpen(false); setAltRoutes([]); }, [waypoints]);

    // Undo/redo history — record the previous waypoints snapshot on every change that isn't
    // itself an undo/redo. Capped at 50 entries.
    useEffect(() => {
        if (skipHistory.current) { skipHistory.current = false; prevWpRef.current = waypoints; return; }
        undoStack.current.push(prevWpRef.current);
        if (undoStack.current.length > 50) undoStack.current.shift();
        redoStack.current = [];
        prevWpRef.current = waypoints;
        setHistVer(v => v + 1);
    }, [waypoints]);

    const undo = () => {
        if (!undoStack.current.length) return;
        redoStack.current.push(waypoints);
        const prev = undoStack.current.pop();
        skipHistory.current = true;
        setWaypoints(prev);
        setHistVer(v => v + 1);
        showToast(tr("ย้อนกลับ", "Undo"));
    };
    const redo = () => {
        if (!redoStack.current.length) return;
        undoStack.current.push(waypoints);
        const next = redoStack.current.pop();
        skipHistory.current = true;
        setWaypoints(next);
        setHistVer(v => v + 1);
        showToast(tr("ทำซ้ำ", "Redo"));
    };

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        if (userLocMarkerRef.current) { userLocMarkerRef.current.remove(); userLocMarkerRef.current = null; }
        if (userLocCircleRef.current) { userLocCircleRef.current.remove(); userLocCircleRef.current = null; }
        if (!userLocation) return;
        const icon = L.divIcon({
            html: `<div class="user-loc-ring"><div class="user-loc-dot"></div></div>`,
            className: "", iconSize: [22, 22], iconAnchor: [11, 11],
        });
        userLocMarkerRef.current = L.marker([userLocation.lat, userLocation.lng], { icon, interactive: false, zIndexOffset: -100 }).addTo(map);
        if (userLocation.acc && userLocation.acc < 200) {
            userLocCircleRef.current = L.circle([userLocation.lat, userLocation.lng], {
                radius: userLocation.acc, color: "#4285f4", weight: 1, opacity: 0.4,
                fillColor: "#4285f4", fillOpacity: 0.08, interactive: false,
            }).addTo(map);
        }
    }, [userLocation]);

    useEffect(() => {
        const map = mapInstanceRef.current;
        if (!map) return;
        const t = setTimeout(() => map.invalidateSize(), 250);
        return () => clearTimeout(t);
    }, [uiVisible, bottomCollapsed, editorOpen, paceOpen]);

    const plannedDistance = useMemo(() => totalDistance(routedCoords), [routedCoords]);
    // Laps: repeat the drawn loop N times for cumulative distance/elevation (e.g. a 5k loop ×2 = 10k).
    // The map/route geometry stays a single loop; only totals and the elevation profile are multiplied.
    const lapCount = Math.max(1, laps);
    const lapElevations = useMemo(() => {
        if (lapCount <= 1 || elevations.length < 2) return elevations;
        let out = elevations.slice();
        for (let k = 1; k < lapCount; k++) out = out.concat(elevations.slice(1));
        return out;
    }, [elevations, lapCount]);
    const lapDistance = plannedDistance * lapCount;
    const gain = useMemo(() => elevationGain(lapElevations), [lapElevations]);
    const loss = useMemo(() => elevationLoss(lapElevations), [lapElevations]);
    const paceSecPerKm = (Number(paceMin) || 0) * 60 + (Number(paceSec) || 0);
    const estimatedSeconds = lapDistance > 0 ? (lapDistance / 1000) * paceSecPerKm : 0;

    useEffect(() => {
        if (routedCoords.length < 2) {
            setElevations([]);
            lastElevatedKeyRef.current = "";
            return;
        }
        const key = routedCoords.map(c => `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`).join("|");
        if (key === lastElevatedKeyRef.current) return;
        if (elevationDebounceRef.current) clearTimeout(elevationDebounceRef.current);
        elevationDebounceRef.current = setTimeout(async () => {
            setLoadingElev(true);
            const ele = await fetchElevation(routedCoords);
            setLoadingElev(false);
            if (ele.length > 0) {
                setElevations(ele);
                lastElevatedKeyRef.current = key;
            }
        }, 1200);
        return () => { if (elevationDebounceRef.current) clearTimeout(elevationDebounceRef.current); };
    }, [routedCoords]);

    const isClosedLoopWp = () =>
        waypoints.length > 1
        && waypoints[0].lat === waypoints[waypoints.length - 1].lat
        && waypoints[0].lng === waypoints[waypoints.length - 1].lng;

    const addWaypointAtCenter = () => {
        const map = mapInstanceRef.current;
        if (!map) return;
        const c = map.getCenter();
        const pt = { lat: c.lat, lng: c.lng };
        setWaypoints(prev => {
            if (prev.length > 1
                && prev[0].lat === prev[prev.length - 1].lat
                && prev[0].lng === prev[prev.length - 1].lng) {
                const list = prev.slice(0, -1);
                list.push(pt);
                list.push(list[0]);
                return list;
            }
            return [...prev, pt];
        });
        showToast(tr("เพิ่มจุดที่กลางจอแล้ว", "Added point at screen center"));
    };
    const removeLastWaypoint = () => {
        setWaypoints(prev => {
            if (prev.length === 0) return prev;
            const closed = prev.length > 1
                && prev[0].lat === prev[prev.length - 1].lat
                && prev[0].lng === prev[prev.length - 1].lng;
            if (closed) {
                if (prev.length <= 2) return [];
                const list = prev.slice(0, -2);
                if (list.length > 0) list.push(list[0]);
                return list;
            }
            return prev.slice(0, -1);
        });
        showToast(tr("ลบจุดสุดท้ายแล้ว", "Removed last point"));
    };
    const reverseRoute = () => {
        if (waypoints.length < 2) { showToast(tr("ต้องมีอย่างน้อย 2 จุด", "Need at least 2 points")); return; }
        setWaypoints(prev => prev.slice().reverse());
        showToast(tr("กลับทิศแล้ว", "Direction reversed"));
    };
    const simplifyRoute = () => {
        if (waypoints.length < 4) { showToast(tr("ต้องมีจุดมากกว่า 3 จุด", "Need more than 3 points")); return; }
        const closed = isClosedLoopWp();
        const list = closed ? waypoints.slice(0, -1) : waypoints.slice();
        const before = list.length;
        const simplified = douglasPeucker(list, simplifyEpsilon);
        if (closed) simplified.push(simplified[0]);
        if (simplified.length >= waypoints.length) { showToast(tr("ไม่มีจุดให้ลด", "No points to remove")); return; }
        setWaypoints(simplified);
        showToast(`${tr("ลด", "Reduced")} ${before} → ${closed ? simplified.length - 1 : simplified.length} ${tr("จุด", "pts")}`);
    };
    const optimizeOrder = () => {
        if (waypoints.length < 3) { showToast(tr("ต้องมีจุดอย่างน้อย 3 จุด", "Need at least 3 points")); return; }
        const closed = isClosedLoopWp();
        const list = closed ? waypoints.slice(0, -1) : waypoints.slice();
        const ordered = optimizeWaypointOrder(list);
        if (closed) ordered.push(ordered[0]);
        setWaypoints(ordered);
        showToast(tr("จัดเรียงให้สั้นที่สุดแล้ว", "Reordered to shortest path"));
    };
    const snapWaypointsToRoads = async () => {
        if (waypoints.length === 0) { showToast(tr("ยังไม่มีจุดผ่าน", "No waypoints yet")); return; }
        showToast(tr("กำลังจัดให้อยู่บนถนน...", "Snapping to roads..."));
        const snapped = await Promise.all(waypoints.map(snapToRoad));
        setWaypoints(snapped);
        showToast(tr("จัดทุกจุดให้อยู่บนถนนแล้ว", "Snapped all points to roads"));
    };
    const closeLoop = () => {
        if (waypoints.length < 2) { showToast(tr("ต้องมีอย่างน้อย 2 จุด", "Need at least 2 points")); return; }
        if (isClosedLoopWp()) { showToast(tr("เป็นวงปิดอยู่แล้ว", "Already a closed loop")); return; }
        setWaypoints(prev => [...prev, { ...prev[0] }]);
        showToast(tr("เชื่อมกลับจุดเริ่มต้นแล้ว", "Connected back to start"));
    };
    const clearRoute = () => {
        setWaypoints([]);
        setElevations([]);
        setLoopStart(null);
        setLaps(1);
        location.hash = "";
        showToast(tr("ล้างเส้นทางแล้ว", "Route cleared"));
    };
    // Apply an alternative route as the active one (cache it so the routing effect keeps it).
    const applyAlt = (idx) => {
        setActiveAltIdx(idx);
        setAltRoutes(prev => {
            const alt = prev[idx];
            if (alt) {
                const wpKey = waypoints.map(w => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join("|");
                generatedRouteRef.current = { key: wpKey, coords: alt.coords };
                setRoutedCoords(alt.coords);
            }
            return prev;
        });
    };
    const showAlternatives = async () => {
        if (waypoints.length < 2) { showToast(tr("ต้องมีอย่างน้อย 2 จุด", "Need at least 2 points")); return; }
        setAltLoading(true); setAltOpen(true); setAltCollapsed(false);
        const alts = await fetchRouteAlternatives(waypoints);
        setAltLoading(false);
        if (alts.length < 2) { setAltOpen(false); showToast(tr("ไม่พบเส้นทางอื่น", "No alternatives found")); return; }
        setAltRoutes(alts);
        applyAlt(0);
    };
    const regenerateLoop = async (typeOverride) => {
        if (!loopStart) { showToast(tr("แตะที่แผนที่เพื่อเลือกจุดเริ่มต้น", "Tap the map to choose a start point")); return; }
        if (generatingLoop) return;
        const type = typeOverride || loopType; // explicit type avoids stale state right after switching
        const km = parseFloat(customKm) || loopKm;
        setGeneratingLoop(true);
        const typeName = type === "oneway" ? tr("ไปไม่กลับ", "one-way")
            : type === "outback" ? tr("ไป-กลับทางเดิม", "out & back")
            : tr("วงกลม", "loop");
        showToast(`${tr("กำลังสุ่มใหม่", "Regenerating")} ${typeName} ${km} ${tr("กม.", "km")} ...`);
        const result = type === "oneway"
            ? await generateSmoothOneWay(loopStart, km * 1000, Math.random(), loopPoints, 8)
            : type === "outback"
            ? await generateSmoothOutBack(loopStart, km * 1000, Math.random(), loopPoints, 8)
            : await generateSmoothLoop(loopStart, km * 1000, Math.random(), loopPoints, 8);
        setGeneratingLoop(false);
        if (!result) { showToast(tr("สร้างเส้นทางไม่สำเร็จ", "Failed to create route")); return; }
        generatedRouteRef.current = {
            key: result.points.map(p => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join("|"),
            coords: result.allCoords,
        };
        setWaypoints(result.points);
        setElevations([]);
        showToast(result.smooth
            ? `✓ ${typeName} ${fmtDistance(result.actual)} (${result.n} ${tr("จุด", "pts")})`
            : `⚠ ${tr("คุณภาพต่ำ", "low quality")} ${fmtDistance(result.actual)} (${result.n} ${tr("จุด", "pts")})`);
    };
    // Switch loop/one-way type. If a start point already exists, regenerate immediately with the
    // new type (passed explicitly to avoid stale state) so the user doesn't have to clear first.
    const switchLoopType = (newType) => {
        if (newType === loopType) return;
        setLoopType(newType);
        if (loopMode && loopStart && !generatingLoop) regenerateLoop(newType);
    };
    const shareRoute = async () => {
        if (waypoints.length < 2) { showToast(tr("ต้องมีอย่างน้อย 2 จุด", "Need at least 2 points")); return; }
        const coordsToShare = routedCoords.length > 0 ? routedCoords : waypoints;
        const hash = encodeRoute(coordsToShare);
        const url = `${location.origin}${location.pathname}#r=${hash}`;
        location.hash = `r=${hash}`;
        if (navigator.share) {
            try { await navigator.share({ title: tr("เส้นทางวิ่ง", "Running route"), text: `${tr("เส้นทาง", "Route")} ${fmtDistance(plannedDistance)}`, url }); }
            catch (e) {}
        } else {
            try { await navigator.clipboard.writeText(url); showToast(tr("คัดลอกลิงก์แล้ว", "Link copied")); }
            catch { showToast(tr("ไม่สามารถคัดลอกลิงก์ได้", "Couldn't copy link")); }
        }
    };
    const exportGpx = () => {
        if (routedCoords.length < 2) { showToast(tr("ต้องมีอย่างน้อย 2 จุด", "Need at least 2 points")); return; }
        downloadGpx(routedCoords, defaultRouteName());
        showToast(tr("ดาวน์โหลด .gpx แล้ว", "Downloaded .gpx"));
    };
    // Open the route in Google Maps directions (walking). Google's URL takes only points
    // (origin + destination + ≤9 waypoints) and re-routes between them. To keep the stop list
    // short, we first simplify the drawn line to its significant turns (Douglas–Peucker), so a
    // straight route becomes just origin→destination instead of 9 evenly-spaced stops; only if
    // there are still too many turns do we downsample to fit Google's 9-waypoint cap.
    const openInGoogleMaps = () => {
        const pts = routedCoords.length >= 2 ? routedCoords : waypoints;
        if (pts.length < 2) { showToast(tr("ยังไม่มีเส้นทาง", "No route yet")); return; }
        const fmt = (p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
        const MAX_POINTS = 11; // origin + destination + 9 waypoints
        let key = douglasPeucker(pts, 60); // ~60m tolerance collapses straight runs into endpoints
        if (key.length > MAX_POINTS) {
            const mid = key.slice(1, -1);
            const want = MAX_POINTS - 2;
            const step = (mid.length - 1) / (want - 1);
            const picked = [];
            for (let i = 0; i < want; i++) picked.push(mid[Math.round(i * step)]);
            key = [key[0], ...picked, key[key.length - 1]];
        }
        const via = key.slice(1, -1);
        let url = `https://www.google.com/maps/dir/?api=1&origin=${fmt(key[0])}&destination=${fmt(key[key.length - 1])}&travelmode=walking`;
        if (via.length) url += `&waypoints=${via.map(fmt).join("|")}`;
        window.open(url, "_blank", "noopener");
    };

    // Save the current route's elevation profile for side-by-side comparison (persisted).
    const saveForCompare = () => {
        if (lapElevations.length < 2 || lapDistance < 1) { showToast(tr("ยังไม่มีข้อมูลความสูง", "No elevation data yet")); return; }
        const lapTag = lapCount > 1 ? ` ×${lapCount}` : "";
        const entry = { id: Date.now(), name: `${tr("เส้นทาง", "Route")} ${savedRoutes.length + 1}${lapTag}`, distanceM: lapDistance, elevations: lapElevations.slice() };
        persistSaved([...savedRoutes, entry]);
        showToast(tr("บันทึกเพื่อเทียบแล้ว", "Saved for comparison"));
        setCompareOpen(true);
    };
    const renameSaved = (id, name) => persistSaved(savedRoutes.map(r => (r.id === id ? { ...r, name } : r)));
    const deleteSaved = (id) => persistSaved(savedRoutes.filter(r => r.id !== id));
    // Import a GPX file: parse its track, downsample to keep the editable marker count sane,
    // and load it as a freehand route (line follows the imported track, every point draggable).
    const importGpx = (file) => {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            const coords = parseGpx(reader.result);
            if (coords.length < 2) { showToast(tr("ไฟล์ GPX ไม่มีเส้นทาง", "No track found in GPX")); return; }
            let wp = coords;
            if (wp.length > 80) wp = douglasPeucker(coords, 15);
            if (wp.length > 200) wp = douglasPeucker(coords, 40);
            generatedRouteRef.current = null;
            setSnapToRoads(false);
            setWaypoints(wp);
            const map = mapInstanceRef.current;
            if (map) map.fitBounds(coords.map(c => [c.lat, c.lng]), { padding: [40, 40] });
            showToast(`${tr("นำเข้า GPX แล้ว", "Imported GPX")} (${wp.length} ${tr("จุด", "pts")})`);
        };
        reader.readAsText(file);
    };
    // Fine zoom: apply a 0-100% value to the map (1% steps). The map's "zoom" listener
    // mirrors the value back into zoomPct, so buttons/scroll/pinch stay in sync too.
    const applyZoomPct = (p) => {
        const clamped = Math.max(0, Math.min(100, Math.round(p)));
        setZoomPct(clamped);
        if (mapInstanceRef.current) mapInstanceRef.current.setZoom(pctToZoom(clamped));
    };
    const centerOnMe = () => {
        if (!navigator.geolocation) {
            showToast(tr("เบราว์เซอร์นี้ไม่รองรับ GPS", "Browser doesn't support GPS"));
            return;
        }
        if (!window.isSecureContext) {
            showToast(tr("ต้องใช้ HTTPS — GPS ใช้งานไม่ได้ผ่าน http", "HTTPS required — GPS unavailable over http"));
            return;
        }
        showToast(tr("กำลังหาตำแหน่ง...", "Finding location..."));
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
                setUserLocation(loc);
                mapInstanceRef.current && mapInstanceRef.current.setView([loc.lat, loc.lng], 16);
            },
            (err) => {
                // Surface the specific reason so iOS Safari issues are diagnosable
                const map = {
                    1: tr("ปฏิเสธสิทธิ์ — เช็คตั้งค่า iOS: Settings → Privacy → Location Services → Safari → While Using",
                          "Permission denied — iOS: Settings → Privacy → Location Services → Safari → While Using"),
                    2: tr("หา GPS ไม่ได้ (ลองออกที่โล่ง / เปิด Wi-Fi)", "Position unavailable (try outdoors / enable Wi-Fi)"),
                    3: tr("หมดเวลา — ลองอีกครั้ง", "Timed out — try again"),
                };
                showToast(map[err.code] || (tr("ผิดพลาด: ", "Error: ") + (err.message || err.code)));
            },
            { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
        );
    };

    // Elevation popup: drag (by header) + resize (corner handle), pointer-based so it works on touch too
    const startElevDrag = (e) => {
        if (e.target.closest("button, input")) return; // don't drag when using controls
        e.preventDefault();
        const win = e.currentTarget.parentElement.getBoundingClientRect();
        const offX = e.clientX - win.left, offY = e.clientY - win.top;
        const maxX = window.innerWidth - win.width, maxY = window.innerHeight - win.height;
        const move = (ev) => setElevPopupPos({
            x: Math.max(0, Math.min(maxX, ev.clientX - offX)),
            y: Math.max(0, Math.min(maxY, ev.clientY - offY)),
        });
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    const startElevResize = (e) => {
        e.preventDefault(); e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const { w, h } = elevPopupDims;
        const move = (ev) => setElevPopupDims({
            w: Math.max(200, Math.min(640, w + (ev.clientX - startX))),
            h: Math.max(130, Math.min(480, h + (ev.clientY - startY))),
        });
        const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };

    return (
        <div className="flex flex-col app-bg" style={{ position: "fixed", inset: 0, paddingTop: "env(safe-area-inset-top)" }}>
            {/* Header — brand + prominent stats (distance, total time) + pace input */}
            {uiVisible && (
                <header className="bg-white dark:bg-gray-900 shadow-sm px-4 py-2">
                    <div className="flex items-center gap-2 mb-1.5">
                        <div className="text-2xl">🏃</div>
                        <div className="flex-1">
                            <div className="font-bold text-gray-800 dark:text-gray-100 leading-tight text-sm">RouteWing</div>
                            <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-tight">{tr("วางแผนเส้นทางวิ่ง", "Plan your running route")}</div>
                        </div>
                    </div>
                    <div className="flex items-end justify-between gap-3 flex-wrap">
                        <div className="flex items-end gap-4">
                            <div>
                                <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">
                                    {tr("ระยะทาง", "Distance")}{lapCount > 1 ? <span className="text-green-600 font-semibold"> ×{lapCount} {tr("รอบ", "laps")}</span> : null}
                                </div>
                                <div className="text-2xl font-bold text-green-600 leading-tight">{loadingRoute ? "..." : fmtDistance(lapDistance)}</div>
                            </div>
                            <div>
                                <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">{tr("เวลารวม", "Total time")}</div>
                                <div className="text-2xl font-bold text-purple-600 leading-tight">{estimatedSeconds > 0 ? fmtTime(estimatedSeconds) : "–"}</div>
                            </div>
                            <div>
                                <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">{tr("ความชัน", "Elev.")}</div>
                                {(gain > 0 || loss > 0) ? (
                                    <div className="text-sm font-semibold leading-tight"><span className="text-orange-600">↑{Math.round(gain)}</span> <span className="text-blue-600">↓{Math.round(loss)}</span></div>
                                ) : (
                                    <div className="text-sm font-semibold leading-tight text-gray-400">↑– ↓–</div>
                                )}
                            </div>
                            {/* Laps: repeat the loop N times for cumulative totals */}
                            <div>
                                <div className="text-[10px] text-gray-500 dark:text-gray-400 leading-none">{tr("รอบ", "Laps")}</div>
                                <div className="flex items-center gap-1 mt-0.5">
                                    <button onClick={() => setLaps(l => Math.max(1, l - 1))} disabled={lapCount <= 1}
                                        className="w-6 h-6 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-base leading-none flex items-center justify-center disabled:opacity-40 active:bg-gray-200">−</button>
                                    <span className="w-5 text-center text-sm font-bold tabular-nums text-gray-800 dark:text-gray-100">{lapCount}</span>
                                    <button onClick={() => setLaps(l => Math.min(20, l + 1))} disabled={plannedDistance < 1}
                                        className="w-6 h-6 rounded bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 text-base leading-none flex items-center justify-center disabled:opacity-40 active:bg-gray-200">+</button>
                                </div>
                            </div>
                        </div>
                        <div className="flex items-center gap-1">
                            <span className="text-[10px] text-gray-500 dark:text-gray-400 mr-1">Pace</span>
                            <input type="number" min="0" max="99" value={paceMin}
                                onChange={(e) => setPaceMin(e.target.value === "" ? "" : Math.max(0, Math.min(99, parseInt(e.target.value) || 0)))}
                                className="w-11 px-1 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                            <span className="font-bold text-gray-700 dark:text-gray-200">:</span>
                            <input type="number" min="0" max="59" value={paceSec}
                                onChange={(e) => setPaceSec(e.target.value === "" ? "" : Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                                className="w-11 px-1 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded text-center bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                            <span className="text-[10px] text-gray-500 dark:text-gray-400 ml-0.5">/{tr("กม.", "km")}</span>
                        </div>
                    </div>
                </header>
            )}

            {/* Quick-access bar — most-used controls, always visible (scrolls horizontally on mobile) */}
            {uiVisible && (
                <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-2 py-1.5 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap shadow-sm">
                    <button onClick={undo} disabled={undoStack.current.length === 0}
                        className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 active:bg-gray-200 disabled:opacity-40">{tr("ย้อน", "Undo")}</button>
                    <button onClick={redo} disabled={redoStack.current.length === 0}
                        className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 active:bg-gray-200 disabled:opacity-40">{tr("ทำซ้ำ", "Redo")}</button>
                    <span className="flex-shrink-0 w-px h-5 bg-gray-200" />
                    <button onClick={() => setLoopMode(m => !m)}
                        className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${loopMode ? "bg-green-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200"}`}>
                        🔄 {tr("อัตโนมัติ", "Auto")}
                    </button>
                    {loopMode ? (
                        <>
                            <div className="flex-shrink-0 flex rounded-full overflow-hidden border border-gray-300 dark:border-gray-600">
                                <button onClick={() => switchLoopType("loop")}
                                    className={`px-2.5 py-1 text-xs font-medium ${loopType === "loop" ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200"}`}>🔁 {tr("วงกลม", "Loop")}</button>
                                <button onClick={() => switchLoopType("outback")}
                                    className={`px-2.5 py-1 text-xs font-medium ${loopType === "outback" ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200"}`}>↩️ {tr("ไป-กลับ", "Out-back")}</button>
                                <button onClick={() => switchLoopType("oneway")}
                                    className={`px-2.5 py-1 text-xs font-medium ${loopType === "oneway" ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200"}`}>➡️ {tr("ไปไม่กลับ", "One-way")}</button>
                            </div>
                            <span className="flex-shrink-0 w-px h-5 bg-gray-200" />
                            {LOOP_PRESETS.map(p => (
                                <button key={p.km} onClick={() => { setLoopKm(p.km); setCustomKm(""); }}
                                    className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${!customKm && loopKm === p.km ? "bg-green-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200"}`}>
                                    {p.km} {tr("กม.", "km")}
                                </button>
                            ))}
                            <button onClick={() => regenerateLoop()} disabled={!loopStart || generatingLoop}
                                className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 active:bg-green-200 disabled:opacity-50">
                                {generatingLoop ? "..." : "🎲"}
                            </button>
                        </>
                    ) : (
                        <>
                            <div className="flex-shrink-0 flex rounded-full overflow-hidden border border-gray-300 dark:border-gray-600">
                                <button onClick={() => setSnapToRoads(true)}
                                    className={`px-2.5 py-1 text-xs font-medium ${snapToRoads ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200"}`}>🛣️ {tr("เกาะเส้นทาง", "Snap")}</button>
                                <button onClick={() => setSnapToRoads(false)}
                                    className={`px-2.5 py-1 text-xs font-medium ${!snapToRoads ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-200"}`}>✏️ {tr("ลากเส้นตรง", "Freehand")}</button>
                            </div>
                            <span className="flex-shrink-0 text-[11px] text-gray-400 px-1">{tr("👆 แตะแผนที่ (เกาะถนน+เทรล)", "👆 Tap map (roads + trails)")}</span>
                        </>
                    )}
                    {waypoints.length > 0 && (
                        <button onClick={clearRoute}
                            className="flex-shrink-0 ml-auto px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700 active:bg-red-100">
                            🗑️ {tr("ล้าง", "Clear")}
                        </button>
                    )}
                </div>
            )}

            {/* Map area with left panel + side rail */}
            <div className="flex-1 flex gap-2 p-2 min-h-0 relative">
                {/* Floating menu button (mobile, always visible — also restores hidden UI) */}
                <button onClick={() => { setUiVisible(true); setPanelOpen(true); }}
                    className="md:hidden absolute top-3 left-3 z-[900] w-10 h-10 rounded-full bg-white dark:bg-gray-900 shadow-lg flex items-center justify-center text-xl active:bg-gray-100"
                    title={tr("เมนู", "Menu")}>☰</button>
                {/* Mobile: backdrop behind the drawer */}
                {panelOpen && (
                    <div onClick={() => setPanelOpen(false)}
                        className="fixed inset-0 bg-black bg-opacity-40 z-[1100] md:hidden" />
                )}
                {/* LEFT panel: drawer on mobile (slides from left), inline column on desktop */}
                {uiVisible && (
                    <div className={`flex flex-col gap-2 overflow-y-auto [&>*]:shrink-0 bg-white dark:bg-gray-900 shadow-2xl p-3 transition-transform fixed inset-y-0 left-0 z-[1200] w-72 max-w-[85%] rounded-r-xl ${panelOpen ? "translate-x-0" : "-translate-x-full"} md:static md:translate-x-0 md:w-64 md:max-w-none md:flex-shrink-0 md:rounded-xl md:z-auto md:shadow`} style={{ WebkitOverflowScrolling: "touch", paddingBottom: "calc(0.75rem + env(safe-area-inset-bottom))", paddingTop: "calc(0.75rem + env(safe-area-inset-top))" }}>
                        {/* Mobile: close + hide-UI */}
                        <div className="md:hidden flex items-center justify-between">
                            <button onClick={() => { setUiVisible(false); setPanelOpen(false); }}
                                className="px-2.5 py-1 rounded-lg bg-gray-100 dark:bg-gray-700 text-xs font-medium text-gray-700 dark:text-gray-200 active:bg-gray-200">{tr("ซ่อน UI", "Hide UI")}</button>
                            <button onClick={() => setPanelOpen(false)}
                                className="w-8 h-8 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-gray-600 dark:text-gray-300 active:bg-gray-200">✕</button>
                        </div>

                        {/* Settings & files row (moved off the floating rail to declutter mobile) */}
                        <div className="flex items-center justify-between gap-1">
                            <button onClick={toggleLang} title={tr("สลับภาษา", "Toggle language")}
                                className="h-9 px-2 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center">
                                <span style={{ fontSize: "11px", fontWeight: 700, letterSpacing: "0.3px" }}>
                                    <span style={{ color: lang === "th" ? (theme === "dark" ? "#e5e7eb" : "#1f2937") : "#b4b2a9" }}>TH</span>
                                    <span style={{ color: "#b4b2a9" }}>/</span>
                                    <span style={{ color: lang === "en" ? (theme === "dark" ? "#e5e7eb" : "#1f2937") : "#b4b2a9" }}>EN</span>
                                </span>
                            </button>
                            <button onClick={toggleTheme} title={theme === "dark" ? tr("โหมดสว่าง", "Light mode") : tr("โหมดมืด", "Dark mode")}
                                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-lg">{theme === "dark" ? "☀️" : "🌙"}</button>
                            <button onClick={shareRoute} disabled={waypoints.length < 2} title={tr("แชร์ลิงก์", "Share link")}
                                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-lg disabled:opacity-40">🔗</button>
                            <button onClick={exportGpx} disabled={routedCoords.length < 2} title={tr("ดาวน์โหลด GPX", "Download GPX")}
                                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 flex flex-col items-center justify-center leading-none disabled:opacity-40">
                                <span style={{ fontSize: "7px", fontWeight: 700, color: "#1f6feb" }}>GPX</span>
                                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 21 L4 12 L9 12 L9 4 L15 4 L15 12 L20 12 Z" fill="#1f6feb" /></svg>
                            </button>
                            <button onClick={() => fileInputRef.current && fileInputRef.current.click()} title={tr("นำเข้า GPX", "Import GPX")}
                                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 flex flex-col items-center justify-center leading-none">
                                <svg viewBox="0 0 24 24" width="14" height="14"><path d="M12 3 L20 12 L15 12 L15 20 L9 20 L9 12 L4 12 Z" fill="#00a000" /></svg>
                                <span style={{ fontSize: "7px", fontWeight: 700, color: "#00a000" }}>GPX</span>
                            </button>
                            <input ref={fileInputRef} type="file" accept=".gpx,application/gpx+xml,application/xml,text/xml"
                                className="hidden"
                                onChange={(e) => { importGpx(e.target.files[0]); e.target.value = ""; }} />
                            <button onClick={openInGoogleMaps} disabled={routedCoords.length < 2 && waypoints.length < 2} title={tr("เปิดใน Google Maps", "Open in Google Maps")}
                                className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-700 flex items-center justify-center disabled:opacity-40">
                                <svg viewBox="0 0 24 24" width="18" height="18" aria-label="Google Maps">
                                    <defs><clipPath id="gmapsPin"><path d="M12 2c-4.42 0-8 3.58-8 8 0 5.25 8 12 8 12s8-6.75 8-12c0-4.42-3.58-8-8-8z"/></clipPath></defs>
                                    <g clipPath="url(#gmapsPin)">
                                        <rect x="0" y="0" width="24" height="24" fill="#4285F4"/>
                                        <path d="M0 0 H24 V7 H0 Z" fill="#EA4335"/>
                                        <path d="M24 6 L24 24 L9 24 Z" fill="#FBBC04"/>
                                        <path d="M0 9 L13 24 L0 24 Z" fill="#34A853"/>
                                    </g>
                                    <circle cx="12" cy="9.5" r="3" fill="#fff"/>
                                </svg>
                            </button>
                        </div>

                        {/* Loop generator */}
                        <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded-lg">
                            <label className="flex items-center gap-2 text-sm font-medium text-gray-800 dark:text-gray-100 cursor-pointer">
                                <input type="checkbox" checked={loopMode}
                                    onChange={(e) => setLoopMode(e.target.checked)}
                                    className="w-4 h-4 accent-green-600" />
                                🔄 {tr("สร้างเส้นทางอัตโนมัติ", "Auto-generate route")}
                            </label>
                            {loopMode && (
                                <div className="mt-2">
                                    <div className="flex gap-1 mb-2">
                                        <button onClick={() => changeRouteProfile("foot")}
                                            className={`flex-1 py-1 rounded text-xs font-medium ${routeProfile === "foot" ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"}`}>
                                            🏘️ {tr("รวมซอย", "Incl. alleys")}
                                        </button>
                                        <button onClick={() => changeRouteProfile("driving")}
                                            className={`flex-1 py-1 rounded text-xs font-medium ${routeProfile === "driving" ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"}`}>
                                            🛣️ {tr("ถนนหลัก", "Main roads")}
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-1 mb-2">
                                        <input type="number" inputMode="decimal" step="0.5" min="0.5"
                                            placeholder={tr("กำหนดเอง (กม.)", "Custom (km)")} value={customKm}
                                            onChange={(e) => setCustomKm(e.target.value)}
                                            className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:border-green-500 bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                                        <button onClick={regenerateLoop} disabled={!loopStart || generatingLoop}
                                            className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium active:bg-green-200 disabled:opacity-50">
                                            {generatingLoop ? "..." : "🎲"}
                                        </button>
                                    </div>
                                    {loopType !== "oneway" && (
                                        <div className="flex items-center gap-1.5 text-xs text-gray-700 dark:text-gray-200">
                                            <span>{tr("เริ่ม:", "Start:")}</span>
                                            <button onClick={() => setLoopPoints(n => Math.max(3, n - 1))}
                                                className="w-5 h-5 rounded bg-gray-200 font-bold active:bg-gray-300">−</button>
                                            <span className="font-bold w-4 text-center">{loopPoints}</span>
                                            <button onClick={() => setLoopPoints(n => Math.min(8, n + 1))}
                                                className="w-5 h-5 rounded bg-gray-200 font-bold active:bg-gray-300">+</button>
                                            <span className="text-gray-500 dark:text-gray-400 text-[10px]">{tr("จุด · auto-grow", "pts · auto-grow")}</span>
                                        </div>
                                    )}
                                    {!loopStart && (
                                        <div className="text-[10px] text-gray-500 dark:text-gray-400 mt-2">👆 {tr("แตะที่แผนที่", "Tap the map")}</div>
                                    )}
                                </div>
                            )}
                            {!loopMode && (
                                <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200 mt-2">
                                    <input type="checkbox" checked={!snapToRoads}
                                        onChange={(e) => setSnapToRoads(!e.target.checked)}
                                        className="w-4 h-4 accent-green-600" />
                                    {tr("ลากเส้นเอง (ไม่เกาะถนน)", "Freehand (no road snap)")}
                                </label>
                            )}
                        </div>

                        {/* Display options */}
                        <div className="p-2 bg-gray-50 dark:bg-gray-800 rounded-lg space-y-2">
                            <div className="text-xs font-medium text-gray-800 dark:text-gray-100">🗺️ {tr("การแสดงผล", "Display")}</div>
                            <div className="flex flex-wrap gap-1">
                                {[["standard", tr("ปกติ", "Map")], ["satellite", tr("ดาวเทียม", "Satellite")], ["trail", tr("เทรล", "Trail")]].map(([k, label]) => (
                                    <button key={k} onClick={() => setMapLayer(k)}
                                        className={`flex-1 min-w-[44px] py-1 rounded text-[10px] font-medium ${mapLayer === k ? "bg-green-600 text-white" : "bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200"}`}>
                                        {label}
                                    </button>
                                ))}
                            </div>
                            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                                <input type="checkbox" checked={showKm} onChange={(e) => setShowKm(e.target.checked)}
                                    className="w-4 h-4 accent-green-600" />
                                📍 {tr("หมุดบอกระยะ กม.", "Km markers")}
                            </label>
                            <label className="flex items-center gap-2 text-xs text-gray-700 dark:text-gray-200">
                                <input type="checkbox" checked={colorByGrade} onChange={(e) => setColorByGrade(e.target.checked)}
                                    className="w-4 h-4 accent-green-600" />
                                🌈 {tr("เส้นไล่สีตามความชัน", "Color by grade")}
                            </label>
                            {colorByGrade && (
                                <div className="px-0.5">
                                    <div style={{ height: 8, borderRadius: 4, background: "linear-gradient(90deg,#1d4ed8,#38bdf8,#10b981,#f59e0b,#ef4444)" }} />
                                    <div className="flex items-center justify-between text-[9px] text-gray-500 dark:text-gray-400 mt-0.5">
                                        <span>{tr("ลงชัน", "steep ↓")}</span>
                                        <span>{tr("ราบ", "flat")}</span>
                                        <span>{tr("ขึ้นชัน", "steep ↑")}</span>
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Route tools */}
                        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                            <button onClick={() => setToolsCollapsed(c => !c)}
                                className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 text-sm font-medium text-gray-800 dark:text-gray-100">
                                <span>🛠️ {tr("เครื่องมือเส้นทาง", "Route tools")}</span>
                                <span className="text-gray-400 text-xs">{toolsCollapsed ? "▸" : "▾"}</span>
                            </button>
                            {!toolsCollapsed && (
                            <div className="p-2 space-y-2 bg-white dark:bg-gray-900">
                                <div className="grid grid-cols-2 gap-1">
                                    <button onClick={reverseRoute} disabled={waypoints.length < 2}
                                        className="py-1 px-1 bg-indigo-50 text-indigo-700 rounded text-[10px] font-medium active:bg-indigo-100 disabled:opacity-50">🔁 {tr("กลับทิศ", "Reverse")}</button>
                                    <button onClick={optimizeOrder} disabled={waypoints.length < 3}
                                        className="py-1 px-1 bg-teal-50 text-teal-700 rounded text-[10px] font-medium active:bg-teal-100 disabled:opacity-50">🎯 {tr("สั้นสุด", "Shortest")}</button>
                                    <button onClick={snapWaypointsToRoads} disabled={waypoints.length === 0}
                                        className="py-1 px-1 bg-amber-50 text-amber-700 rounded text-[10px] font-medium active:bg-amber-100 disabled:opacity-50">🛣️ {tr("ยึดถนน", "Snap")}</button>
                                    <button onClick={simplifyRoute} disabled={waypoints.length < 4}
                                        className="py-1 px-1 bg-pink-50 text-pink-700 rounded text-[10px] font-medium active:bg-pink-100 disabled:opacity-50">〰️ {tr("ลดจุด", "Simplify")}</button>
                                    <button onClick={closeLoop} disabled={waypoints.length < 2 || isClosedLoopWp()}
                                        className="col-span-2 py-1 px-1 bg-green-50 text-green-700 rounded text-[10px] font-medium active:bg-green-100 disabled:opacity-50">🔗 {tr("เชื่อมกลับจุดเริ่มต้น", "Close loop")}</button>
                                </div>
                                <div className="flex items-center gap-1 px-1">
                                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{tr("ลด", "min")} &gt;</span>
                                    <input type="number" min="5" max="500" step="5" value={simplifyEpsilon}
                                        onChange={(e) => setSimplifyEpsilon(parseInt(e.target.value) || 30)}
                                        className="w-14 px-1 py-0.5 text-[10px] border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white" />
                                    <span className="text-[10px] text-gray-500 dark:text-gray-400">{tr("ม.", "m")}</span>
                                </div>
                                <label className="flex items-center gap-2 text-[11px] text-gray-700 dark:text-gray-200 px-1 pt-1 border-t border-gray-100 dark:border-gray-700">
                                    <input type="checkbox" checked={cutThrough} onChange={(e) => setCutThrough(e.target.checked)}
                                        className="w-4 h-4 accent-green-600" />
                                    ✂️ {tr("ทะลุทางปิดสั้น ๆ", "Cut through short gaps")}
                                </label>
                            </div>
                            )}
                        </div>

                        {/* (Waypoint editor removed — rarely used; waypoints are edited directly on the map) */}

                        {/* Alternative routes (embedded, always available with ≥2 points) */}
                        {waypoints.length >= 2 && (
                            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                                <button onClick={() => setAltCollapsed(c => !c)}
                                    className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 text-sm font-medium text-gray-800 dark:text-gray-100">
                                    <span>🔀 {tr("เส้นทางแนะนำ", "Routes")} {altRoutes.length > 0 ? `(${altRoutes.length})` : ""}</span>
                                    <span className="text-gray-400 text-xs">{altCollapsed ? "▸" : "▾"}</span>
                                </button>
                                {!altCollapsed && (
                                <div className="p-2 space-y-1 bg-white dark:bg-gray-900">
                                    {altLoading ? (
                                        <div className="text-xs text-gray-400 text-center py-3">{tr("กำลังหาเส้นทาง...", "Finding routes...")}</div>
                                    ) : altRoutes.length === 0 ? (
                                        <button onClick={showAlternatives}
                                            className="w-full py-1.5 bg-green-50 text-green-700 rounded text-xs font-medium active:bg-green-100">
                                            🔀 {tr("หาเส้นทางอื่น", "Find alternatives")}
                                        </button>
                                    ) : (
                                        <>
                                            {altRoutes.map((a, i) => (
                                                <button key={i} onClick={() => applyAlt(i)}
                                                    className={`w-full text-left px-2 py-1.5 rounded text-xs border ${i === activeAltIdx ? "bg-green-100 dark:bg-green-900 border-green-500 text-green-800 dark:text-green-200" : "bg-gray-50 dark:bg-gray-800 border-transparent text-gray-700 dark:text-gray-200"}`}>
                                                    <div className="font-medium">{tr("เส้นทาง", "Route")} {i + 1}{i === 0 ? ` · ${tr("เร็วสุด", "best")}` : ""}</div>
                                                    <div className={i === activeAltIdx ? "opacity-90" : "text-gray-500 dark:text-gray-400"}>
                                                        {fmtDistance(a.dist)} · ↑{Math.round(a.ascend)}{tr("ม.", "m")}
                                                        {paceSecPerKm > 0 ? ` · ⏱ ${fmtTime((a.dist / 1000) * paceSecPerKm)}` : ""}
                                                    </div>
                                                </button>
                                            ))}
                                            <button onClick={showAlternatives}
                                                className="w-full py-1 text-[10px] text-gray-500 dark:text-gray-400 active:text-gray-700">🔄 {tr("หาใหม่", "Refresh")}</button>
                                        </>
                                    )}
                                </div>
                                )}
                            </div>
                        )}

                        {/* Elevation profile (always shown; standby placeholder before a route exists) */}
                        <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                            <button onClick={() => setElevCollapsed(c => !c)}
                                className="w-full flex items-center justify-between px-3 py-2 bg-gray-50 dark:bg-gray-800 text-sm font-medium text-gray-800 dark:text-gray-100">
                                <span>⛰️ {tr("ความชัน", "Elevation")} <span className="text-xs text-gray-500 dark:text-gray-400">{(gain > 0 || loss > 0) ? `↑${Math.round(gain)} ↓${Math.round(loss)}${tr("ม.", "m")}` : "↑– ↓–"}</span></span>
                                <span className="text-gray-400 text-xs">{elevCollapsed ? "▸" : "▾"}</span>
                            </button>
                            {!elevCollapsed && (
                                <div className="p-2 bg-white dark:bg-gray-900">
                                    <div style={{ height: 110 }}>
                                        {lapElevations.length >= 2 ? (
                                            <ElevationChart elevations={lapElevations} totalDistanceM={lapDistance} />
                                        ) : (
                                            <div className="h-full flex items-center justify-center text-xs text-gray-400 text-center px-2">
                                                {loadingElev ? tr("กำลังโหลดความสูง...", "Loading elevation...") : tr("ลากเส้นทางเพื่อดูกราฟความชัน", "Draw a route to see the elevation graph")}
                                            </div>
                                        )}
                                    </div>
                                    <button onClick={() => setElevModalOpen(true)} disabled={lapElevations.length < 2}
                                        className="mt-1.5 w-full py-1.5 rounded-md bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 text-xs font-medium active:bg-green-100 disabled:opacity-40">
                                        🔍 {tr("ดูกราฟละเอียด", "Detailed graph")}
                                    </button>
                                    <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                                        <button onClick={saveForCompare} disabled={lapElevations.length < 2}
                                            className="py-1.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-xs font-medium active:bg-gray-200 disabled:opacity-40">
                                            ➕ {tr("บันทึกเทียบ", "Save")}
                                        </button>
                                        <button onClick={() => setCompareOpen(true)}
                                            className="py-1.5 rounded-md bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 text-xs font-medium active:bg-gray-200">
                                            📊 {tr("เทียบเส้นทาง", "Compare")}{savedRoutes.length > 0 ? ` (${savedRoutes.length})` : ""}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="grid grid-cols-3 gap-1.5">
                            <button onClick={undo} disabled={undoStack.current.length === 0}
                                className="py-1.5 px-2 bg-gray-100 dark:bg-gray-700 rounded text-xs font-medium text-gray-700 dark:text-gray-200 active:bg-gray-200 disabled:opacity-50">{tr("ย้อน", "Undo")}</button>
                            <button onClick={redo} disabled={redoStack.current.length === 0}
                                className="py-1.5 px-2 bg-gray-100 dark:bg-gray-700 rounded text-xs font-medium text-gray-700 dark:text-gray-200 active:bg-gray-200 disabled:opacity-50">{tr("ทำซ้ำ", "Redo")}</button>
                            <button onClick={clearRoute} disabled={waypoints.length === 0}
                                className="py-1.5 px-2 bg-red-50 text-red-700 rounded text-xs font-medium active:bg-red-100 disabled:opacity-50">🗑️ {tr("ล้าง", "Clear")}</button>
                        </div>
                    </div>
                )}

                <div className="flex-1 map-frame relative">
                    <div id="map"></div>
                    {/* Fine zoom control (0-100%, 1% steps) floating on the map (left side) */}
                    <div className="absolute left-3 bottom-4 z-[800] flex flex-col items-center gap-1 bg-white/95 dark:bg-gray-900/95 rounded-full shadow-lg py-2 px-1.5 select-none">
                        <button onClick={() => applyZoomPct(zoomPct + 1)} title={tr("ขยาย", "Zoom in")}
                            className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-lg leading-none flex items-center justify-center active:bg-gray-200 dark:active:bg-gray-700">
                            +
                        </button>
                        <input type="range" min="0" max="100" step="1" value={zoomPct}
                            onChange={(e) => applyZoomPct(parseInt(e.target.value))}
                            title={tr("ระดับการซูม", "Zoom level")}
                            className="accent-green-600 cursor-pointer"
                            style={{ writingMode: "vertical-lr", direction: "rtl", width: "20px", height: "96px" }} />
                        <button onClick={() => applyZoomPct(zoomPct - 1)} title={tr("ย่อ", "Zoom out")}
                            className="w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-100 text-lg leading-none flex items-center justify-center active:bg-gray-200 dark:active:bg-gray-700">
                            −
                        </button>
                        <span className="text-[10px] font-semibold text-gray-600 dark:text-gray-300 tabular-nums w-8 text-center">{zoomPct}%</span>
                    </div>
                    {/* My-location control floating on the map (bottom-right) */}
                    <button onClick={centerOnMe} title={tr("ตำแหน่งฉัน", "My location")}
                        className="absolute bottom-4 right-3 z-[800] w-11 h-11 rounded-full bg-white dark:bg-gray-900 shadow-lg flex items-center justify-center text-xl active:bg-gray-100">
                        📍
                    </button>
                </div>
            </div>

            {/* (bottom bars removed — distance/time/pace now in the header; tools live in the menu) */}

            {/* (removed floating elevation popup — chart now lives in the left panel) */}
            {false && (
                <div className="fixed z-40 bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden"
                    style={elevPopupPos
                        ? { left: elevPopupPos.x, top: elevPopupPos.y, width: elevPopupDims.w, opacity: elevPopupOpacity }
                        : { right: 16, bottom: 16, width: elevPopupDims.w, opacity: elevPopupOpacity }}>
                    <div onPointerDown={startElevDrag}
                        className="flex items-center justify-between px-2 py-1 bg-gray-50 dark:bg-gray-800 border-b border-gray-100 cursor-move select-none touch-none">
                        <span className="text-xs font-semibold text-gray-700 dark:text-gray-200">⛰️ {tr("ความชัน", "Elevation")}</span>
                        <div className="flex items-center gap-1">
                            <input type="range" min="0.3" max="1" step="0.05"
                                value={elevPopupOpacity}
                                onChange={(e) => setElevPopupOpacity(parseFloat(e.target.value))}
                                className="w-12 mx-1 accent-green-600"
                                title={tr("ความโปร่งใส", "Opacity")} />
                            <button onClick={() => setElevPopupOpen(false)}
                                className="w-5 h-5 rounded bg-gray-200 active:bg-gray-300 text-gray-600 dark:text-gray-300 text-xs">✕</button>
                        </div>
                    </div>
                    <div className="p-2" style={{ height: elevPopupDims.h }}>
                        <ElevationChart elevations={elevations} totalDistanceM={plannedDistance} />
                    </div>
                    <div onPointerDown={startElevResize}
                        title={tr("ปรับขนาด", "Resize")}
                        className="absolute bottom-0 right-0 w-4 h-4 cursor-nwse-resize touch-none"
                        style={{ background: "linear-gradient(135deg, transparent 50%, #9ca3af 50%)" }} />
                </div>
            )}

            {/* Detailed elevation graph modal */}
            {elevModalOpen && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 p-3"
                     onClick={() => setElevModalOpen(false)}>
                    <div className="w-full max-w-3xl bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden"
                         onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-gray-700">
                            <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                                ⛰️ {tr("กราฟความชันแบบละเอียด", "Detailed elevation")}
                                <span className="text-xs font-normal text-gray-500 dark:text-gray-400 ml-2">{tr("แตะ/ลากบนกราฟเพื่ออ่านค่า", "Drag on the graph to read values")}</span>
                            </span>
                            <button onClick={() => setElevModalOpen(false)}
                                className="w-7 h-7 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 active:bg-gray-200">✕</button>
                        </div>
                        <div className="p-4">
                            <DetailedElevationChart elevations={lapElevations} totalDistanceM={lapDistance} />
                        </div>
                    </div>
                </div>
            )}

            {/* Route comparison modal */}
            {compareOpen && (() => {
                const current = lapElevations.length >= 2 && lapDistance > 0
                    ? { id: "__current", name: `${tr("เส้นทางปัจจุบัน", "Current route")}${lapCount > 1 ? ` ×${lapCount}` : ""}`, distanceM: lapDistance, elevations: lapElevations, current: true }
                    : null;
                const all = current ? [...savedRoutes, current] : savedRoutes.slice();
                const withColor = all.map((r, i) => ({ ...r, color: COMPARE_COLORS[i % COMPARE_COLORS.length] }));
                return (
                    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/50 p-3"
                         onClick={() => setCompareOpen(false)}>
                        <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl"
                             onClick={(e) => e.stopPropagation()}>
                            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-gray-700 sticky top-0 bg-white dark:bg-gray-900">
                                <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">📊 {tr("เทียบเส้นทาง", "Compare routes")}</span>
                                <button onClick={() => setCompareOpen(false)}
                                    className="w-7 h-7 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 active:bg-gray-200">✕</button>
                            </div>
                            {withColor.length === 0 ? (
                                <div className="p-8 text-center text-sm text-gray-400">
                                    {tr("ยังไม่มีเส้นทางให้เทียบ — ลากเส้นแล้วกด ➕ บันทึกเทียบ", "No routes yet — draw a route and tap ➕ Save")}
                                </div>
                            ) : (
                                <div className="p-4">
                                    <CompareChart routes={withColor} />
                                    <div className="overflow-x-auto mt-3">
                                        <table className="w-full text-xs whitespace-nowrap">
                                            <thead>
                                                <tr className="text-gray-500 dark:text-gray-400 text-left border-b border-gray-100 dark:border-gray-700">
                                                    <th className="py-1 pr-2 font-medium">{tr("เส้นทาง", "Route")}</th>
                                                    <th className="py-1 px-2 font-medium text-right">{tr("ระยะ", "Dist")}</th>
                                                    <th className="py-1 px-2 font-medium text-right">↑{tr("รวม", "gain")}</th>
                                                    <th className="py-1 px-2 font-medium text-right">{tr("ขึ้น/กม.", "gain/km")}</th>
                                                    <th className="py-1 px-2 font-medium text-right">{tr("ชันเฉลี่ย", "avg %")}</th>
                                                    <th className="py-1 px-2 font-medium text-right">{tr("ชันสุด", "max %")}</th>
                                                    <th className="py-1 pl-2"></th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {withColor.map((r) => {
                                                    const g = elevationGain(r.elevations);
                                                    const gpk = r.distanceM > 0 ? g / (r.distanceM / 1000) : 0;
                                                    const gs = gradeStats(r.elevations, r.distanceM);
                                                    return (
                                                        <tr key={r.id} className="border-b border-gray-50 dark:border-gray-800">
                                                            <td className="py-1.5 pr-2">
                                                                <span className="inline-flex items-center gap-1.5">
                                                                    <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: r.color }} />
                                                                    {r.current ? (
                                                                        <span className="text-gray-800 dark:text-gray-100">{r.name}</span>
                                                                    ) : (
                                                                        <input value={r.name} onChange={(e) => renameSaved(r.id, e.target.value)}
                                                                            className="w-24 bg-transparent border-b border-dashed border-gray-300 dark:border-gray-600 text-gray-800 dark:text-gray-100 focus:outline-none" />
                                                                    )}
                                                                </span>
                                                            </td>
                                                            <td className="py-1.5 px-2 text-right tabular-nums">{(r.distanceM / 1000).toFixed(2)}{tr("กม", "k")}</td>
                                                            <td className="py-1.5 px-2 text-right tabular-nums text-green-700 dark:text-green-400">{Math.round(g)}{tr("ม", "m")}</td>
                                                            <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{Math.round(gpk)}</td>
                                                            <td className="py-1.5 px-2 text-right tabular-nums">{gs.avg.toFixed(1)}</td>
                                                            <td className="py-1.5 px-2 text-right tabular-nums">{gs.max.toFixed(1)}</td>
                                                            <td className="py-1.5 pl-2 text-right">
                                                                {!r.current && (
                                                                    <button onClick={() => deleteSaved(r.id)} className="text-red-500 active:text-red-700">✕</button>
                                                                )}
                                                            </td>
                                                        </tr>
                                                    );
                                                })}
                                            </tbody>
                                        </table>
                                    </div>
                                    <p className="mt-3 text-[10px] text-gray-400 leading-snug">
                                        {tr("กราฟเทียบรูปทรงการไต่ (แกน X = % ระยะ) — ความชันจริงดูที่ ขึ้น/กม. และ ชันสุด",
                                            "Chart compares climb shape (X = % distance) — for true steepness compare gain/km and max %.")}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                );
            })()}

            {toast && (
                <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-2 rounded-full text-sm shadow-lg z-30">
                    {toast}
                </div>
            )}
        </div>
    );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
