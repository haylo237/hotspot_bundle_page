/**
 * services/campayService.js
 * ---------------------------------------------------------------------------
 * Thin axios wrapper around the CamPay REST API.
 *   - getHolderInfo(phone)        GET  /api/holder_info/?phone_number=...
 *   - createCollect(args)         POST /api/collect/
 *   - getTransactionStatus(ref)   GET  /api/utilities/transaction/{ref}/
 *
 * The token is read from process.env.CAMPAY_TOKEN and sent as
 *   Authorization: Token <CAMPAY_TOKEN>
 *
 * Docs: https://documenter.getpostman.com/view/2434815/T1LV8PVA
 * ---------------------------------------------------------------------------
 */

const axios = require("axios");

function getClient() {
    const baseURL = process.env.CAMPAY_BASE_URL || "https://demo.campay.net";
    const token   = process.env.CAMPAY_TOKEN || "";
    if (!token) {
        // We don't throw at module load — only at use time — so dev still boots.
        console.warn("[campay] CAMPAY_TOKEN is not set. Calls will fail.");
    }
    return axios.create({
        baseURL,
        timeout: 20000,
        headers: {
            "Authorization": "Token " + token,
            "Content-Type":  "application/json",
            "Accept":        "application/json"
        }
    });
}

/**
 * Look up the SIM owner / carrier. Useful to reject foreign / wrong-carrier
 * numbers BEFORE prompting CamPay collect. Returns null if lookup fails.
 *
 * @param {string} phone  E.164-style digits, e.g. "237670000000"
 */
async function getHolderInfo(phone) {
    try {
        const res = await getClient().get("/api/holder_info/", {
            params: { phone_number: phone }
        });
        return res.data || null;
    } catch (err) {
        const status = err.response && err.response.status;
        console.warn("[campay] holder_info failed:", status, err.response && err.response.data);
        return null;
    }
}

/**
 * Initiate a Mobile Money collection (USSD push to the customer's phone).
 *
 * @param {object} args
 * @param {number|string} args.amount       Whole XAF amount, e.g. 500
 * @param {string} args.from                Phone in E.164 digits, e.g. "237670000000"
 * @param {string} args.description         Short description shown to user
 * @param {string} args.externalReference   Our internal reference (idempotency key)
 * @param {string} [args.currency]          Defaults to env CAMPAY_CURRENCY or "XAF"
 *
 * Resolves with the raw CamPay response:
 *   { reference, ussd_code, operator, status }
 */
async function createCollect({ amount, from, description, externalReference, currency }) {
    const body = {
        amount:             String(amount),
        currency:           currency || process.env.CAMPAY_CURRENCY || "XAF",
        from:               String(from),
        description:        description || "Internet bundle purchase",
        external_reference: externalReference
    };
    const res = await getClient().post("/api/collect/", body);
    return res.data;
}

/**
 * Poll transaction status by CamPay reference.
 *
 * @param {string} reference  CamPay-issued reference (uuid-like)
 * @returns {Promise<object>} { reference, status: "SUCCESSFUL"|"PENDING"|"FAILED"|..., ... }
 */
async function getTransactionStatus(reference) {
    const res = await getClient().get("/api/utilities/transaction/" + encodeURIComponent(reference) + "/");
    return res.data;
}

module.exports = {
    getHolderInfo,
    createCollect,
    getTransactionStatus
};
