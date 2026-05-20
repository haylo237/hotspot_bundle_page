/**
 * services/mikrotikService.js
 * ---------------------------------------------------------------------------
 * Wraps the RouterOS API (via `node-routeros`) to provision hotspot users
 * after a successful CamPay payment.
 *
 * Requires the following profiles to already exist on the router:
 *   /ip hotspot user profile name=1hour  rate-limit=3M/3M  session-timeout=1h
 *   /ip hotspot user profile name=1day   rate-limit=5M/5M  session-timeout=1d
 *   /ip hotspot user profile name=1week  rate-limit=10M/10M session-timeout=7d
 *   /ip hotspot user profile name=1month rate-limit=15M/15M session-timeout=30d
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

/**
 * Generates a short, easy-to-type username (8 chars).
 *   e.g. "u4k9p2m1"
 */
function generateUsername() {
    const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // no confusing 0/o/1/l
    let s = "u";
    for (let i = 0; i < 7; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

/**
 * Generates a short, easy-to-type password (6 digits).
 *   e.g. "382174"
 */
function generatePassword() {
    let s = "";
    for (let i = 0; i < 6; i++) s += Math.floor(Math.random() * 10);
    return s;
}

/**
 * Create a hotspot user on the MikroTik.
 *
 * @param {object} args
 * @param {string} args.username
 * @param {string} args.password
 * @param {string} args.profile   Must match an existing /ip hotspot user profile
 * @param {string} [args.comment] Free text — phone, reference, etc.
 */
async function createHotspotUser({ username, password, profile, comment }) {
    const api = buildClient();
    try {
        await api.connect();
        const params = [
            "/ip/hotspot/user/add",
            "=name="    + username,
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
    createHotspotUser
};
