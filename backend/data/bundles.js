/**
 * data/bundles.js
 * ---------------------------------------------------------------------------
 * Authoritative bundle catalog. The frontend list is for display only;
 * the backend ALWAYS re-validates by bundle_id against this file.
 *
 * Keys here MUST match:
 *   - keys in login.html BUNDLES map (for nice UX)
 *   - MikroTik /ip/hotspot/user/profile names (so we can create users with
 *     the correct profile = bandwidth + session-timeout).
 * ---------------------------------------------------------------------------
 */

const BUNDLES = {
    "1hour": {
        id:       "1hour",
        name:     "1 Hour",
        price:    100,        // XAF — whole number
        duration: "1h",
        speed:    "3Mbps",
        profile:  "1hour"     // MikroTik user profile name
    },
    "1day": {
        id:       "1day",
        name:     "1 Day",
        price:    500,
        duration: "24h",
        speed:    "5Mbps",
        profile:  "1day"
    },
    "1week": {
        id:       "1week",
        name:     "1 Week",
        price:    2000,
        duration: "7d",
        speed:    "10Mbps",
        profile:  "1week"
    },
    "1month": {
        id:       "1month",
        name:     "1 Month",
        price:    5000,
        duration: "30d",
        speed:    "15Mbps",
        profile:  "1month"
    }
};

function getBundle(bundleId) {
    if (!bundleId || typeof bundleId !== "string") return null;
    return Object.prototype.hasOwnProperty.call(BUNDLES, bundleId) ? BUNDLES[bundleId] : null;
}

function listBundles() {
    return Object.values(BUNDLES);
}

module.exports = { BUNDLES, getBundle, listBundles };
