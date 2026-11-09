# Cedar Clinic Frontend

React 19 and Vite appointment page, with a server-side Express gateway. Patients can
choose a clinician, date, and available slot; book a visit; reload their confirmation;
and cancel that browser's appointment. Dates are displayed in the browser's timezone.
An administrator can search a patient's bookings by email, paginate results, view and
cancel individual bookings, and replace the schedule with the protected reset operation.

## Local Development

From the repository root:

```sh
npm --prefix frontend ci
```

Terminal 1 (backend):

```sh
npm run dev
```

Terminal 2 (frontend):

```sh
npm run web:dev
```

Open **http://localhost:5173**. The API runs at **http://localhost:3000**.
React changes hot-reload through Vite. Restart the frontend after server or environment
changes. Set `WEB_PORT` to another free port if 5173 is occupied.

The local frontend gateway reads `API_KEY` from the repository root's existing `.env`.
It defaults to the local API on port 3000. An optional `frontend/.env` takes precedence:
set server-only `API_BASE_URL` to the HTTPS Render URL and `API_KEY` to its API key
to use the deployed backend instead. Never commit either environment file.

## Vercel Deployment

1. Import this same GitHub repository into Vercel as a new project.
2. Set **Root Directory** to `frontend` and **Framework Preset** to Vite.
3. Build command: `npm run build`. Output directory: `dist`. Install command: `npm ci`.
4. Add environment variables `API_BASE_URL` (your HTTPS Render base URL), `API_KEY`
  (the same secret configured in Render), `NODE_ENV=production`, and a separate
  `ADMIN_PASSWORD` of at least 16 characters to enable administration.
5. Deploy. Use the Vercel website URL for the assessment's web page field. The existing
   Render URL remains the API base URL submitted separately.

`api/[...path].js` is the Vercel function entry point. It reuses the Express gateway;
`vercel.json` leaves `/api` functions and built assets available before the SPA fallback.
The browser calls same-origin `/api` routes, so the Render API doesn't need a public
CORS origin or client-visible API key. Never create a `VITE_API_KEY` variable.

The first API request may take longer when a free Render service is waking up. The
gateway has a 55-second upstream timeout and Vercel function max duration is 60 seconds.
If the service takes longer, a retryable error appears. API availability, schedule
seeding and PostgreSQL migrations remain backend responsibilities.

## Security and Retries

- The gateway exposes slots, booking creation and only the current browser's
  confirmation/cancellation to anonymous browsers. Email-based booking listing,
  individual booking lookup/cancellation, and reset require an administrator session.
- Successful creation sets a signed HttpOnly, SameSite=Strict confirmation cookie,
  secure in production and valid for 24 hours. Rotating the API key invalidates it.
  This is a browser confirmation, not full patient authentication.
- Admin sessions use a separate signed HttpOnly, SameSite=Strict cookie, secure in
  production and valid for four hours. Rotating `ADMIN_PASSWORD` invalidates these
  sessions. The password is not the backend API key, is never bundled or stored in
  browser storage, and should be random and private. Sign-in is limited to five
  attempts per minute per gateway instance; add edge rate rules for public deployments.
- JSON-only mutations and same-origin checks protect the gateway from ordinary
  cross-origin form submissions. React renders patient input as text, not HTML.
- Booking retries reuse an idempotency key. Session storage contains only a SHA-256
  request fingerprint and that key, not names, emails, or the backend API key.
- The PostgreSQL backend enforces the shared email quota. Gateway per-IP limits are
  best-effort and instance-local; use Vercel Firewall/rate rules for distributed abuse
  protection. Never treat this gateway as a substitute for backend authorization.
- After an HTTP 429, the page disables booking for Retry-After seconds and uses a new
  key for the next logical attempt. Network/server failures retain the old key.

## Administration

Set `ADMIN_PASSWORD` in the ignored `frontend/.env` (or root `.env` for local development)
and in Vercel's server environment. Generate a strong value locally, for example:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Do not send the password through chat or commit it. Restart the frontend after local
environment changes; redeploy Vercel after production environment changes.

Open **Manage bookings**, sign in, and use **User bookings** to search by patient email.
Choose a page size before searching; **Previous**, **Next**, and refresh use the same
email filter. The eye button fetches booking details; the cancel button requires a
confirmation dialog. This is staff access to clinic records, not a patient email login.

**Schedule reset** replaces the entire schedule and permanently deletes all bookings,
idempotency records, and rate-limit history. Load and edit the current slots or add new
ones; dates are entered in the browser's timezone and sent as ISO timestamps. Type
`RESET` before submitting. An empty schedule also requires checking the explicit clear
schedule option. Never use reset on live patient data unless this deletion is intended.

## Verification

```sh
npm run web:test
npm run web:build
```

Tests cover private gateway authentication, signed-cookie ownership, cancellation,
cross-origin protection, Retry-After, configuration, and client retry keys. Admin checks
cover protected search/pagination, explicit reset confirmation, tampered/expired
sessions, secure cookies, and disabled-by-default access. The browser
workflow was checked against the real backend, including confirmation reload and
cancellation, at desktop and mobile widths. Error/empty states use intercepted test
responses, not extra database bookings.
Administration search, pagination, details, cancellation, reset payloads, empty-schedule
guards and mobile layouts were checked with intercepted responses, not live resets.

The clinic reception image is a locally served Unsplash photograph from
https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d. Cedar Clinic is a demonstration
brand, not a claim that the photographed venue operates this API.