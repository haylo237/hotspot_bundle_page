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

let _profileCache = null;       // { profiles: string[], at: number }
const PROFILE_TTL_MS = 60 * 1000;

async function getHotspotProfiles({ force = false } = {}) {
    if (!force && _profileCache && (Date.now() - _profileCache.at) < PROFILE_TTL_MS) {
        return _profileCache.profiles;
    }
    const api = buildClient();
    try {
        await api.connect();
        const rows = await api.write(["/ip/hotspot/user/profile/print"]);
        const profiles = (rows || [])
            .map(r => r && r.name)
            .filter(n => typeof n === "string" && n.length > 0);
        _profileCache = { profiles, at: Date.now() };
        return profiles;
    } catch (err) {
        console.error("[mikrotik] getHotspotProfiles failed:", err && err.message);
        return [];  // degrade gracefully — caller treats as "no profiles"
    } finally {
        try { api.close(); } catch (_) { /* ignore */ }
    }
}

async function profileExists(name) {
    if (!name) return false;
    const profiles = await getHotspotProfiles();
    return profiles.indexOf(name) !== -1;
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
    getHotspotProfiles,
    profileExists,
    createHotspotUser,
    tryConnect
};
