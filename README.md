# Purchase Tracker

A small web app for logging purchases. Works offline, installs to a phone home
screen, and mirrors every entry into a Google Sheet it creates for you on first
sign-in.

**Live:** https://scmartin1995.github.io/Purchase-Tracker/

## Deploying

**Pushing to `main` deploys.** GitHub Pages serves this repo's root directly —
there's no build step, no CI, and no staging. A push is live within a minute or
two.

## Running locally

No build, no dependencies. Serve the folder over HTTP — `file://` won't work,
because service workers and the Google sign-in flow both need a real origin.

```bash
npx serve -l 8099 .
```

Then open http://localhost:8099. Google sign-in only works from an origin
listed in the OAuth client's **Authorized JavaScript origins**, so on a fresh
`localhost` port the sync features will fail until you add it — the rest of the
app works fine without signing in.

## How it fits together

| File | Does |
|---|---|
| `index.html` | All three pages in one document; shown and hidden with a CSS class |
| `script.js` | Everything else — state, rendering, Google Sheets sync, the chart |
| `style.css` | Design tokens and layout. No framework |
| `service-worker.js` | Offline caching |
| `manifest.json` | Makes it installable as a PWA |

Data lives in two places at once. `localStorage` is what the UI reads from; a
Google Sheet is the durable copy. Each purchase carries a generated `id` and a
`row` number so the two can be matched back up after a reinstall.

## Things worth knowing before you change something

- **`CATEGORIES` in `script.js` is the single source of truth** for category
  names, colors, and auto-detect keywords. Adding a category is one entry there
  — plus its `--bar-*` and `.pill-*` tokens in `style.css`, which is the one
  part that isn't generated.
- **The order of `CATEGORIES` is load-bearing.** `suggestCategory()` takes the
  first keyword match and keywords overlap (`"gas bill"` hits both Utilities
  and Transportation). Reordering changes what gets auto-detected.
- **The category colors were validated, not chosen by eye.** There's a note in
  `style.css` with the command to re-run before changing any of them.
- **The service worker is network-first for HTML/JS/CSS**, so deploys land
  without bumping `CACHE_NAME` by hand.
- **Amounts are always positive.** This tracks purchases; there's no refund or
  negative-amount concept, and invalid entries are dropped when loading.

## Google setup

The app uses a Google OAuth **Web application** client. The client ID in
`script.js` is not a secret — a browser app ships it to every visitor no matter
what. What restricts it is the **Authorized JavaScript origins** list in the
Google Cloud Console, which should name only the origins that should be able to
use it.

Scope is `drive.file` only: the app can reach the spreadsheet it created, not
anything else in your Drive.
