# Kurv

A grocery lookout list, stock ledger and spend tracker. Static page on GitHub
Pages, all your data on your phone, prices rebuilt nightly by a GitHub Action.

## Why there's a build step

The Flask version downloaded `latest-canonical.json` on startup. That file is
over 20 MB and `dagligepriser.dk` sends no CORS headers, so a browser on
`yourname.github.io` can neither fetch it nor afford to.

A GitHub Action does it instead. Server-to-server, so CORS never applies. It
replays each item's price history into day-weighted segments and precomputes
the three numbers the phone actually needs, then publishes a slim catalog
alongside the app.

Nothing is committed back to the repo — the Action deploys to Pages as an
artifact, so the repo stays a few hundred kilobytes forever instead of growing
by the size of the dataset every night.

## Setup

1. Create a repository on github.com. **Public** — free Pages needs it. Nothing
   about you goes in here; your lists and purchases never leave your phone.
2. Upload these files, keeping the folder structure:
   ```
   .github/workflows/deploy.yml
   tools/build-data.mjs
   site/index.html
   site/app.css
   site/app.js
   site/view.js
   site/manifest.webmanifest
   site/icon.png
   ```
3. **Settings → Pages → Source: GitHub Actions.** Not "Deploy from a branch" —
   that's the one difference from the SunWatch setup.
4. **Actions** tab → "Build prices and deploy" → **Run workflow**. First run
   takes a couple of minutes, most of it downloading the dataset.
5. Open `https://yourname.github.io/yourrepo/` in Safari → Share → Add to Home
   Screen.

After that it rebuilds at 05:10 UTC daily. Run it manually any time from the
Actions tab.

## Using it

**Setup** — make a list per thing you buy repeatedly (Pasta, Milk), not per
product. Pick the unit it's measured in. Everything converts into that unit, so
a 500 g bag and a 1 kg bag are directly comparable regardless of brand.

Fill in expected use per month — "7 packs of 500 g" — and the model has a
consumption rate before you've logged anything. It's a prior, not a fixed
value: with three logged purchases your actual behaviour and the estimate weigh
equally, and it fades further from there.

**Shop** — search, tap `+` to watch a product. Watched products show a shelf
tag with the discount and, more importantly, how long it has been running.

**Stock** — lots with expiry, projected run-out date, projected waste.

**Ledger** — what you paid against what the same goods normally cost, split by
why you bought them.

## Data notes

`priceHistory` in the upstream feed records price *changes*, not daily
observations, so the date of the most recent entry is the date the current
price took effect. That's what the freshness tag counts from.

"Usual price" is the time-weighted mode over the trailing year — the price the
item sits at on the most days — not the year high. A year high is one bad
outlier away from making everything look like a bargain.

## Backups

Setup → Export backup. Do it before clearing Safari data or changing phones.
Home-screen apps get a more durable storage bucket than a plain tab, but iOS
will still evict an app you haven't opened in weeks.
