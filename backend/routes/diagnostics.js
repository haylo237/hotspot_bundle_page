/**
 * routes/diagnostics.js
 * ---------------------------------------------------------------------------
 *  GET /api/diagnostics/mikrotik
 *    Reports whether the backend can reach the MikroTik API, the profiles
 *    found, which ones are saleable (have a valid JSON metadata comment),
 *    and which ones are unconfigured. Never exposes passwords or tokens.
 * ---------------------------------------------------------------------------
 */

const express  = require("express");
const router   = express.Router();
const mikrotik = require("../services/mikrotikService");

router.get("/mikrotik", async (_req, res) => {
    const host = process.env.MIKROTIK_HOST || "(unset)";
    const port = parseInt(process.env.MIKROTIK_PORT || "8728", 10);

    const conn = await mikrotik.tryConnect();
    if (!conn.ok) {
        return res.status(503).json({
            status:  "error",
            message: "Cannot reach MikroTik API.",
            mikrotik: { host, port, connected: false, error: conn.error },
            hints: [
                "Is the mini-server on the same LAN as the router?",
                "Is `/ip service` api enabled on the router?",
                "Are MIKROTIK_USER / MIKROTIK_PASSWORD correct?",
                "Is anything blocking TCP " + port + " on the router?"
            ]
        });
    }

    const rows   = await mikrotik.getRawProfiles({ force: true });
    const offers = await mikrotik.listOffers({ force: true });

    const profilesSummary = rows.map(r => {
        const offer = offers.find(o => o.profile === r.name) || null;
        return {
            name:             r.name,
            "rate-limit":     r["rate-limit"]    || "",
            "session-timeout": r["session-timeout"] || "",
            comment:          r.comment || "",
            saleable:         !!offer,
            parsed:           offer ? { id: offer.id, name: offer.name, price: offer.price } : null
        };
    });

    const unconfigured = profilesSummary
        .filter(p => !p.saleable)
        .map(p => p.name);

    res.json({
        status: offers.length > 0 ? "success" : "warning",
        message: offers.length > 0
            ? "MikroTik reachable. " + offers.length + " saleable bundle(s) loaded from profile comments."
            : "MikroTik reachable but no profile carries a valid JSON metadata comment.",
        mikrotik: { host, port, connected: true, api_login: "ok" },
        profiles_found:           rows.map(r => r.name),
        profiles_detail:          profilesSummary,
        saleable_offers:          offers.map(o => ({
            id: o.id, name: o.name, price: o.price,
            duration: o.duration, speed: o.speed, profile: o.profile
        })),
        unconfigured_profiles:    unconfigured,
        example_comment_to_set:   "{\"price\":100,\"name\":\"1 Hour\",\"description\":\"Best for quick browsing\"}"
    });
});

module.exports = router;
