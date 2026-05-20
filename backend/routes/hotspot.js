/**
 * routes/hotspot.js
 * ---------------------------------------------------------------------------
 *  GET   /api/hotspot/offers              → offers built from MikroTik profiles
 *  POST  /api/hotspot/pay                 → start CamPay collection
 *  GET   /api/hotspot/payment-status/:ref → poll; create MT user on success
 *  GET   /api/hotspot/success?reference=  → optional redirect helper
 *
 * Offers come from MikroTik hotspot user-profiles. Each profile that should
 * be sold must carry a JSON blob in its `comment` field — see
 * services/mikrotikService.js (listOffers) for the schema.
 *
 * Transactions are kept in an in-memory Map. Replace `store` with a real DB
 * for production scale — the surface is small.
 * ---------------------------------------------------------------------------
 */

const express = require("express");
const router  = express.Router();

const campay   = require("../services/campayService");
const mikrotik = require("../services/mikrotikService");
const receipts = require("../services/receiptService");
const offerService = require("../services/offerService");

/* In-memory transaction store. The full offer snapshot is saved into the
 * tx record at /pay time so /payment-status remains stable even if the
 * profile's comment changes between purchase and provisioning. */
const store = new Map();

/* ---------- helpers ---------- */

function validatePhoneServer(phone) {
    if (typeof phone !== "string") return false;
    if (!/^\d{12}$/.test(phone))   return false;
    if (!phone.startsWith("237"))  return false;
    return /^6\d{8}$/.test(phone.slice(3));
}

function sendError(res, httpStatus, code, message) {
    return res.status(httpStatus).json({ status: "error", code, message });
}

function publicOffer(o) {
    // Hide internal fields like `profile` and `order` from clients.
    return {
        id:          o.id,
        name:        o.name,
        price:       o.price,
        duration:    o.duration,
        speed:       o.speed,
        description: o.description
    };
}

/* -------------------------------------------------------------------------
 * GET /api/hotspot/offers
 *   Reads MikroTik hotspot user-profiles, parses the JSON metadata in each
 *   profile's `comment` field, and returns the resulting bundles. Profiles
 *   without a valid JSON comment (or marked hidden) are not exposed.
 * ------------------------------------------------------------------------- */
router.get("/offers", async (_req, res) => {
    const isDev    = String(process.env.NODE_ENV || "").toLowerCase() !== "production";
    const profiles = await mikrotik.getHotspotProfiles();
    const offers   = offerService.getActiveOffers().filter(o => profiles.includes(o.profile));

    console.log("[offers] MikroTik profiles found:",
                profiles.length ? profiles.join(", ") : "(none)");
    console.log("[offers] Saleable offers returned:",
                offers.length ? offers.map(o => o.id + "(" + o.price + ")").join(", ") : "(none)");

    if (profiles.length === 0) {
        const body = {
            status:  "error",
            message: "Cannot reach MikroTik or no hotspot user-profiles found."
        };
        if (isDev) body.hint = "Check MIKROTIK_HOST/USER/PASSWORD and that /ip service api is enabled. Run GET /api/diagnostics/mikrotik for details.";
        return res.status(503).json(body);
    }

    if (offers.length === 0) {
        const body = {
            status:  "error",
            message: "No active offers mapped to MikroTik profiles.",
            mikrotik_profiles_found: profiles
        };
        if (isDev) body.hint = "Add offers in the admin UI and ensure their 'profile' matches a MikroTik profile name.";
        return res.status(200).json(body);
    }

    return res.json({
        status: "success",
        offers: offers.map(publicOffer)
    });
});

/* -------------------------------------------------------------------------
 * POST /api/hotspot/pay
 *  body: { bundle_id, phone, mac?, ip?, link_login?, link_login_only?, link_orig? }
 * ------------------------------------------------------------------------- */
router.post("/pay", async (req, res) => {
    const {
        bundle_id, phone,
        mac, ip,
        link_login, link_login_only, link_orig
    } = req.body || {};

    const profiles = await mikrotik.getHotspotProfiles();
    const offer = offerService.getActiveOffers().find(o => o.id === bundle_id && profiles.includes(o.profile));
    if (!offer)                       return sendError(res, 400, "ER201", "Unknown bundle.");
    if (!validatePhoneServer(phone))  return sendError(res, 400, "ER101", "Invalid phone number. Use 237XXXXXXXXX.");

    // ----- optional carrier check -----
    try {
        const info = await campay.getHolderInfo(phone);
        if (info && info.operator) {
            const op = String(info.operator).toLowerCase();
            if (op.indexOf("mtn") === -1 && op.indexOf("orange") === -1) {
                return sendError(res, 400, "ER102", "Unsupported carrier. Only MTN and Orange Cameroon are supported.");
            }
        }
    } catch (_) { /* non-fatal */ }

    // ----- create our reference & call CamPay -----
    const externalRef = "HOTSPOT-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8).toUpperCase();

    let campayRes;
    try {
        campayRes = await campay.createCollect({
            amount:            offer.price,
            from:              phone,
            description:       (process.env.ISP_NAME || "HAYLO INTERNET") + " — " + offer.name + " bundle",
            externalReference: externalRef
        });
    } catch (err) {
        const data = (err.response && err.response.data) || {};
        console.error("[pay] campay collect failed:", err.response && err.response.status, data);
        if (data && /balance/i.test(JSON.stringify(data))) {
            return sendError(res, 402, "ER301", "Insufficient balance on your mobile money account.");
        }
        return sendError(res, 502, "ER201", data.message || "Could not start payment. Please try again.");
    }

    const reference = campayRes && campayRes.reference;
    if (!reference) return sendError(res, 502, "ER201", "Payment provider did not return a reference.");

    store.set(reference, {
        reference,
        externalReference: externalRef,
        phone,
        offer:        offer,            // snapshot, so /status survives profile edits
        amount:       offer.price,
        status:       "pending",
        createdAt:    new Date().toISOString(),
        completedAt:  null,
        username:     null,
        password:     null,
        receipt:      null,
        mac:          mac || null,
        ip:           ip  || null,
        links:        { link_login, link_login_only, link_orig },
        provisioned:  false
    });

    return res.json({
        status:    "pending",
        reference,
        message:   "Payment request sent. Please confirm on your phone.",
        ussd_code: campayRes.ussd_code || null,
        operator:  campayRes.operator  || null
    });
});

/* -------------------------------------------------------------------------
 * GET /api/hotspot/payment-status/:reference
 * ------------------------------------------------------------------------- */
router.get("/payment-status/:reference", async (req, res) => {
    const reference = req.params.reference;
    const tx = store.get(reference);
    if (!tx) return sendError(res, 404, "ER201", "Unknown transaction reference.");

    if (tx.status === "success" && tx.provisioned) return res.json(buildSuccessPayload(tx));
    if (tx.status === "failed")                    return res.json({ status: "failed", reference, message: "Payment was not completed." });

    let statusRaw;
    try {
        const data = await campay.getTransactionStatus(reference);
        statusRaw = (data && data.status) || "PENDING";
    } catch (err) {
        console.warn("[status] campay status failed:", err.response && err.response.status);
        return res.json({ status: "pending", reference });
    }

    const norm = String(statusRaw).toUpperCase();

    if (norm === "SUCCESSFUL") {
        if (!tx.provisioned) {
            const username = mikrotik.generateUsername();
            const password = mikrotik.generatePassword();
            const comment  = "phone:" + tx.phone + " ref:" + tx.reference;

            const mt = await mikrotik.createHotspotUser({
                username, password,
                profile: tx.offer.profile,
                comment
            });

            tx.status      = "success";
            tx.completedAt = new Date().toISOString();
            tx.username    = username;
            tx.password    = password;
            tx.receipt     = receipts.generateReceiptNumber();
            tx.provisioned = !!mt.ok;

            if (!mt.ok) {
                console.error("[status] MikroTik provisioning failed for ref", reference, mt.error);
                return res.status(500).json({
                    status:  "error",
                    code:    "ER999",
                    message: "Payment succeeded but account creation failed. Contact support with reference: " + reference,
                    reference
                });
            }
        }
        return res.json(buildSuccessPayload(tx));
    }

    if (norm === "FAILED" || norm === "CANCELLED") {
        tx.status      = "failed";
        tx.completedAt = new Date().toISOString();
        return res.json({ status: "failed", reference, message: "Payment was not completed." });
    }

    return res.json({ status: "pending", reference });
});

/* -------------------------------------------------------------------------
 * GET /api/hotspot/success?reference=...
 * ------------------------------------------------------------------------- */
router.get("/success", (req, res) => {
    const reference = req.query.reference;
    const tx = reference && store.get(reference);
    if (!tx || tx.status !== "success" || !tx.username) {
        return res.status(404).send("Transaction not found or not yet successful.");
    }
    const hotspotUrl = process.env.HOTSPOT_LOGIN_URL || "http://10.5.50.1/login";
    const o = tx.offer || {};
    const params = new URLSearchParams({
        paid:      "true",
        username:  tx.username,
        password:  tx.password,
        bundle:    o.name      || "",
        amount:    String(tx.amount || ""),
        duration:  o.duration  || "",
        speed:     o.speed     || "",
        reference: tx.reference,
        receipt:   tx.receipt  || "",
        mac:       tx.mac || "",
        ip:        tx.ip  || ""
    });
    return res.redirect(hotspotUrl + "?" + params.toString());
});

/* ---------- helpers ---------- */

function buildSuccessPayload(tx) {
    const o = tx.offer || {};
    return {
        status:    "success",
        reference: tx.reference,
        receipt:   tx.receipt,
        username:  tx.username,
        password:  tx.password,
        bundle:    o.name,
        amount:    tx.amount,
        duration:  o.duration,
        speed:     o.speed,
        mac:       tx.mac,
        ip:        tx.ip,
        date:      tx.completedAt
    };
}

module.exports = router;
