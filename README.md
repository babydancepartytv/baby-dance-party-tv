# Baby Dance Party TV — Website

Professional video content platform with YouTube integration and Adsterra monetization.

## Features
- Home page with hero, latest / featured / popular videos, categories, search
- YouTube Data API v3 sync (auto + manual), RSS fallback without API key
- Dedicated video pages: `/watch/:videoId/:slug` with embed, related videos, share buttons
- Categories, full-text search, video sitemap, SEO meta + Open Graph + JSON-LD
- Adsterra: Smartlink + 5 ad-code slots (header, in-content, sidebar, mobile, native), all labeled "Advertisement"
- Secure admin panel (`/admin`): dashboard, videos, categories, pages, ads, YouTube/API, stats, messages, settings
- Built-in analytics (page views, devices, referrers, popular pages, ad/youtube click tracking) + Google Analytics support
- Dark/light mode, fully responsive, lazy-loaded images

## Run locally
```bash
npm install
ADMIN_PASSWORD=your-secure-password SESSION_SECRET=some-random-string PORT=3000 node server.js
```
Open http://localhost:3000 — admin at http://localhost:3000/admin (default password `admin123` if `ADMIN_PASSWORD` not set; change it in Settings).

## Configuration (Admin → YouTube)
1. Create a free YouTube Data API v3 key in Google Cloud Console (restrict it to YouTube Data API v3).
2. Paste the key in Admin → YouTube, set the channel ID (auto-resolved from handle if empty), Save & Sync Now.

Without an API key the site uses the public YouTube RSS feed (latest ~15 videos).

## Deploy (Render.com free)
1. Push this folder to a GitHub repo.
2. Render → New → Web Service → connect repo.
3. Build: `npm install`, Start: `npm start`.
4. Environment: `ADMIN_PASSWORD`, `SESSION_SECRET`, `PORT=10000` (Render sets PORT itself).
5. Note: free tier has ephemeral disk — the SQLite DB resets on redeploy/restart. Settings are re-seeded with defaults; videos re-sync from YouTube automatically.

## Project structure
```
server.js          Express app, routes, admin
lib/db.js          SQLite (node:sqlite) schema + seeds
lib/youtube.js     YouTube API + RSS sync
lib/helpers.js     formatting helpers
views/             EJS templates (public + admin)
public/css|js      theme styles + frontend JS
data/site.db       SQLite database (created on first run)
```
