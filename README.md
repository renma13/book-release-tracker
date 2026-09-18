# Shelf Watch

A tiny, static app that watches your Goodreads "To-Read" shelf and shows you
upcoming book release dates on a calendar — no manual re-importing needed.

## How it works

- **Syncing without an API**: Goodreads shut down its public API, and a static
  site can't read goodreads.com's cookies (different domain, browsers block that).
  What *does* work: every shelf — including private ones — has an RSS feed URL
  containing a secret token. Paste that URL once and the app keeps re-fetching
  it automatically through a CORS proxy (a small relay that lets browser code
  read pages from other sites). Free public proxies are flaky (rate limits,
  trial periods, outages), so the app tries several in turn automatically —
  see **Reliable syncing** below for a permanent fix.
- **Release dates**: Goodreads' feed often only has a book's *original* publish
  year, not a future edition's date, so each book is also looked up via the
  [Hardcover](https://hardcover.app/) API — a book-tracking site that keeps
  accurate upcoming release dates — using your own free API key.

## Setup

### 1. Get your shelf's RSS URL
1. Go to your Goodreads profile → **My Books** → **To-Read** shelf.
2. Scroll to the very bottom of the page.
3. Right-click the small orange **RSS** link and copy its URL.
4. It'll look like `https://www.goodreads.com/review/list_rss/12345678?shelf=to-read&key=...`

### 2. Get a Hardcover API key (for release dates)
1. Create a free account at [hardcover.app](https://hardcover.app/).
2. Go to your account settings → **Hardcover API**.
3. Click **New API Key** and copy it.

### 3. Configure the app
1. Open the app and click the ⚙️ Settings icon.
2. Paste your shelf RSS URL and your Hardcover API key.
3. Click **Save settings**, then **Sync now**.

## Reliable syncing (recommended)

Out of the box, syncing tries a handful of public CORS proxies in turn. That
works, but those proxies are shared by everyone using them, so they're
sometimes slow, rate-limited, or temporarily down — and a couple require
paid plans once a free trial period ends. For syncing that won't randomly
break:

1. Go to [workers.cloudflare.com](https://workers.cloudflare.com/) and sign
   up (free, no card required).
2. Create a new Worker, delete its sample code, and paste in the contents of
   this project's [`proxy-worker.js`](proxy-worker.js).
3. Deploy it. Copy the Worker's URL — it looks like
   `https://shelf-watch-proxy.<you>.workers.dev`.
4. In Shelf Watch's Settings, paste `https://shelf-watch-proxy.<you>.workers.dev/?url=`
   into the "Your own CORS proxy" field (keep the trailing `/?url=`) and save.

This Worker is entirely yours — it only ever proxies goodreads.com, and
Cloudflare's free tier (100,000 requests/day) is far more than this app needs.

## Hosting on GitHub Pages

```bash
git init
git add .
git commit -m "Initial Shelf Watch app"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

Then in the repo's GitHub Settings → Pages, set the source to the `main`
branch, root folder. Your app will be live at
`https://<your-username>.github.io/<repo-name>/`.

## Notes and limitations

- All your settings and synced book data are stored only in your browser's
  local storage — nothing is sent to any server you don't control (other than
  the CORS proxy fetching your public RSS URL, and Hardcover for release dates).
- If syncing is unreliable, set up your own proxy — see **Reliable syncing**
  above. It's the difference between "usually works" and "always works."
- Release dates aren't guaranteed for every book — some upcoming titles simply
  don't have a publish date on Hardcover yet.
- A sync looks up release dates for every book that doesn't have one yet, paced
  to stay under Hardcover's rate limit — so a large shelf's first sync can take
  a couple of minutes, but you shouldn't need to click "Sync now" repeatedly.
  Progress is saved as it goes, so closing the app partway through doesn't lose it.
