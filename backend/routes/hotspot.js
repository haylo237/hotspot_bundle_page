/**
 * routes/hotspot.js
 * ---------------------------------------------------------------------------
 *  GET   /api/hotspot/offers              → offers whose MT profile exists
 *  POST  /api/hotspot/pay                 → start CamPay collection
 *  GET   /api/hotspot/payment-status/:ref → poll; create MT user on success
 *  GET   /api/hotspot/success?reference=  → optional redirect helper
 *
 * Transactions are kept in an in-memory Map. Replace `store` with a real DB
 * for production scale — surface is small.
 * ---------------------------------------------------------------------------
 */

const express = require("express");
const router  = express.Router();

const OFFERS   = require("../data/offers");
const campay   = require("../services/campayService");
const mikrotik = require("../services/mikrotikService");
const receipts = require("../services/receiptService");

/* -------------------------------------------------------------------------
 * In-memory transaction store. Schema:
 *   { reference, externalReference, phone, offerId, amount,
 *     status: "pending"|"success"|"failed", createdAt, completedAt,
 *     username, password, receipt, mac, ip, provisioned }
 * ------------------------------------------------------------------------- */
const store = new Map();

/* ---------- helpers ---------- */

function findOffer(id) {
    if (!id) return null;
    for (let i = 0; i < OFFERS.length; i++) {
        if (String(OFFERS[i].id) === String(id)) return OFFERS[i];
    }
    return null;
}

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
    // Hide internal fields like `profile` from clients.
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
 *   - Reads MikroTik profile list
 *   - Returns only OFFERS whose `profile` exists on the router
 *   - If MikroTik is unreachable, falls back to all OFFERS so the portal
 *     stays usable (set OFFERS_STRICT=true in .env to disable fallback)
 * ------------------------------------------------------------------------- */
router.get("/offers", async (_req, res) => {
    const profiles = await mikrotik.getHotspotProfiles();
    const strict   = String(process.env.OFFERS_STRICT || "").toLowerCase() === "true";
    const isDev    = String(process.env.NODE_ENV || "").toLowerCase() !== "production";

    const expected = OFFERS.map(o => o.profile);
    const matching = OFFERS.filter(o => profiles.indexOf(o.profile) !== -1);
    const missing  = expected.filter(p => profiles.indexOf(p) === -1);

    console.log("[offers] MikroTik profiles found:", profiles.length ? profiles.join(", ") : "(none)");
    if (missing.length) console.log("[offers] Profiles missing on router:", missing.join(", "));
    console.log("[offers] Matching offers returned to client:",
                matching.length ? matching.map(o => o.id).join(", ") : "(none)");

    // Router unreachable + not strict → fall back to full list so portal stays usable.
    if (profiles.length === 0 && !strict) {
        console.warn("[offers] No profiles fetched — returning full offers list as fallback.");
        return res.json({
            status: "success",
            offers: OFFERS.map(publicOffer),
            fallback: true
        });
    }

    // Router reachable but nothing matched → surface a useful debug payload
    // (full debug only in dev mode; production keeps it short).
    if (matching.length === 0) {
        const body = {
            status:  "error",
            message: "No matching MikroTik hotspot profiles found.",
            mikrotik_profiles_found: profiles,
            expected_profiles:       expected
        };
        if (isDev) {
            body.hint = "Edit backend/data/offers.js so each offer.profile exactly matches a profile on the router, or create the missing profiles on MikroTik.";
        }
        return res.status(200).json(body);
    }

    return res.json({
        status: "success",
        offers: matching.map(publicOffer)
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

    // ----- validation -----
    const offer = findOffer(bundle_id);
    if (!offer)                       return sendError(res, 400, "ER201", "Unknown bundle.");
    if (!validatePhoneServer(phone))  return sendError(res, 400, "ER101", "Invalid phone number. Use 237XXXXXXXXX.");

    // Ensure the offer's MikroTik profile still exists.
    const profileOk = await mikrotik.profileExists(offer.profile);
    if (!profileOk) {
        // If MT is unreachable (empty list) AND not strict, allow through;
        // otherwise reject so we don't sell something we can't provision.
        const profiles = await mikrotik.getHotspotProfiles();
        const strict   = String(process.env.OFFERS_STRICT || "").toLowerCase() === "true";
        if (!(profiles.length === 0 && !strict)) {
            return sendError(res, 503, "ER201", "This bundle is temporarily unavailable. Please pick another.");
        }
    }

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

    // ----- persist -----
    store.set(reference, {
        reference,
        externalReference: externalRef,
        phone,
        offerId:     offer.id,
        amount:      offer.price,
        status:      "pending",
        createdAt:   new Date().toISOString(),
        completedAt: null,
        username:    null,
        password:    null,
        receipt:     null,
        mac:         mac || null,
        ip:          ip  || null,
        links:       { link_login, link_login_only, link_orig },
        provisioned: false
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
 *
 * Polls CamPay; on first SUCCESSFUL response, provisions a MikroTik user
 * idempotently and returns full credentials + bundle details.
 * ------------------------------------------------------------------------- */
router.get("/payment-status/:reference", async (req, res) => {
    const reference = req.params.reference;
    const tx = store.get(reference);
    if (!tx) return sendError(res, 404, "ER201", "Unknown transaction reference.");

    if (tx.status === "success" && tx.provisioned) return res.json(buildSuccessPayload(tx));
    if (tx.status === "failed")                    return res.json({ status: "failed", reference, message: "Payment was not completed." });

    // Query CamPay
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
            const offer    = findOffer(tx.offerId);
            const username = mikrotik.generateUsername();
            const password = mikrotik.generatePassword();
            const comment  = "phone:" + tx.phone + " ref:" + tx.reference;

            const mt = await mikrotik.createHotspotUser({
                username, password,
                profile: offer.profile,
                comment
            });

            if (!mt.ok) {
                tx.status      = "success";
                tx.completedAt = new Date().toISOString();
                tx.username    = username;
                tx.password    = password;
                tx.receipt     = receipts.generateReceiptNumber();
                tx.provisioned = false;
                console.error("[status] MikroTik provisioning failed for ref", reference, mt.error);
                return res.status(500).json({
                    status:  "error",
                    code:    "ER999",
                    message: "Payment succeeded but account creation failed. Contact support with reference: " + reference,
                    reference
                });
            }

            tx.status      = "success";
            tx.completedAt = new Date().toISOString();
            tx.username    = username;
            tx.password    = password;
            tx.receipt     = receipts.generateReceiptNumber();
            tx.provisioned = true;
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
 * Optional helper — redirect to MikroTik login URL with credentials.
 * ------------------------------------------------------------------------- */
router.get("/success", (req, res) => {
    const reference = req.query.reference;
    const tx = reference && store.get(reference);
    if (!tx || tx.status !== "success" || !tx.username) {
        return res.status(404).send("Transaction not found or not yet successful.");
    }
    const hotspotUrl = process.env.HOTSPOT_LOGIN_URL || "http://10.5.50.1/login";
    const offer     = findOffer(tx.offerId) || {};
    const params = new URLSearchParams({
        paid:      "true",
        username:  tx.username,
        password:  tx.password,
        bundle:    offer.name      || "",
        amount:    String(tx.amount || ""),
        duration:  offer.duration  || "",
        speed:     offer.speed     || "",
        reference: tx.reference,
        receipt:   tx.receipt      || "",
        mac:       tx.mac || "",
        ip:        tx.ip  || ""
    });
    return res.redirect(hotspotUrl + "?" + params.toString());
});

/* ---------- helpers ---------- */

function buildSuccessPayload(tx) {
    const offer = findOffer(tx.offerId) || {};
    return {
        status:    "success",
        reference: tx.reference,
        receipt:   tx.receipt,
        username:  tx.username,
        password:  tx.password,
        bundle:    offer.name,
        amount:    tx.amount,
        duration:  offer.duration,
        speed:     offer.speed,
        mac:       tx.mac,
        ip:        tx.ip,
        date:      tx.completedAt
    };
}

module.exports = router;
