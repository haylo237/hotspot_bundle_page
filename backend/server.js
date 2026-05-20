/**
 * server.js
 * ---------------------------------------------------------------------------
 * HAYLO INTERNET — backend entry point.
 *
 *   npm install
 *   cp .env.example .env   # then edit values
 *   npm start
 *
 * Topology:
 *   Client ── MikroTik (10.5.50.1) ── Mini-server (10.5.50.2:3000) ── CamPay
 * ---------------------------------------------------------------------------
 */

require("dotenv").config();

const express = require("express");
const cors    = require("cors");

const hotspotRoutes     = require("./routes/hotspot");
const diagnosticsRoutes = require("./routes/diagnostics");
const adminRoutes       = require("./routes/admin");
const mikrotik          = require("./services/mikrotikService");

const app  = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = "0.0.0.0";  // bind all interfaces — hotspot clients reach us via LAN

/* ---------------------------------------------------------------------------
 * CORS
 * The captive portal HTML is served by MikroTik (origin http://10.5.50.1) and
 * may also be opened as a `file://` URL (origin "null"). Allow:
 *   - http://10.5.50.1            (MikroTik captive portal)
 *   - http://<BASE_URL host>      (the mini-server itself)
 *   - "null"                      (file:// origin some captive portals use)
 *   - anything in CORS_EXTRA_ORIGINS (comma-separated)
 * ------------------------------------------------------------------------- */
const defaultAllowed = [
    "http://10.5.50.1",
    "http://10.5.50.1:80",
    "http://10.5.50.2:" + PORT,
    "null"
];
if (process.env.BASE_URL) defaultAllowed.push(process.env.BASE_URL.replace(/\/$/, ""));
const extraOrigins = (process.env.CORS_EXTRA_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set(defaultAllowed.concat(extraOrigins));

app.use(cors({
    origin: function (origin, cb) {
        // No Origin header (curl, same-origin, captive-portal probes) → allow
        if (!origin) return cb(null, true);
        if (ALLOWED_ORIGINS.has(origin)) return cb(null, true);
        // Fallback: allow any local LAN origin so captive-portal quirks don't
        // break the flow. Adjust if you need stricter CORS.
        console.warn("[cors] origin not in allow-list, accepting anyway:", origin);
        return cb(null, true);
    },
    credentials: false,
    methods: ["GET", "POST", "OPTIONS"]
}));

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

/* ---------- request log ---------- */
app.use((req, _res, next) => {
    console.log(new Date().toISOString(), req.method, req.originalUrl,
                "from", req.ip || req.connection.remoteAddress || "?");
    next();
});

/* ---------- health ---------- */
app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "haylo-hotspot-backend", time: new Date().toISOString() });
});

/* ---------- routes ---------- */
app.use("/api/hotspot",      hotspotRoutes);
app.use("/api/diagnostics",  diagnosticsRoutes);
app.use("/admin",            adminRoutes);

/* ---------- 404 / error handlers ---------- */
app.use((req, res) => {
    res.status(404).json({ status: "error", code: "ER404", message: "Not found." });
});
app.use((err, _req, res, _next) => {
    console.error("[unhandled]", err);
    res.status(500).json({ status: "error", code: "ER500", message: "Internal server error." });
});

/* ---------------------------------------------------------------------------
 * Startup diagnostics
 * ------------------------------------------------------------------------- */
function banner() {
    const mhost = process.env.MIKROTIK_HOST || "(unset)";
    const mport = process.env.MIKROTIK_PORT || "8728";
    console.log("================================================================");
    console.log(" HAYLO backend");
    console.log("   listening on:    http://" + HOST + ":" + PORT);
    console.log("   BASE_URL:        " + (process.env.BASE_URL || "(unset)"));
    console.log("   CamPay base:     " + (process.env.CAMPAY_BASE_URL || "https://demo.campay.net"));
    console.log("   MikroTik:        " + mhost + ":" + mport);
    console.log("   Allowed origins: " + Array.from(ALLOWED_ORIGINS).join(", "));
    console.log("   Offers source:   MikroTik hotspot user-profiles (comment JSON)");
    console.log("   Admin UI:        " + (process.env.ADMIN_PASSWORD ? "enabled at /admin/" : "disabled (set ADMIN_PASSWORD)"));
    console.log("================================================================");
}

async function pingMikrotik() {
    try {
        const profiles = await mikrotik.getHotspotProfiles({ force: true });
        if (profiles.length === 0) {
            console.warn("[startup] MikroTik returned 0 profiles — check API access and credentials.");
            return;
        }
        console.log("[startup] MikroTik OK. Profiles found: " + profiles.join(", "));
        const offers = await mikrotik.listOffers({ force: true });
        if (offers.length === 0) {
            console.warn("[startup] No saleable offers found. Add a JSON comment to each profile (see README).");
            return;
        }
        console.log("[startup] Saleable offers loaded from profiles:");
        offers.forEach(o => console.log("     - " + o.id + " (profile: " + o.profile + ", " + o.price + " XAF, " + o.duration + ", " + o.speed + ")"));
        const unconfigured = profiles.filter(p => !offers.some(o => o.profile === p));
        if (unconfigured.length) {
            console.log("[startup] Profiles without saleable comment (ignored): " + unconfigured.join(", "));
        }
    } catch (err) {
        console.error("[startup] MikroTik connection FAILED:", err && err.message);
    }
}

/* ---------- start ---------- */
app.listen(PORT, HOST, () => {
    banner();
    pingMikrotik();
});
