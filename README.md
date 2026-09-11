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
| `scripts/check_contrast.js` | Verifies the palette's contrast ratios and colour separation. Not served to the browser |
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
- **The app is dark, and the palette was re-derived for it.** The category
  colours are not the old light-mode ones dimmed: the previous set was
  validated against a white surface, and moving to a dark one changes both the
  WCAG ratios and the perceived gaps between hues.
- **The category colours were verified, not chosen by eye.** Run
  `node scripts/check_contrast.js` after changing any value in the `:root`
  block; it exits non-zero on a regression. Order still matters, because the
  separation check compares *adjacent* entries in `CATEGORIES` order.
  (`style.css` used to point at `scripts/validate_palette.js`, which was never
  committed. `check_contrast.js` is a simpler replacement and does not
  reproduce that tool's exact figures.)
- **`activeRange` in `script.js` is the single source of truth for the time
  filter**, and `inSelectedRange()` is the only definition of "is this purchase
  in it". The purchases list, the footer total, the hero, the category bars and
  the trend chart all read from those two, so they can't disagree about which
  entries count. The filter row itself is cloned from one `<template>` into
  every `.filter-mount`, so the copies on Home and Purchases can't drift apart.
- **One time filter at a time.** The preset dropdown and the From date clear
  each other. Two overlapping ranges would need an intersection rule nobody
  could predict from looking at the controls.
- **The service worker is network-first for HTML/JS/CSS**, so deploys land
  without bumping `CACHE_NAME` by hand.
- **Anything the sheet doesn't have goes up on the next sign-in.**
  `pushUnsyncedPurchases()` appends every purchase still without a `row` once
  `reconcileLocalWithSheet()` has matched what it can, in one batched call.
  That's what gets an entry made while signed out into the sheet.
- **Duplicates are prevented by the id in column E, not by a timestamp.**
  Reconcile matches on it first, so an append that landed but never reported
  back is matched rather than re-sent. Don't replace this with a "last synced
  at" watermark: `date` is the purchase date and is backdatable, and a
  half-failed upload would either lose entries or duplicate them.
- **A failed sheet write never discards the entry.** It stays local without a
  `row` — exactly the state the next sync uploads.
- **The weekly goal ignores the time filter, on purpose.** It always means the
  current Sunday-to-Saturday week. The filter is for looking around; the goal
  answers "how am I doing right now", and a figure that moved when you changed
  the filter would answer neither question.
- **The goal is a standing value, not a weekly entry.** Set it once and it
  carries week to week; only "Remove goal" clears it. `weekBounds()` derives
  the current Sunday-to-Saturday window from the clock on every render, so the
  spend resets at the rollover while the target stays put. Neither "Clear
  device" nor "Sign out & clear" touch it — those erase purchases, and the
  goal isn't one.
- **The goal lives on the device only.** It isn't a purchase, so it has no home
  in the sheet's `A:E`, and it won't survive a reinstall or clearing site data.
  It's one number and it's quick to re-enter.
- **A cached `row` is a hint, never a write address.** Every update and delete
  calls `resolveSheetRow()` first, matching the id in column E. Row numbers are
  positions and positions move: a sheet delete that commits but fails to report
  back leaves everything below it off by one, and so does tidying the sheet by
  hand in Google Sheets. Writing to a stale row overwrites whichever purchase
  now sits there. `row` survives only to decide what still needs uploading.
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
