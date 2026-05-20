# HAYLO INTERNET — MikroTik Hotspot + CamPay Backend

A small Node.js/Express backend that turns a MikroTik captive portal into a
self-service WiFi shop:

1. Customer connects to your WiFi → MikroTik shows `login.html`.
2. Customer picks a bundle and enters their MTN MoMo / Orange Money number.
3. Backend calls **CamPay** to push a mobile money prompt to the phone.
4. Backend polls CamPay; on success it provisions a hotspot user on the
   **MikroTik** router via the RouterOS API and returns the credentials.
5. The portal auto-logs the user in (hidden form POSTed to `$(link-login-only)`).

```
┌───────────┐  HTTP   ┌────────────┐  RouterOS API   ┌───────────┐
│ login.html│────────▶│  backend   │────────────────▶│ MikroTik  │
│ (on RB)   │◀────────│ (Node.js)  │                 │ Hotspot   │
└───────────┘         └─────┬──────┘                 └───────────┘
                            │ HTTPS
                            ▼
                       ┌──────────┐
                       │  CamPay  │
                       └──────────┘
```

> **The CamPay token never touches the browser.** It lives only in the
> backend `.env`. The frontend talks exclusively to your backend.

---

## Project layout

```
backend/
├── server.js                  # Express entry point
├── package.json
├── .env.example               # Copy to .env and fill in
├── data/
│   └── bundles.js             # Authoritative bundle catalog (price + profile)
├── services/
│   ├── campayService.js       # CamPay REST wrapper
│   ├── mikrotikService.js     # RouterOS API wrapper
│   └── receiptService.js      # Receipt number generator
└── routes/
    └── hotspot.js             # /api/hotspot/* endpoints
```

The portal page (`login.html`) lives **one level up** and is uploaded to the
MikroTik (see "Upload the portal" below).

---

## 1. Install

Requires **Node.js 18+**.

```bash
cd backend
npm install
cp .env.example .env
# edit .env — see next section
```

## 2. Configure `.env`

| Variable             | Example                       | Notes                                                                 |
|----------------------|-------------------------------|-----------------------------------------------------------------------|
| `PORT`               | `3000`                        | HTTP port the backend listens on                                       |
| `BASE_URL`           | `https://api.haylo.example`   | Public URL where this backend is reachable                             |
| `CAMPAY_BASE_URL`    | `https://demo.campay.net`     | Use `https://www.campay.net` for production                            |
| `CAMPAY_TOKEN`       | *(secret)*                    | Permanent token from your CamPay dashboard                             |
| `CAMPAY_CURRENCY`    | `XAF`                         |                                                                       |
| `MIKROTIK_HOST`      | `192.168.88.1`                | Router LAN IP reachable from the backend                               |
| `MIKROTIK_USER`      | `hotspot-api`                 | Dedicated API user (see hardening below)                               |
| `MIKROTIK_PASSWORD`  | *(secret)*                    |                                                                       |
| `MIKROTIK_PORT`      | `8728`                        | `8729` for API-SSL                                                     |
| `HOTSPOT_LOGIN_URL`  | `http://10.5.50.1/login`      | The hotspot login URL (used by the optional redirect helper)           |
| `ISP_NAME`           | `NET-INFO`              | Used in CamPay description / receipts                                  |
| `SUPPORT_PHONE`      | `+237 6XX XXX XXX`            |                                                                       |
| `SUPPORT_EMAIL`      | `support@haylo.example`       |                                                                       |

> **Never commit `.env`.** Add it to `.gitignore`.

## 3. Run

```bash
npm start            # production
npm run dev          # auto-restart on file change (Node 18+)
```

Sanity check:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/api/hotspot/bundles
```

---

## 4. MikroTik setup

### 4.1 Create user profiles (bandwidth + session timeout)

Run on the router (CLI or Winbox terminal):

```routeros
/ip hotspot user profile
add name=1hour  rate-limit=3M/3M   session-timeout=1h  shared-users=1
add name=1day   rate-limit=5M/5M   session-timeout=1d  shared-users=1
add name=1week  rate-limit=10M/10M session-timeout=7d  shared-users=1
add name=1month rate-limit=15M/15M session-timeout=30d shared-users=1
```

Profile names **must match** the `profile` keys in `data/bundles.js`.

### 4.2 Create a dedicated API user (recommended)

```routeros
/user group add name=hotspot-api policy=api,read,write,!ssh,!telnet,!ftp,!winbox,!web,!sniff,!sensitive,!romon,!password,!policy,!test
/user add name=hotspot-api group=hotspot-api password="STRONG_PASSWORD_HERE"
```

Use these credentials for `MIKROTIK_USER` / `MIKROTIK_PASSWORD`.

### 4.3 Walled garden (let unpaid users reach the portal + CamPay)

```routeros
/ip hotspot walled-garden
add dst-host=api.haylo.example      comment="HAYLO backend"
add dst-host=demo.campay.net        comment="CamPay demo"
add dst-host=www.campay.net         comment="CamPay prod"
add dst-host=*.mtn.cm               comment="MTN MoMo confirm pages"
add dst-host=*.orange.cm            comment="Orange Money confirm pages"
```

> Walled-garden lets unauthenticated devices reach those hostnames before
> they have a hotspot session.

### 4.4 Upload the portal

Upload `login.html` to the router (Files menu in Winbox, or via FTP):

```
Files / hotspot / login.html
```

Make sure the file is referenced by your hotspot server profile
(`/ip hotspot profile`) — the default profile already serves files from
`hotspot/`.

Before uploading, edit the top of the `<script>` in `login.html`:

```js
var BACKEND_URL   = "https://api.haylo.example";   // ← your public backend
var ISP_NAME      = "HAYLO INTERNET";
var SUPPORT_PHONE = "+237 6XX XXX XXX";
var SUPPORT_EMAIL = "support@haylo.example";
```

---

## 5. API reference

### `POST /api/hotspot/pay`

Start a payment.

Request:
```json
{
  "bundle_id":       "1day",
  "phone":           "237670000000",
  "mac":             "AA:BB:CC:DD:EE:FF",
  "ip":              "10.5.50.42",
  "link_login":      "http://10.5.50.1/login",
  "link_login_only": "http://10.5.50.1/login",
  "link_orig":       "http://example.com/"
}
```

Responses:
```json
{ "status": "pending",  "reference": "abc123...", "message": "...", "ussd_code": "*126#", "operator": "MTN" }
{ "status": "redirect", "payment_url": "https://..." }
{ "status": "error",    "code": "ER101", "message": "Invalid phone number..." }
```

Error codes: `ER101` invalid phone · `ER102` unsupported carrier ·
`ER201` invalid amount/bundle · `ER301` insufficient balance.

### `GET /api/hotspot/payment-status/:reference`

Frontend polls this every ~4s. Possible responses:

```json
{ "status": "pending",  "reference": "abc123..." }
{ "status": "failed",   "reference": "abc123...", "message": "Payment was not completed." }
{
  "status":    "success",
  "reference": "abc123...",
  "receipt":   "RCPT-20251104-7F3A2C",
  "username":  "u4k9p2m1",
  "password":  "382174",
  "bundle":    "1 Day",
  "amount":    500,
  "duration":  "24h",
  "speed":     "5Mbps",
  "mac":       "AA:BB:CC:DD:EE:FF",
  "ip":        "10.5.50.42",
  "date":      "2025-11-04T12:34:56.000Z"
}
```

### `GET /api/hotspot/success?reference=...`

Optional helper. Redirects to `HOTSPOT_LOGIN_URL` with credentials in the
query string so the portal can auto-fill the success view.

### `GET /api/hotspot/bundles`

Returns the public bundle catalog (for tools/diagnostics).

---

## 6. End-to-end test

1. Start the backend (`npm start`).
2. Open `login.html` directly in a browser (set `BACKEND_URL` to
   `http://localhost:3000`).
3. Pick a bundle, enter a **CamPay demo number** (see CamPay docs), confirm.
4. Watch the backend logs:
   - `POST /api/hotspot/pay` → CamPay collect
   - repeated `GET /api/hotspot/payment-status/...`
   - on success: MikroTik `createHotspotUser` call.
5. The portal shows the credentials and the "Connect Now" button submits the
   hidden MikroTik login form.

---

## 7. Switch demo → production

1. In CamPay dashboard, request a production token.
2. Update `.env`:
   ```env
   CAMPAY_BASE_URL=https://www.campay.net
   CAMPAY_TOKEN=<production token>
   ```
3. Restart the backend.

That's it — no code changes needed.

---

## 8. Troubleshooting

| Symptom | Likely cause |
|--------|--------------|
| `Could not reach the payment server` (toast) | `BACKEND_URL` in `login.html` is wrong / backend not running / not in walled garden |
| `ER101 Invalid phone number` | Phone not in `237XXXXXXXXX` form |
| `ER102 Unsupported carrier` | CamPay `holder_info` returned a non-MTN/Orange carrier |
| `ER301 Insufficient balance` | The customer's MoMo wallet doesn't have enough |
| Polling times out (180s) | Customer never confirmed USSD prompt — they can retry |
| `MikroTik provisioning failed` | API user wrong, port blocked, or profile name doesn't exist |
| `connection refused` to RouterOS | API service disabled — `/ip service enable api` |

Enable RouterOS API:
```routeros
/ip service set api disabled=no port=8728
/ip service set api-ssl disabled=no port=8729   # for TLS
```

---

## 9. Security checklist

- [ ] `.env` is in `.gitignore` and **never** committed.
- [ ] CamPay token is in `.env` only — not in `login.html`.
- [ ] Backend served over **HTTPS** (Let's Encrypt + nginx/Caddy).
- [ ] Dedicated RouterOS user with restricted policy.
- [ ] Walled garden allows only your backend + CamPay hostnames.
- [ ] Server-side re-validates `bundle_id`, `phone`, and amount.
- [ ] Move the in-memory `store` Map to a real DB before production scale.

---

## 10. Reminder

When you are done making changes, commit them:

```bash
git add .
git commit -m "Add MikroTik + CamPay backend and updated portal"
```
