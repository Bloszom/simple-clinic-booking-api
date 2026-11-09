# Cedar Clinic Frontend

React 19 and Vite appointment page, with a server-side Express gateway. Patients can
choose a clinician, date, and available slot; book a visit; reload their confirmation;
and cancel that browser's appointment. Dates are displayed in the browser's timezone.

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
   (the same secret configured in Render), and `NODE_ENV=production`.
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
  confirmation/cancellation. It does not forward reset, arbitrary booking lookup,
  or email-based booking listing to anonymous browsers.
- Successful creation sets a signed HttpOnly, SameSite=Strict confirmation cookie,
  secure in production and valid for 24 hours. Rotating the API key invalidates it.
  This is a browser confirmation, not full patient authentication.
- JSON-only mutations and same-origin checks protect the gateway from ordinary
  cross-origin form submissions. React renders patient input as text, not HTML.
- Booking retries reuse an idempotency key. Session storage contains only a SHA-256
  request fingerprint and that key, not names, emails, or the backend API key.
- The PostgreSQL backend enforces the shared email quota. Gateway per-IP limits are
  best-effort and instance-local; use Vercel Firewall/rate rules for distributed abuse
  protection. Never treat this gateway as a substitute for backend authorization.
- After an HTTP 429, the page disables booking for Retry-After seconds and uses a new
  key for the next logical attempt. Network/server failures retain the old key.

## Verification

```sh
npm run web:test
npm run web:build
```

Tests cover private gateway authentication, signed-cookie ownership, cancellation,
cross-origin protection, Retry-After, configuration, and client retry keys. The browser
workflow was checked against the real backend, including confirmation reload and
cancellation, at desktop and mobile widths. Error/empty states use intercepted test
responses, not extra database bookings.

The clinic reception image is a locally served Unsplash photograph from
https://images.unsplash.com/photo-1519494026892-80bbd2d6fd0d. Cedar Clinic is a demonstration
brand, not a claim that the photographed venue operates this API.