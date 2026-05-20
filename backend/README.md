# HAYLO INTERNET — MikroTik Hotspot + CamPay Backend

A small Node.js/Express backend that turns a MikroTik captive portal into a
self-service WiFi shop. **It runs on a mini-server inside the same LAN as
the MikroTik router** — it only needs the public internet to reach CamPay.

```
Client (10.5.50.x)
   │  HTTP
   ▼
MikroTik Hotspot (10.5.50.1) — serves login.html
   │  HTTP (walled-garden)
   ▼
Mini-server (10.5.50.2:3000) — this backend
   ├──► MikroTik RouterOS API  (LAN, 10.5.50.1:8728)
   └──► CamPay REST API        (internet, HTTPS)
```

1. Customer connects to your WiFi → MikroTik serves `login.html`.
2. The portal asks the backend `GET /api/hotspot/offers` for the live bundle
   list (filtered against actual MikroTik hotspot profiles).
3. Customer picks a bundle, enters their MTN MoMo / Orange Money number.
4. Backend calls **CamPay** to push a mobile money prompt to the phone.
5. Backend polls CamPay; on success it provisions a hotspot user on the
   **MikroTik** router via the RouterOS API and returns the credentials.
6. The portal auto-logs the user in (hidden form POSTed to `$(link-login-only)`).

> **The CamPay token never touches the browser.** It lives only in the
> backend `.env`. The frontend talks exclusively to your backend.

---

## Project layout

```
hotspot_bundle_page/
├── login.html                 # ← uploaded to the MikroTik (Files/hotspot/)
└── backend/
    ├── server.js              # Express entry point
    ├── package.json
    ├── .env.example           # Copy to .env and fill in
    ├── data/
    │   └── offers.js          # Authoritative bundle catalog (price + profile)
    ├── services/
    │   ├── campayService.js   # CamPay REST wrapper
    │   ├── mikrotikService.js # RouterOS API wrapper
    │   └── receiptService.js  # Receipt number generator
    └── routes/
        ├── hotspot.js         # /api/hotspot/* endpoints
        └── diagnostics.js     # /api/diagnostics/* endpoints
```

---

## 1. Install

Requires **Node.js 18+**.

```bash
cd backend
npm install
cp .env.example .env
# then edit .env — see next section
```

## 2. Configure `.env`

| Variable             | Example                       | Notes                                                                 |
|----------------------|-------------------------------|-----------------------------------------------------------------------|
| `PORT`               | `3000`                        | HTTP port the backend listens on. Always binds to `0.0.0.0`.           |
| `BASE_URL`           | `http://10.5.50.2:3000`       | LAN URL where this backend is reachable from the hotspot              |
| `CORS_EXTRA_ORIGINS` | *(empty)*                     | Comma-separated extra origins to allow (defaults already cover MT)     |
| `CAMPAY_BASE_URL`    | `https://demo.campay.net`     | Use `https://www.campay.net` for production                            |
| `CAMPAY_TOKEN`       | *(secret)*                    | Permanent token from your CamPay dashboard                             |
| `CAMPAY_CURRENCY`    | `XAF`                         |                                                                       |
| `MIKROTIK_HOST`      | `10.5.50.1`                   | Router LAN IP — backend reaches it over the LAN, never the internet   |
| `MIKROTIK_USER`      | `hotspot-api`                 | Dedicated API user (see hardening below)                               |
| `MIKROTIK_PASSWORD`  | *(secret)*                    |                                                                       |
| `MIKROTIK_PORT`      | `8728`                        | `8729` for API-SSL                                                     |
| `HOTSPOT_LOGIN_URL`  | `http://10.5.50.1/login`      | The hotspot login URL (used by the optional redirect helper)           |
| `OFFERS_STRICT`      | `false`                       | If `true`, `/offers` returns nothing when the router is unreachable    |
| `NODE_ENV`           | `development`                 | When not `production`, `/offers` includes a debug hint on no-match     |
| `ISP_NAME`           | `HAYLO INTERNET`              | Used in CamPay description / receipts                                  |
| `SUPPORT_PHONE`      | `+237 6XX XXX XXX`            |                                                                       |
| `SUPPORT_EMAIL`      | `support@haylo.example`       |                                                                       |

> **Never commit `.env`.** It's already in `.gitignore`.

## 3. Run

```bash
npm start            # production
npm run dev          # auto-restart on file change (Node 18+)
```

On startup the backend prints:
- listening address (`http://0.0.0.0:<PORT>`)
- `BASE_URL`, CamPay base, MikroTik host:port, allowed CORS origins
- loaded offers (id, profile, price)
- result of an initial MikroTik connection test (profiles found, matching offers, missing profiles)

Sanity check:

```bash
curl http://10.5.50.2:3000/health
curl http://10.5.50.2:3000/api/hotspot/offers
curl http://10.5.50.2:3000/api/diagnostics/mikrotik
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

Profile names **must match** the `profile` keys in `data/offers.js`. The
`/api/hotspot/offers` endpoint compares this list with the offers file and
returns only offers whose profile actually exists on the router.

### 4.2 Create a dedicated API user (recommended)

```routeros
/user group add name=hotspot-api policy=api,read,write,!ssh,!telnet,!ftp,!winbox,!web,!sniff,!sensitive,!romon,!password,!policy,!test
/user add name=hotspot-api group=hotspot-api password="STRONG_PASSWORD_HERE"
```

Use these credentials for `MIKROTIK_USER` / `MIKROTIK_PASSWORD`.

Enable RouterOS API:

```routeros
/ip service set api disabled=no port=8728
/ip service set api-ssl disabled=no port=8729   # for TLS
```

### 4.3 Walled garden (let unpaid users reach the mini-server + CamPay)

The hotspot blocks all traffic from unauthenticated clients except the IPs
and hosts you whitelist here. Clients need to reach **the local backend** and
the **CamPay** servers before they have paid:

```routeros
# Local backend on the mini-server (LAN, by IP+port)
/ip hotspot walled-garden ip
add dst-address=10.5.50.2 protocol=tcp dst-port=3000 comment="Allow local backend"

# CamPay (internet, by hostname)
/ip hotspot walled-garden
add dst-host=demo.campay.net   comment="CamPay demo"
add dst-host=campay.net        comment="CamPay"
add dst-host=*.campay.net      comment="CamPay subdomains"
add dst-host=*.mtn.cm          comment="MTN MoMo confirm pages"
add dst-host=*.orange.cm       comment="Orange Money confirm pages"
```

If your captive portal uses DNS-based redirects, also allow DNS:

```routeros
/ip hotspot walled-garden ip
add dst-port=53 protocol=udp comment="DNS"
add dst-port=53 protocol=tcp comment="DNS"
```

### 4.4 Upload the portal

Upload `login.html` to the router (Files menu in Winbox, or via FTP) under
`hotspot/login.html`. The default hotspot server profile already serves
files from that folder.

Before uploading, edit the top of the `<script>` block in `login.html`:

```js
var BACKEND_BASE_URL = "http://10.5.50.2:3000";   // ← local mini-server on the LAN
var ISP_NAME         = "HAYLO INTERNET";
var SUPPORT_PHONE    = "+237 6XX XXX XXX";
var SUPPORT_EMAIL    = "support@haylo.example";
```

---

## 5. Frontend UI (`login.html`)

The portal shows a single card with **two tabs**:

| Tab                | Default | Contents                                           |
|--------------------|---------|----------------------------------------------------|
| **Select a Bundle** | ✅      | Dynamically-loaded offer cards + phone + Pay Now   |
| **Login**           |         | Manual MikroTik login form (`$(link-login-only)`)  |

On load:

- If `?paid=true&username=&password=…` is present → skip directly to the
  payment-success view.
- Otherwise → show the portal card with the **Select a Bundle** tab active
  and fetch `GET {BACKEND_BASE_URL}/api/hotspot/offers`.

The success view shows: bundle, amount, duration, speed, username, password,
transaction reference, receipt number, client IP, MAC and date — with buttons
to **Connect Now**, **Download Receipt**, **Connection Info**, and
**Back to Bundles**.

---

## 6. API reference

### `GET /api/hotspot/offers`

Returns the live offer list (filtered against MikroTik profiles).

```json
{
  "status": "success",
  "offers": [
    { "id": "1day", "name": "1 Day", "price": 500,
      "duration": "24h", "speed": "5Mbps",
      "description": "Perfect for daily use" }
  ]
}
```

Internal fields like `profile` are **not** exposed to clients.

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

Possible responses:
```json
{ "status": "pending",  "reference": "abc123...", "message": "Payment request sent. Please confirm on your phone.", "ussd_code": "*126#", "operator": "MTN" }
{ "status": "redirect", "payment_url": "https://..." }
{ "status": "error",    "code": "ER101", "message": "Invalid phone number..." }
```

Error codes: `ER101` invalid phone · `ER102` unsupported carrier ·
`ER201` invalid amount / bundle · `ER301` insufficient balance ·
`ER999` payment OK but provisioning failed.

The backend uses `bundle_id` to look up the price from `data/offers.js` —
**the price sent from the frontend is ignored**.

### `GET /api/hotspot/payment-status/:reference`

Frontend polls this every ~4 s. Possible responses:

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

Optional. Redirects to `HOTSPOT_LOGIN_URL` with credentials in the query
string so the portal can show the success view directly.

### `GET /api/diagnostics/mikrotik`

Returns whether the backend can reach the MikroTik API, the list of
profiles found, which offers match, and which profiles are missing. Use
this from the mini-server itself or from a client browser when offers do
not appear in the portal.

```json
{
  "status": "success",
  "message": "MikroTik reachable and 4 offer(s) match router profiles.",
  "mikrotik": { "host": "10.5.50.1", "port": 8728, "connected": true, "api_login": "ok" },
  "offers_file":             [{ "id": "1hour", "profile": "1hour" }],
  "mikrotik_profiles_found": ["default", "1hour", "1day", "1week", "1month"],
  "expected_profiles":       ["1hour", "1day", "1week", "1month"],
  "matching_offers":         [{ "id": "1hour", "profile": "1hour", "price": 100 }],
  "missing_profiles":        [],
  "extra_router_profiles":   ["default"]
}
```

If the router is unreachable, it returns `503` with the connection error
and a list of hints. Passwords and tokens are **never** included.

---

## 7. End-to-end test (demo)

1. `cd backend && npm install && cp .env.example .env`
2. Set `CAMPAY_TOKEN` (demo token from CamPay dashboard).
3. Set `MIKROTIK_*` to a reachable router (or leave it — `/offers` falls
   back to the full list when the router is unreachable and `OFFERS_STRICT`
   is not `true`).
4. `npm start`
5. Open `login.html` in a browser with `BACKEND_BASE_URL` pointing at your
   local backend (e.g. `http://10.5.50.2:3000`).
6. Pick a bundle → enter a CamPay demo number → confirm.
7. Watch backend logs:
   - `POST /api/hotspot/pay` → CamPay collect
   - repeated `GET /api/hotspot/payment-status/...`
   - on success: MikroTik `createHotspotUser` call.

---

## 8. Local mini-server deployment (recommended)

Run the backend on a small machine (Raspberry Pi, mini-PC, NUC) plugged into
the same LAN as the MikroTik. The backend uses the LAN to reach the router
and the internet (through the router) to reach CamPay. **Nothing has to be
exposed to the public internet.**

1. **Give the mini-server a static IP** (e.g. `10.5.50.2`) on the hotspot LAN.
2. **Set the backend URL in `login.html`:**
   ```js
   var BACKEND_BASE_URL = "http://10.5.50.2:3000";
   ```
3. **Set the MikroTik host in `.env`:**
   ```env
   MIKROTIK_HOST=10.5.50.1
   MIKROTIK_PORT=8728
   MIKROTIK_USER=hotspot-api
   MIKROTIK_PASSWORD=StrongPassword123
   ```
4. **Enable the MikroTik API:**
   ```routeros
   /ip service enable api
   /ip service set api port=8728
   ```
5. **Create a dedicated API user on the MikroTik:**
   ```routeros
   /user group add name=hotspot-api-group policy=read,write,api
   /user add name=hotspot-api password=StrongPassword123 group=hotspot-api-group
   ```
6. **Add walled-garden rules** so unauthenticated clients can reach the
   backend and CamPay (see §4.3 above).
7. **Allow port 3000 on the mini-server's firewall** so clients on
   `10.5.50.0/24` can reach it (e.g. `sudo ufw allow from 10.5.50.0/24 to any port 3000`).
8. **Start the backend** (`npm start`). It binds to `0.0.0.0:3000`.
9. **Test from a client browser** before relying on the captive portal:
   - `http://10.5.50.2:3000/health` → should return `{ "ok": true, … }`
   - `http://10.5.50.2:3000/api/hotspot/offers` → should list your bundles
   - `http://10.5.50.2:3000/api/diagnostics/mikrotik` → should report `connected: true`

### Switch demo → production CamPay

1. Get a production token from CamPay.
2. Update `.env`:
   ```env
   CAMPAY_BASE_URL=https://www.campay.net
   CAMPAY_TOKEN=<production token>
   ```
3. Restart the backend. No code changes.

---

## 9. Troubleshooting

First, run the diagnostic endpoint:

```bash
curl http://10.5.50.2:3000/api/diagnostics/mikrotik | jq
```

| Symptom | Likely cause |
|--------|--------------|
| Portal stuck on skeleton bundles                | `BACKEND_BASE_URL` wrong in `login.html`, backend not running, or walled-garden missing the `10.5.50.2 tcp 3000` rule |
| `Could not reach the server`                    | Mini-server firewall blocks port 3000, or backend not bound to `0.0.0.0` |
| `No matching MikroTik hotspot profiles found`   | Profile names in `data/offers.js` don't match what's on the router. Check the `mikrotik_profiles_found` field in the response |
| Diagnostics: `Cannot reach MikroTik API`        | `MIKROTIK_HOST` wrong, API service disabled (`/ip service`), or wrong credentials |
| `ER101 Invalid phone number`                    | Phone not in `237XXXXXXXXX` form |
| `ER102 Unsupported carrier`                     | CamPay `holder_info` returned a non-MTN/Orange carrier |
| `ER301 Insufficient balance`                    | Customer's MoMo wallet doesn't have enough |
| `ER999` after a successful pay                  | Payment OK but RouterOS user creation failed — check `MIKROTIK_*` creds and API service |
| Polling times out (180s)                        | Customer never confirmed the USSD prompt |
| `EADDRINUSE: ::3000`                            | Port busy. Change `PORT` in `.env` (e.g. `5050`) |

### If offers don't show, check in order:
1. Backend server is running (`curl http://10.5.50.2:3000/health`)
2. Backend binds to `0.0.0.0` (look for `listening on: http://0.0.0.0:3000` in the startup banner)
3. Firewall on the mini-server allows port 3000 from the hotspot subnet
4. MikroTik API is enabled (`/ip service print`)
5. MikroTik credentials in `.env` work (run the diagnostic endpoint)
6. Profile names in `data/offers.js` match exactly with MikroTik hotspot profiles
7. Walled-garden rule allows clients to reach `10.5.50.2:3000`

---

## 10. Security checklist

- [ ] `.env` is in `.gitignore` and **never** committed.
- [ ] CamPay token is in `.env` only — not in `login.html`.
- [ ] Backend runs on a LAN-only mini-server — port 3000 is not exposed to the public internet.
- [ ] Dedicated RouterOS user with restricted policy.
- [ ] Walled garden allows only the local backend IP+port and CamPay hostnames.
- [ ] Backend re-validates `bundle_id`, `phone`, profile existence,
      and uses the server-side price.
- [ ] Replace the in-memory `store` Map with a real DB before scaling.
