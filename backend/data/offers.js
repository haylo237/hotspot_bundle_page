/**
 * data/offers.js
 * ---------------------------------------------------------------------------
 * Authoritative bundle catalog. Frontend NEVER sets prices — it only sends
 * the bundle_id; backend looks up the price here.
 *
 * Each offer.profile MUST match an existing MikroTik /ip hotspot user profile
 * name. The /api/hotspot/offers endpoint filters this list down to offers
 * whose profile actually exists on the router.
 * ---------------------------------------------------------------------------
 */

module.exports = [
    {
        id:          "1hour",
        name:        "1 Hour",
        price:       100,
        duration:    "1h",
        speed:       "3Mbps",
        profile:     "1hour",
        description: "Best for quick browsing"
    },
    {
        id:          "1day",
        name:        "1 Day",
        price:       500,
        duration:    "24h",
        speed:       "5Mbps",
        profile:     "1day",
        description: "Perfect for daily use"
    },
    {
        id:          "1week",
        name:        "1 Week",
        price:       2000,
        duration:    "7d",
        speed:       "10Mbps",
        profile:     "1week",
        description: "Good for regular users"
    },
    {
        id:          "1month",
        name:        "1 Month",
        price:       5000,
        duration:    "30d",
        speed:       "15Mbps",
        profile:     "1month",
        description: "Best value for monthly access"
    }
];
