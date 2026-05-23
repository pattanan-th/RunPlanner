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

async function fetchElevation(coords) {
    if (coords.length === 0) return [];
    const step = Math.max(1, Math.floor(coords.length / 100));
    const sampled = coords.filter((_, i) => i % step === 0);
    const locations = sampled.map(c => `${c.lat.toFixed(5)},${c.lng.toFixed(5)}`).join("|");
    try {
        const res = await fetch(`https://api.open-elevation.com/api/v1/lookup?locations=${locations}`);
        if (!res.ok) throw new Error("elevation");
        return (await res.json()).results.map(r => r.elevation);
    } catch (e) { return []; }
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
                                  className="absolute text-[9px] text-gray-500 whitespace-nowrap"
                                  style={{ left: `${pct}%`, transform: "translateX(-50%)" }}>
                                {km < 1 ? `${Math.round(km * 1000)}${tr("ม", "m")}` : `${km.toFixed(km % 1 === 0 ? 0 : 1)}${tr("กม", "km")}`}
                            </span>
                        );
                    })}
                </div>
            </div>
            <div className="flex justify-between text-[10px] text-gray-600 mt-1">
                <span>{tr("ต่ำ", "Low")} {Math.round(min)}{tr("ม", "m")}</span>
                <span className="text-green-700">↑{Math.round(elevationGain(elevations))}{tr("ม", "m")}</span>
                <span className="text-red-700">↓{Math.round(elevationLoss(elevations))}{tr("ม", "m")}</span>
                <span>{tr("สูง", "High")} {Math.round(max)}{tr("ม", "m")}</span>
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

    const [paceMin, setPaceMin] = useState(6);
    const [paceSec, setPaceSec] = useState(0);
    const [paceOpen, setPaceOpen] = useState(false);

    const [uiVisible, setUiVisible] = useState(true);
    const [panelOpen, setPanelOpen] = useState(false); // mobile drawer (left panel) open/closed; desktop always shows inline
    const [bottomCollapsed, setBottomCollapsed] = useState(false);
    const [editorOpen, setEditorOpen] = useState(false);
    const [simplifyEpsilon, setSimplifyEpsilon] = useState(30);
    const [elevPopupOpen, setElevPopupOpen] = useState(false);
    const [elevPopupOpacity, setElevPopupOpacity] = useState(0.95);
    const [elevPopupPos, setElevPopupPos] = useState(null);          // {x,y} top-left in px; null = default bottom-right
    const [elevPopupDims, setElevPopupDims] = useState({ w: 300, h: 170 });
    const [toast, setToast] = useState(null);

    const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 2500); };

    useEffect(() => {
        if (mapInstanceRef.current) return;
        const map = L.map("map", { center: [13.7563, 100.5018], zoom: 14, zoomControl: false });
        L.control.zoom({ position: "topright" }).addTo(map);
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: '&copy; OSM', maxZoom: 19 }).addTo(map);
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
        if (!map) return;
        const handler = async (e) => {
            const pt = { lat: e.latlng.lat, lng: e.latlng.lng };
            if (loopMode) {
                const km = parseFloat(customKm) || loopKm;
                if (!km || km <= 0) { showToast(tr("เลือกระยะทางก่อน", "Choose a distance first")); return; }
                if (generatingLoop) return;
                setLoopStart(pt);
                setGeneratingLoop(true);
                const typeName = loopType === "oneway" ? tr("ไปไม่กลับ", "one-way") : tr("วงกลม", "loop");
                showToast(`${tr("กำลังสร้างเส้นทาง", "Creating route")} ${typeName} ${km} ${tr("กม.", "km")} ...`);
                const seed = Math.random();
                const result = loopType === "oneway"
                    ? await generateSmoothOneWay(pt, km * 1000, seed, loopPoints, 8)
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
            const size = isStart ? 30 : 26;
            const html = `<div class="run-marker ${isStart ? "run-marker-start" : ""}">${i + 1}</div>`;
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
            if (routeLineRef.current) { routeLineRef.current.remove(); routeLineRef.current = null; }
            setRoutedCoords([]);
            return;
        }

        // If these waypoints just came from the auto-generator, reuse its routed geometry —
        // skips an extra routing round-trip and prevents straight-line fallback on transient failures.
        const wpKey = waypoints.map(w => `${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join("|");
        if (generatedRouteRef.current && generatedRouteRef.current.key === wpKey) {
            setRoutedCoords(generatedRouteRef.current.coords);
            drawRouteLine(generatedRouteRef.current.coords);
            return;
        }

        let cancelled = false;
        (async () => {
            if (!snapToRoads) {
                if (cancelled) return;
                setRoutedCoords(waypoints);
                drawRouteLine(waypoints);
                return;
            }
            setLoadingRoute(true);
            const result = await fetchMultiWaypointRoute(waypoints);
            if (cancelled) return;
            setLoadingRoute(false);
            if (result) {
                setRoutedCoords(result.allCoords);
                drawRouteLine(result.allCoords);
            } else {
                setRoutedCoords(waypoints);
                drawRouteLine(waypoints);
            }
        })();
        return () => { cancelled = true; };
    }, [waypoints, snapToRoads, routeProfile]);

    function drawRouteLine(coords) {
        const map = mapInstanceRef.current;
        if (!map) return;
        if (routeLineRef.current) routeLineRef.current.remove();
        if (coords.length < 2) return;
        routeLineRef.current = L.polyline(coords.map(c => [c.lat, c.lng]), { color: "#10b981", weight: 5, opacity: 0.85 }).addTo(map);
    }

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
    const gain = useMemo(() => elevationGain(elevations), [elevations]);
    const loss = useMemo(() => elevationLoss(elevations), [elevations]);
    const paceSecPerKm = paceMin * 60 + paceSec;
    const estimatedSeconds = plannedDistance > 0 ? (plannedDistance / 1000) * paceSecPerKm : 0;

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

    const editableWps = useMemo(() => {
        if (waypoints.length > 1
            && waypoints[0].lat === waypoints[waypoints.length - 1].lat
            && waypoints[0].lng === waypoints[waypoints.length - 1].lng) {
            return waypoints.slice(0, -1);
        }
        return waypoints;
    }, [waypoints]);

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
    const moveWaypoint = (i, dir) => {
        setWaypoints(prev => {
            const closed = prev.length > 1
                && prev[0].lat === prev[prev.length - 1].lat
                && prev[0].lng === prev[prev.length - 1].lng;
            const list = closed ? prev.slice(0, -1) : prev.slice();
            const j = i + dir;
            if (j < 0 || j >= list.length) return prev;
            [list[i], list[j]] = [list[j], list[i]];
            if (closed) list.push(list[0]);
            return list;
        });
    };
    const deleteWaypointAt = (i) => {
        setWaypoints(prev => {
            const closed = prev.length > 1
                && prev[0].lat === prev[prev.length - 1].lat
                && prev[0].lng === prev[prev.length - 1].lng;
            const list = closed ? prev.slice(0, -1) : prev.slice();
            list.splice(i, 1);
            if (closed && list.length > 0) list.push(list[0]);
            return list;
        });
        showToast(tr("ลบจุดแล้ว", "Point deleted"));
    };
    const insertAfter = (i) => {
        setWaypoints(prev => {
            if (prev.length === 0) return prev;
            const next = i + 1 < prev.length ? prev[i + 1] : prev[i];
            const newPt = { lat: (prev[i].lat + next.lat) / 2, lng: (prev[i].lng + next.lng) / 2 };
            const list = prev.slice();
            list.splice(i + 1, 0, newPt);
            return list;
        });
        showToast(tr("แทรกจุดกลางแล้ว", "Inserted midpoint"));
    };
    const updateWaypointCoord = (i, key, val) => {
        const n = parseFloat(val);
        if (isNaN(n)) return;
        setWaypoints(prev => {
            const next = prev.slice();
            next[i] = { ...next[i], [key]: n };
            return next;
        });
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
    const undoWaypoint = () => setWaypoints(prev => prev.slice(0, -1));
    const clearRoute = () => {
        setWaypoints([]);
        setElevations([]);
        setLoopStart(null);
        location.hash = "";
        showToast(tr("ล้างเส้นทางแล้ว", "Route cleared"));
    };
    const regenerateLoop = async (typeOverride) => {
        if (!loopStart) { showToast(tr("แตะที่แผนที่เพื่อเลือกจุดเริ่มต้น", "Tap the map to choose a start point")); return; }
        if (generatingLoop) return;
        const type = typeOverride || loopType; // explicit type avoids stale state right after switching
        const km = parseFloat(customKm) || loopKm;
        setGeneratingLoop(true);
        const typeName = type === "oneway" ? tr("ไปไม่กลับ", "one-way") : tr("วงกลม", "loop");
        showToast(`${tr("กำลังสุ่มใหม่", "Regenerating")} ${typeName} ${km} ${tr("กม.", "km")} ...`);
        const result = type === "oneway"
            ? await generateSmoothOneWay(loopStart, km * 1000, Math.random(), loopPoints, 8)
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
        <div className="flex flex-col h-full app-bg">
            {/* Header */}
            {uiVisible && (
                <header className="flex items-center justify-between px-4 py-2 bg-white shadow-sm">
                    <div className="flex items-center gap-2">
                        <div className="text-2xl">🏃</div>
                        <div>
                            <div className="font-bold text-gray-800 leading-tight text-sm">RunPlanner</div>
                            <div className="text-[10px] text-gray-500 leading-tight">{tr("วางแผนเส้นทางวิ่ง", "Plan your running route")}</div>
                        </div>
                    </div>
                    <div className="text-xs text-gray-600">
                        {plannedDistance > 0 && (
                            <span><b className="text-green-700">{fmtDistance(plannedDistance)}</b>
                                {(gain > 0 || loss > 0) && <span> · <span className="text-orange-600">↑{Math.round(gain)}</span>·<span className="text-blue-600">↓{Math.round(loss)}</span>{tr("ม.", "m")}</span>}
                                {estimatedSeconds > 0 && <span> · ⏱ {fmtTime(estimatedSeconds)}</span>}
                            </span>
                        )}
                    </div>
                </header>
            )}

            {/* Quick-access bar — most-used controls, always visible (scrolls horizontally on mobile) */}
            {uiVisible && (
                <div className="bg-white border-b border-gray-200 px-2 py-1.5 flex items-center gap-1.5 overflow-x-auto whitespace-nowrap shadow-sm">
                    <button onClick={() => setLoopMode(m => !m)}
                        className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${loopMode ? "bg-green-600 text-white" : "bg-gray-100 text-gray-700"}`}>
                        🔄 {tr("อัตโนมัติ", "Auto")}
                    </button>
                    {loopMode ? (
                        <>
                            <div className="flex-shrink-0 flex rounded-full overflow-hidden border border-gray-300">
                                <button onClick={() => switchLoopType("loop")}
                                    className={`px-2.5 py-1 text-xs font-medium ${loopType === "loop" ? "bg-green-600 text-white" : "bg-white text-gray-700"}`}>🔁 {tr("ไปกลับ", "Round")}</button>
                                <button onClick={() => switchLoopType("oneway")}
                                    className={`px-2.5 py-1 text-xs font-medium ${loopType === "oneway" ? "bg-green-600 text-white" : "bg-white text-gray-700"}`}>➡️ {tr("ไปไม่กลับ", "One-way")}</button>
                            </div>
                            <span className="flex-shrink-0 w-px h-5 bg-gray-200" />
                            {LOOP_PRESETS.map(p => (
                                <button key={p.km} onClick={() => { setLoopKm(p.km); setCustomKm(""); }}
                                    className={`flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium ${!customKm && loopKm === p.km ? "bg-green-600 text-white" : "bg-gray-100 text-gray-700"}`}>
                                    {p.km} {tr("กม.", "km")}
                                </button>
                            ))}
                            <button onClick={() => regenerateLoop()} disabled={!loopStart || generatingLoop}
                                className="flex-shrink-0 px-2.5 py-1 rounded-full text-xs font-medium bg-green-100 text-green-700 active:bg-green-200 disabled:opacity-50">
                                {generatingLoop ? "..." : "🎲"}
                            </button>
                        </>
                    ) : (
                        <span className="text-[11px] text-gray-400 px-1">{tr("👆 แตะแผนที่เพื่อปักจุดเอง", "👆 Tap map to place points")}</span>
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
                {/* Mobile: backdrop behind the drawer */}
                {uiVisible && panelOpen && (
                    <div onClick={() => setPanelOpen(false)}
                        className="fixed inset-0 bg-black bg-opacity-40 z-[1100] md:hidden" />
                )}
                {/* Mobile: floating button to open the drawer */}
                {uiVisible && !panelOpen && (
                    <button onClick={() => setPanelOpen(true)}
                        className="md:hidden absolute top-3 left-3 z-[900] w-10 h-10 rounded-full bg-white shadow-lg flex items-center justify-center text-xl active:bg-gray-100"
                        title={tr("เมนู", "Menu")}>☰</button>
                )}
                {/* LEFT panel: loop generator + waypoint editor — drawer on mobile, inline column on desktop */}
                {uiVisible && (
                    <div className={`flex flex-col gap-2 overflow-y-auto bg-white shadow p-3 transition-transform fixed inset-y-0 left-0 z-[1200] w-64 max-w-[82%] rounded-r-xl ${panelOpen ? "translate-x-0" : "-translate-x-full"} md:static md:translate-x-0 md:w-64 md:flex-shrink-0 md:rounded-xl md:z-auto md:max-w-none`}>
                        {/* Mobile: close drawer */}
                        <button onClick={() => setPanelOpen(false)}
                            className="md:hidden self-end w-8 h-8 -mt-1 -mr-1 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 active:bg-gray-200">✕</button>
                        {/* Loop generator */}
                        <div className="p-2 bg-gray-50 rounded-lg">
                            <label className="flex items-center gap-2 text-sm font-medium text-gray-800 cursor-pointer">
                                <input type="checkbox" checked={loopMode}
                                    onChange={(e) => setLoopMode(e.target.checked)}
                                    className="w-4 h-4 accent-green-600" />
                                🔄 {tr("สร้างเส้นทางอัตโนมัติ", "Auto-generate route")}
                            </label>
                            {loopMode && (
                                <div className="mt-2">
                                    <div className="flex gap-1 mb-2">
                                        <button onClick={() => changeRouteProfile("foot")}
                                            className={`flex-1 py-1 rounded text-xs font-medium ${routeProfile === "foot" ? "bg-green-600 text-white" : "bg-white border border-gray-300 text-gray-700"}`}>
                                            🏘️ {tr("รวมซอย", "Incl. alleys")}
                                        </button>
                                        <button onClick={() => changeRouteProfile("driving")}
                                            className={`flex-1 py-1 rounded text-xs font-medium ${routeProfile === "driving" ? "bg-green-600 text-white" : "bg-white border border-gray-300 text-gray-700"}`}>
                                            🛣️ {tr("ถนนหลัก", "Main roads")}
                                        </button>
                                    </div>
                                    <div className="flex items-center gap-1 mb-2">
                                        <input type="number" inputMode="decimal" step="0.5" min="0.5"
                                            placeholder={tr("กำหนดเอง (กม.)", "Custom (km)")} value={customKm}
                                            onChange={(e) => setCustomKm(e.target.value)}
                                            className="flex-1 min-w-0 px-2 py-1 text-xs border border-gray-300 rounded focus:outline-none focus:border-green-500" />
                                        <button onClick={regenerateLoop} disabled={!loopStart || generatingLoop}
                                            className="px-2 py-1 bg-green-100 text-green-700 rounded text-xs font-medium active:bg-green-200 disabled:opacity-50">
                                            {generatingLoop ? "..." : "🎲"}
                                        </button>
                                    </div>
                                    {loopType !== "oneway" && (
                                        <div className="flex items-center gap-1.5 text-xs text-gray-700">
                                            <span>{tr("เริ่ม:", "Start:")}</span>
                                            <button onClick={() => setLoopPoints(n => Math.max(3, n - 1))}
                                                className="w-5 h-5 rounded bg-gray-200 font-bold active:bg-gray-300">−</button>
                                            <span className="font-bold w-4 text-center">{loopPoints}</span>
                                            <button onClick={() => setLoopPoints(n => Math.min(8, n + 1))}
                                                className="w-5 h-5 rounded bg-gray-200 font-bold active:bg-gray-300">+</button>
                                            <span className="text-gray-500 text-[10px]">{tr("จุด · auto-grow", "pts · auto-grow")}</span>
                                        </div>
                                    )}
                                    {!loopStart && (
                                        <div className="text-[10px] text-gray-500 mt-2">👆 {tr("แตะที่แผนที่", "Tap the map")}</div>
                                    )}
                                </div>
                            )}
                            {!loopMode && (
                                <label className="flex items-center gap-2 text-xs text-gray-700 mt-2">
                                    <input type="checkbox" checked={snapToRoads}
                                        onChange={(e) => setSnapToRoads(e.target.checked)}
                                        className="w-4 h-4 accent-green-600" />
                                    {tr("ลากเส้นเอง", "Draw line")}
                                </label>
                            )}
                        </div>

                        {/* Waypoint editor */}
                        <div className="border border-gray-200 rounded-lg overflow-hidden">
                            <div className="px-3 py-2 bg-gray-50 text-sm font-medium text-gray-800">
                                ✏️ {tr("แก้ไขจุดผ่าน", "Edit waypoints")} ({editableWps.length})
                            </div>
                            <div className="p-2 space-y-2 bg-white">
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
                                    <span className="text-[10px] text-gray-500">{tr("ลด", "min")} &gt;</span>
                                    <input type="number" min="5" max="500" step="5" value={simplifyEpsilon}
                                        onChange={(e) => setSimplifyEpsilon(parseInt(e.target.value) || 30)}
                                        className="w-14 px-1 py-0.5 text-[10px] border border-gray-300 rounded" />
                                    <span className="text-[10px] text-gray-500">{tr("ม.", "m")}</span>
                                </div>
                                {editableWps.length === 0 ? (
                                    <div className="text-[10px] text-gray-400 text-center py-2">{tr("ยังไม่มีจุดผ่าน", "No waypoints yet")}</div>
                                ) : (
                                    <div className="space-y-1">
                                        {editableWps.map((wp, i) => (
                                            <div key={i} className="flex items-center gap-1 bg-gray-50 rounded px-2 py-1.5 text-xs">
                                                <span className="font-bold text-gray-700 w-5">{i + 1}</span>
                                                <span className="flex-1 text-gray-400">{tr("จุดที่", "Point")} {i + 1}</span>
                                                <button onClick={() => moveWaypoint(i, -1)} disabled={i === 0}
                                                    className="px-1.5 py-0.5 text-sm text-gray-500 disabled:opacity-30">↑</button>
                                                <button onClick={() => moveWaypoint(i, 1)} disabled={i === editableWps.length - 1}
                                                    className="px-1.5 py-0.5 text-sm text-gray-500 disabled:opacity-30">↓</button>
                                                <button onClick={() => insertAfter(i)}
                                                    className="px-1.5 py-0.5 text-sm text-green-600">＋</button>
                                                <button onClick={() => deleteWaypointAt(i)}
                                                    className="px-1.5 py-0.5 text-sm text-red-500">×</button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-1.5">
                            <button onClick={undoWaypoint} disabled={waypoints.length === 0}
                                className="py-1.5 px-2 bg-gray-100 rounded text-xs font-medium text-gray-700 active:bg-gray-200 disabled:opacity-50">↶ {tr("ย้อน", "Undo")}</button>
                            <button onClick={clearRoute} disabled={waypoints.length === 0}
                                className="py-1.5 px-2 bg-red-50 text-red-700 rounded text-xs font-medium active:bg-red-100 disabled:opacity-50">🗑️ {tr("ล้าง", "Clear")}</button>
                        </div>
                    </div>
                )}

                <div className="flex-1 map-frame relative">
                    <div id="map"></div>
                </div>
                <div className="flex flex-col gap-2">
                    <button onClick={toggleLang} className="side-rail-btn"
                        title={tr("ภาษา: ไทย (แตะเพื่อเปลี่ยนเป็นอังกฤษ)", "Language: English (tap to switch to Thai)")}>
                        <span className="text-base font-bold text-green-700">{lang === "en" ? "E" : "T"}</span>
                    </button>
                    <button onClick={() => setUiVisible(v => !v)} className="side-rail-btn" title={uiVisible ? tr("ซ่อน UI", "Hide UI") : tr("แสดง UI", "Show UI")}>
                        <span className="text-lg">{uiVisible ? "🙈" : "👁️"}</span>
                    </button>
                    <button onClick={centerOnMe} className="side-rail-btn" title={tr("ตำแหน่งฉัน", "My location")}>
                        <span className="text-lg">📍</span>
                    </button>
                    <button onClick={shareRoute} disabled={waypoints.length < 2}
                        className="side-rail-btn" title={tr("แชร์ลิงก์", "Share link")}
                        style={{ opacity: waypoints.length < 2 ? 0.4 : 1 }}>
                        <span className="text-lg">🔗</span>
                    </button>
                    <button onClick={exportGpx} disabled={routedCoords.length < 2}
                        className="side-rail-btn" title={tr("ดาวน์โหลด GPX", "Download GPX")}
                        style={{ opacity: routedCoords.length < 2 ? 0.4 : 1 }}>
                        <span className="text-lg">📥</span>
                    </button>
                    <button onClick={() => setElevPopupOpen(o => !o)}
                        className={`side-rail-btn ${elevPopupOpen ? "ring-2 ring-green-500" : ""}`}
                        title={tr("โปรไฟล์ความชัน", "Elevation profile")}
                        disabled={elevations.length < 2}
                        style={{ opacity: elevations.length < 2 ? 0.4 : 1 }}>
                        <span className="text-lg">⛰️</span>
                    </button>
                </div>
            </div>

            {/* Bottom bar — compact: distance + ↑↓ + pace */}
            {uiVisible && (
                <div className="bg-white border-t border-gray-200 shadow-lg px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
                    <div className="flex items-baseline gap-3 flex-wrap">
                        <div>
                            <div className="text-[10px] text-gray-500 leading-none">{tr("ระยะทาง", "Distance")}</div>
                            <div className="text-2xl font-bold text-green-700 leading-tight">
                                {loadingRoute ? "..." : fmtDistance(plannedDistance)}
                            </div>
                        </div>
                        {(gain > 0 || loss > 0) && (
                            <div className="flex items-baseline gap-1 text-sm whitespace-nowrap">
                                <span className="text-orange-600 font-semibold">↑{Math.round(gain)}</span>
                                <span className="text-gray-400">·</span>
                                <span className="text-blue-600 font-semibold">↓{Math.round(loss)}</span>
                                <span className="text-gray-400 text-xs">{tr("ม.", "m")}</span>
                            </div>
                        )}
                        {loadingElev && elevations.length === 0 && plannedDistance > 0 && (
                            <div className="text-xs text-gray-400">{tr("วิเคราะห์ความชัน...", "Analyzing elevation...")}</div>
                        )}
                    </div>
                    <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Pace</span>
                        <input type="number" min="3" max="15" value={paceMin}
                            onChange={(e) => setPaceMin(Math.max(3, Math.min(15, parseInt(e.target.value) || 6)))}
                            className="w-12 px-1 py-1 text-sm border border-gray-300 rounded text-center" />
                        <span className="font-bold text-gray-700">:</span>
                        <input type="number" min="0" max="59" value={paceSec}
                            onChange={(e) => setPaceSec(Math.max(0, Math.min(59, parseInt(e.target.value) || 0)))}
                            className="w-12 px-1 py-1 text-sm border border-gray-300 rounded text-center" />
                        <span className="text-xs text-gray-500">/{tr("กม.", "km")}</span>
                        {estimatedSeconds > 0 && (
                            <div className="text-sm font-bold text-purple-700 ml-1 whitespace-nowrap">
                                ⏱ {fmtTime(estimatedSeconds)}
                            </div>
                        )}
                    </div>
                </div>
            )}


            {/* Elevation profile floating popup — draggable (header) + resizable (corner) */}
            {elevPopupOpen && elevations.length >= 2 && (
                <div className="fixed z-40 bg-white rounded-xl shadow-2xl border border-gray-200 overflow-hidden"
                    style={elevPopupPos
                        ? { left: elevPopupPos.x, top: elevPopupPos.y, width: elevPopupDims.w, opacity: elevPopupOpacity }
                        : { right: 16, bottom: 16, width: elevPopupDims.w, opacity: elevPopupOpacity }}>
                    <div onPointerDown={startElevDrag}
                        className="flex items-center justify-between px-2 py-1 bg-gray-50 border-b border-gray-100 cursor-move select-none touch-none">
                        <span className="text-xs font-semibold text-gray-700">⛰️ {tr("ความชัน", "Elevation")}</span>
                        <div className="flex items-center gap-1">
                            <input type="range" min="0.3" max="1" step="0.05"
                                value={elevPopupOpacity}
                                onChange={(e) => setElevPopupOpacity(parseFloat(e.target.value))}
                                className="w-12 mx-1 accent-green-600"
                                title={tr("ความโปร่งใส", "Opacity")} />
                            <button onClick={() => setElevPopupOpen(false)}
                                className="w-5 h-5 rounded bg-gray-200 active:bg-gray-300 text-gray-600 text-xs">✕</button>
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

            {toast && (
                <div className="absolute top-16 left-1/2 -translate-x-1/2 bg-gray-900 text-white px-4 py-2 rounded-full text-sm shadow-lg z-30">
                    {toast}
                </div>
            )}
        </div>
    );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
