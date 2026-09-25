'use strict';

// Postgres-backed data layer (Neon / any Postgres). Async API.
// Works on serverless (Vercel) and on a normal long-lived Node process.

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

let _pool = null;
function pool() {
  if (!_pool) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error('DATABASE_URL environment variable is not set');
    _pool = new Pool({
      connectionString: url,
      max: 3,
      idleTimeoutMillis: 15000,
      connectionTimeoutMillis: 15000,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    _pool.on('error', (e) => console.log('[db] pool error:', e.message));
  }
  return _pool;
}

// Convert SQLite-style ? placeholders to Postgres $1, $2, ...
function pg(text) {
  let i = 0;
  return text.replace(/\?/g, () => '$' + (++i));
}

async function all(text, params = []) {
  const res = await pool().query(pg(text), params);
  return res.rows;
}

async function get(text, params = []) {
  const rows = await all(text, params);
  return rows[0];
}

async function run(text, params = []) {
  await pool().query(pg(text), params);
  return { changes: 0 };
}

async function getSetting(key, fallback) {
  const row = await get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : (fallback !== undefined ? fallback : '');
}

async function setSetting(key, value) {
  await run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, value === undefined || value === null ? '' : String(value)]
  );
}

const TS_DEFAULT = "TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')";

async function init() {
  await pool().query(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  description TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS videos (
  id SERIAL PRIMARY KEY,
  video_id TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT DEFAULT '',
  thumbnail TEXT DEFAULT '',
  published_at TEXT DEFAULT '',
  duration TEXT DEFAULT '',
  view_count INTEGER DEFAULT 0,
  category_id INTEGER REFERENCES categories(id),
  featured INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ${TS_DEFAULT}
);
CREATE INDEX IF NOT EXISTS idx_videos_published ON videos(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_videos_featured ON videos(featured DESC, published_at DESC);

CREATE TABLE IF NOT EXISTS pages (
  id SERIAL PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  content TEXT DEFAULT '',
  show_in_nav INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS ads (
  id SERIAL PRIMARY KEY,
  slot TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  code TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS stats (
  id SERIAL PRIMARY KEY,
  path TEXT NOT NULL,
  referrer TEXT DEFAULT '',
  device TEXT DEFAULT 'desktop',
  created_at TEXT DEFAULT ${TS_DEFAULT}
);
CREATE INDEX IF NOT EXISTS idx_stats_created ON stats(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stats_path ON stats(path);

CREATE TABLE IF NOT EXISTS clicks (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT DEFAULT '',
  created_at TEXT DEFAULT ${TS_DEFAULT}
);

CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT ${TS_DEFAULT}
);
`);
  await seed();
}

async function seed() {
  // Admin password
  if (!(await getSetting('admin_password_hash'))) {
    const initial = process.env.ADMIN_PASSWORD || 'admin123';
    await setSetting('admin_password_hash', bcrypt.hashSync(initial, 10));
    await setSetting('admin_password_changed', '0');
  }

  const defaults = {
    site_title: 'Baby Dance Party TV',
    site_tagline: 'Cute babies dancing videos for everyone',
    site_description: 'Watch the cutest AI cartoon babies dance! Fun dance videos for babies, toddlers and preschoolers.',
    youtube_channel_handle: '@BabyDancePartyTV-k9p',
    youtube_channel_id: '',
    youtube_channel_url: 'https://www.youtube.com/@BabyDancePartyTV-k9p',
    youtube_api_key: '',
    adsterra_smartlink: 'https://www.profitableratecpmnetwork.com/k0jhkuxk?key=9a477c0ab7b657408a3b6a7800618f9a',
    ga_measurement_id: '',
    videos_per_page: '12',
    sync_interval_minutes: '30',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if ((await getSetting(k, null)) === null) await setSetting(k, v);
  }

  const catCount = (await get('SELECT COUNT(*) AS c FROM categories')).c;
  if (Number(catCount) === 0) {
    const cats = [
      ['Latest Videos', 'latest-videos', 'The freshest uploads from Baby Dance Party TV', 1],
      ['Popular Videos', 'popular-videos', 'The most loved dance videos', 2],
      ['Shorts', 'shorts', 'Quick fun dance shorts', 3],
      ['Movie Explained', 'movie-explained', 'Movies explained in a fun way', 4],
      ['Gaming', 'gaming', 'Gaming videos and fun', 5],
      ['AI', 'ai', 'AI related videos', 6],
      ['Technology', 'technology', 'Tech videos and news', 7],
      ['Tutorials', 'tutorials', 'Learn step by step', 8],
    ];
    for (const c of cats) {
      await run('INSERT INTO categories (name, slug, description, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING', c);
    }
  }

  const pageCount = (await get('SELECT COUNT(*) AS c FROM pages')).c;
  if (Number(pageCount) === 0) {
    const pages = [
      ['about', 'About Us', '<p><strong>Baby Dance Party TV</strong> is the funnest place for babies, toddlers and preschoolers to dance! We create cute 3D cartoon baby dance videos with catchy kids music.</p><p>New videos are added regularly — subscribe to our YouTube channel and never miss the party!</p>', 1],
      ['contact', 'Contact Us', '<p>Have a question or suggestion? Send us a message using the form below and we will get back to you.</p>', 1],
      ['privacy', 'Privacy Policy', '<p>Your privacy matters. This website does not collect personal information except what you voluntarily provide (e.g. via the contact form).</p><p>We use embedded YouTube videos; YouTube/Google may set cookies per their own privacy policy. Third-party advertisers (such as Adsterra) may use cookies to serve relevant ads.</p>', 0],
      ['terms', 'Terms & Conditions', '<p>By using this website you agree to these terms. All videos are embedded from our official YouTube channel. Content is provided for entertainment purposes only.</p>', 0],
      ['disclaimer', 'Disclaimer', '<p>This website embeds videos from YouTube. We do not host any video files on our servers. Advertisements are served by third-party ad networks and we are not responsible for their content.</p>', 0],
    ];
    for (const p of pages) {
      await run('INSERT INTO pages (slug, title, content, show_in_nav) VALUES (?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING', p);
    }
  }

  const adCount = (await get('SELECT COUNT(*) AS c FROM ads')).c;
  if (Number(adCount) === 0) {
    const slots = [
      ['header', 'Header Banner (below navigation)', ''],
      ['incontent', 'In-Content Ad (inside video page)', ''],
      ['sidebar', 'Sidebar Ad', ''],
      ['mobile', 'Mobile Sticky Ad', ''],
      ['native', 'Native Ad (inside video grids)', ''],
    ];
    for (const s of slots) {
      await run('INSERT INTO ads (slot, label, code, enabled) VALUES (?, ?, ?, 1) ON CONFLICT(slot) DO NOTHING', s);
    }
  }

  // Environment variable overrides: env always wins so config survives database resets.
  const envMap = {
    SITE_TITLE: 'site_title',
    SITE_TAGLINE: 'site_tagline',
    SITE_DESCRIPTION: 'site_description',
    YOUTUBE_CHANNEL_HANDLE: 'youtube_channel_handle',
    YOUTUBE_CHANNEL_ID: 'youtube_channel_id',
    YOUTUBE_CHANNEL_URL: 'youtube_channel_url',
    YOUTUBE_API_KEY: 'youtube_api_key',
    ADSTERRA_SMARTLINK: 'adsterra_smartlink',
    GA_MEASUREMENT_ID: 'ga_measurement_id',
  };
  for (const [env, key] of Object.entries(envMap)) {
    if (process.env[env]) await setSetting(key, process.env[env]);
  }
}

module.exports = { all, get, run, getSetting, setSetting, init };
