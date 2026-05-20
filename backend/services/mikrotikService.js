/**
 * services/mikrotikService.js
 * ---------------------------------------------------------------------------
 * RouterOS API wrapper.
 *   - getHotspotProfiles()                  → string[] of profile names
 *   - profileExists(name)                   → boolean
 *   - createHotspotUser({username, password, profile, comment})
 *   - generateUsername() / generatePassword()
 *
 * Profile list is cached for 60s (profiles change rarely).
 * ---------------------------------------------------------------------------
 */

const { RouterOSAPI } = require("node-routeros");

function buildClient() {
    return new RouterOSAPI({
        host:     process.env.MIKROTIK_HOST     || "192.168.88.1",
        user:     process.env.MIKROTIK_USER     || "admin",
        password: process.env.MIKROTIK_PASSWORD || "",
        port:     parseInt(process.env.MIKROTIK_PORT || "8728", 10),
        timeout:  10
    });
}

/* ---------- credential generators ---------- */

function generateUsername() {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // skip confusing 0/o/1/l
    let s = "u";
    for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

function generatePassword() {
    let s = "";
    for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
    return s;
}

/* ---------- profile lookup (cached 60s) ---------- */

let _profileCache = null;       // { rows: object[], names: string[], at: number }
const PROFILE_TTL_MS = 60 * 1000;

async function getRawProfiles({ force = false } = {}) {
    if (!force && _profileCache && (Date.now() - _profileCache.at) < PROFILE_TTL_MS) {
        return _profileCache.rows;
    }
    const api = buildClient();
    try {
        await api.connect();
        const rows = await api.write(["/ip/hotspot/user/profile/print"]);
        const cleaned = (rows || []).filter(r => r && typeof r.name === "string" && r.name.length > 0);
        const names   = cleaned.map(r => r.name);
        _profileCache = { rows: cleaned, names, at: Date.now() };
        return cleaned;
    } catch (err) {
        console.error("[mikrotik] getRawProfiles failed:", err && err.message);
        return [];
    } finally {
        try { api.close(); } catch (_) { /* ignore */ }
    }
}

async function getHotspotProfiles(opts) {
    const rows = await getRawProfiles(opts);
    return rows.map(r => r.name);
}

async function profileExists(name) {
    if (!name) return false;
    const names = await getHotspotProfiles();
    return names.indexOf(name) !== -1;
}

/* ---------- offer extraction --------------------------------------------
 * Each MikroTik hotspot user-profile may carry a JSON blob in its `comment`
 * field describing the saleable bundle. Profiles without a valid blob are
 * ignored (so you can keep "default" or staff profiles on the router
 * without exposing them in the portal).
 *
 * Example comment to set on the router:
 *   /ip hotspot user profile set [find name=1hour] \
 *     comment="{\"price\":100,\"name\":\"1 Hour\",\"description\":\"Best for quick browsing\"}"
 *
 * Supported keys (all optional except `price`):
 *   price        number   REQUIRED — XAF amount
 *   name         string   display name (defaults to profile name)
 *   description  string   short marketing line
 *   id           string   stable id used by the frontend (defaults to profile name)
 *   speed        string   override displayed speed (defaults to formatted rate-limit)
 *   duration     string   override displayed duration (defaults to session-timeout)
 *   order        number   sort order (lower first); profiles without `order` go last
 *   hidden       boolean  if true, profile is excluded from /offers
 * ------------------------------------------------------------------------- */

function parseProfileMeta(comment) {
    if (typeof comment !== "string") return null;
    const s = comment.trim();
    if (!s || s[0] !== "{") return null;
    try { return JSON.parse(s); } catch (_) { return null; }
}

function formatRate(rateLimit) {
    // RouterOS rate-limit looks like "3M/3M" (rx/tx) or "3M/3M 4M/4M ..."
    if (!rateLimit || typeof rateLimit !== "string") return "";
    const first = rateLimit.split(/\s+/)[0];          // "3M/3M"
    const down  = first.split("/")[0];                // "3M"
    if (!down) return "";
    // 3M -> 3Mbps, 512k -> 512kbps
    return /^\d+[kKmMgG]$/.test(down) ? down + "bps" : down;
}

async function listOffers({ force = false } = {}) {
    const rows   = await getRawProfiles({ force });
    const offers = [];
    for (const r of rows) {
        const meta = parseProfileMeta(r.comment);
        if (!meta) continue;
        if (meta.hidden === true) continue;
        const price = Number(meta.price);
        if (!Number.isFinite(price) || price < 0) continue;

        offers.push({
            id:          String(meta.id || r.name),
            name:        String(meta.name || r.name),
            price,
            duration:    String(meta.duration || r["session-timeout"] || ""),
            speed:       String(meta.speed    || formatRate(r["rate-limit"]) || ""),
            profile:     r.name,
            description: String(meta.description || ""),
            order:       Number.isFinite(Number(meta.order)) ? Number(meta.order) : Number.MAX_SAFE_INTEGER
        });
    }
    offers.sort((a, b) => (a.order - b.order) || (a.price - b.price));
    return offers;
}

async function findOffer(id) {
    if (!id) return null;
    const offers = await listOffers();
    return offers.find(o => o.id === String(id)) || null;
}

/* ---------- low-level connectivity test (for diagnostics) ---------- */

async function tryConnect() {
    const host = process.env.MIKROTIK_HOST || "192.168.88.1";
    const port = parseInt(process.env.MIKROTIK_PORT || "8728", 10);
    const api = buildClient();
    try {
        await api.connect();
        return { ok: true, host, port };
    } catch (err) {
        return { ok: false, host, port, error: (err && err.message) || String(err) };
    } finally {
        try { api.close(); } catch (_) { /* ignore */ }
    }
}

/* ---------- user creation ---------- */

async function createHotspotUser({ username, password, profile, comment }) {
    const api = buildClient();
    try {
        await api.connect();
        const params = [
            "/ip/hotspot/user/add",
            "=name="     + username,
            "=password=" + password,
            "=profile="  + profile
        ];
        if (comment) params.push("=comment=" + comment);
        const result = await api.write(params);
        return { ok: true, result };
    } catch (err) {
        console.error("[mikrotik] createHotspotUser failed:", err && err.message);
        return { ok: false, error: err && err.message };
    } finally {
        try { api.close(); } catch (_) { /* ignore */ }
    }
}

module.exports = {
    generateUsername,
    generatePassword,
    getRawProfiles,
    getHotspotProfiles,
    profileExists,
    listOffers,
    findOffer,
    createHotspotUser,
    tryConnect
};
