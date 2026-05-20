/**
 * routes/diagnostics.js
 * ---------------------------------------------------------------------------
 *  GET /api/diagnostics/mikrotik
 *    Returns whether the backend can reach the MikroTik API, the list of
 *    hotspot user profiles found, which offers match, and which profiles
 *    are missing. Never exposes passwords or tokens.
 * ---------------------------------------------------------------------------
 */

const express  = require("express");
const router   = express.Router();
const OFFERS   = require("../data/offers");
const mikrotik = require("../services/mikrotikService");

router.get("/mikrotik", async (_req, res) => {
    const host = process.env.MIKROTIK_HOST || "(unset)";
    const port = parseInt(process.env.MIKROTIK_PORT || "8728", 10);

    const conn = await mikrotik.tryConnect();
    if (!conn.ok) {
        return res.status(503).json({
            status:  "error",
            message: "Cannot reach MikroTik API.",
            mikrotik: {
                host, port,
                connected: false,
                error: conn.error
            },
            hints: [
                "Is the mini-server on the same LAN as the router?",
                "Is /ip service api enabled on the router?",
                "Is MIKROTIK_USER / MIKROTIK_PASSWORD correct?",
                "Is there a firewall blocking TCP " + port + " on the router?"
            ]
        });
    }

    // Force-refresh profile cache so diagnostics always reflects current state.
    const profiles = await mikrotik.getHotspotProfiles({ force: true });
    const expected = OFFERS.map(o => o.profile);
    const matching = OFFERS
        .filter(o => profiles.indexOf(o.profile) !== -1)
        .map(o => ({ id: o.id, profile: o.profile, price: o.price }));
    const missingFromRouter = expected.filter(p => profiles.indexOf(p) === -1);
    const extraOnRouter     = profiles.filter(p => expected.indexOf(p) === -1);

    res.json({
        status: matching.length > 0 ? "success" : "warning",
        message: matching.length > 0
            ? "MikroTik reachable and " + matching.length + " offer(s) match router profiles."
            : "MikroTik reachable but NO offer profiles match. Check data/offers.js vs router profiles.",
        mikrotik: {
            host, port,
            connected: true,
            api_login: "ok"
        },
        offers_file:             OFFERS.map(o => ({ id: o.id, profile: o.profile })),
        mikrotik_profiles_found: profiles,
        expected_profiles:       expected,
        matching_offers:         matching,
        missing_profiles:        missingFromRouter,
        extra_router_profiles:   extraOnRouter
    });
});

module.exports = router;
