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

// Format bandwidth rate (e.g., 2000000 → "2 Mbps", 512000 → "512 Kbps")
function formatRate(rate) {
    if (!rate || isNaN(rate)) return "-";
    rate = Number(rate);
    if (rate >= 1e6) return (rate / 1e6).toFixed(rate % 1e6 === 0 ? 0 : 2) + " Mbps";
    if (rate >= 1e3) return (rate / 1e3).toFixed(rate % 1e3 === 0 ? 0 : 2) + " Kbps";
    return rate + " bps";
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
    formatRate,
    createHotspotUser,
    tryConnect
};
