'use strict';

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const cookieSession = require('cookie-session');
const bcrypt = require('bcryptjs');

const { all, get, run, getSetting, setSetting, init } = require('./lib/db');
const { syncNow } = require('./lib/youtube');
const { slugify, timeAgo, formatDate, formatViews, truncate, detectDevice } = require('./lib/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

// Postgres helpers for the ISO 'YYYY-MM-DD HH:MM:SS' text timestamps this app uses.
const tsAgo = (amount, unit) =>
  `TO_CHAR(NOW() - INTERVAL '${amount} ${unit}', 'YYYY-MM-DD HH24:MI:SS')`;
const tsDaysAgoParam = `TO_CHAR(NOW() - (?::text || ' days')::interval, 'YYYY-MM-DD HH24:MI:SS')`;
const dayOf = (col) => `SUBSTRING(${col}, 1, 10)`;
const tsNow = `TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')`;

// DB must be initialised (tables + seed) before serving. On serverless this
// runs once per cold start; the promise is shared by all requests.
const dbReady = init().catch((e) => {
  console.error('[db] init failed:', e.message);
  throw e;
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://www.youtube.com', 'https://www.googletagmanager.com', 'https://*.googletagmanager.com'],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:', 'http:'],
      frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      connectSrc: ["'self'", 'https://www.google-analytics.com'],
    },
  },
}));
app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '7d' }));

// Stateless signed-cookie sessions (no server-side store — required on serverless).
app.use(cookieSession({
  name: 'bdp_session',
  keys: [process.env.SESSION_SECRET || 'babydanceparty-secret-change-me'],
  maxAge: 1000 * 60 * 60 * 12,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
}));

// Wait for DB init before handling anything.
app.use(async (req, res, next) => {
  try { await dbReady; next(); }
  catch (e) { res.status(500).send('Database unavailable. Please try again shortly.'); }
});

// ---- Shared locals: settings, categories, ads ----
app.use(async (req, res, next) => {
  try {
    const s = {};
    for (const row of await all('SELECT key, value FROM settings')) s[row.key] = row.value;
    res.locals.settings = s;
    res.locals.categories = await all('SELECT * FROM categories ORDER BY sort_order, name');
    res.locals.ads = {};
    for (const row of await all('SELECT slot, code, enabled FROM ads')) {
      res.locals.ads[row.slot] = row.enabled ? row.code : '';
    }
    res.locals.nav_pages = await all('SELECT slug, title FROM pages WHERE show_in_nav = 1 ORDER BY title');
    res.locals.helpers = { timeAgo, formatDate, formatViews, truncate, slugify };
    res.locals.req = req;
    // Best-effort auto-sync: if the last sync is older than the configured
    // interval, refresh from YouTube in the background (never blocks the page).
    maybeAutoSync(s).catch(() => {});
    next();
  } catch (e) { next(e); }
});

let syncInFlight = false;
async function maybeAutoSync(s) {
  if (syncInFlight) return;
  const mins = Math.max(10, parseInt(s.sync_interval_minutes || '30', 10));
  const last = s.last_sync_at ? new Date(s.last_sync_at).getTime() : 0;
  if (Date.now() - last < mins * 60 * 1000) return;
  syncInFlight = true;
  try {
    const n = await syncNow();
    console.log('[sync] auto-sync done:', n, 'videos');
  } catch (e) {
    console.log('[sync] auto-sync failed:', e.message);
  } finally {
    syncInFlight = false;
  }
}

// Cron endpoint (e.g. Vercel Cron every 30 min). Harmless if hit by anyone:
// it no-ops when a recent sync already happened.
app.get('/api/cron-sync', async (req, res) => {
  const mins = Math.max(10, parseInt(await getSetting('sync_interval_minutes') || '30', 10));
  const last = await getSetting('last_sync_at');
  if (last && Date.now() - new Date(last).getTime() < (mins - 5) * 60 * 1000) {
    return res.json({ ok: true, skipped: true, reason: 'recently synced' });
  }
  if (syncInFlight) return res.json({ ok: true, skipped: true, reason: 'sync already running' });
  syncInFlight = true;
  try {
    const n = await syncNow();
    res.json({ ok: true, videos: n });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  } finally {
    syncInFlight = false;
  }
});

// ---- Lightweight analytics: page views ----
app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/api/') && !req.path.match(/\.(css|js|png|jpg|webp|ico|svg)$/)) {
    try {
      await run('INSERT INTO stats (path, referrer, device) VALUES (?, ?, ?)',
        [req.path, (req.get('referer') || '').slice(0, 300), detectDevice(req.get('user-agent'))]);
    } catch (e) { /* ignore */ }
  }
  next();
});

// ---- Click tracking (ad + youtube clicks) ----
app.post('/api/track-click', async (req, res) => {
  const kind = String(req.body.kind || '').slice(0, 30);
  const label = String(req.body.label || '').slice(0, 100);
  if (['ad', 'youtube', 'smartlink'].includes(kind)) {
    try { await run('INSERT INTO clicks (kind, label) VALUES (?, ?)', [kind, label]); } catch (e) {}
  }
  res.json({ ok: true });
});

// ---- Video helpers ----
async function getVideoById(videoId) {
  return get(`SELECT v.*, c.name AS category_name, c.slug AS category_slug
    FROM videos v LEFT JOIN categories c ON v.category_id = c.id WHERE v.video_id = ?`, [videoId]);
}

async function listVideos({ categoryId, featured, orderBy = 'published_at DESC', limit = 12, offset = 0, excludeId } = {}) {
  let where = '1=1';
  const params = [];
  if (categoryId) { where += ' AND v.category_id = ?'; params.push(categoryId); }
  if (featured) { where += ' AND v.featured = 1'; }
  if (excludeId) { where += ' AND v.video_id != ?'; params.push(excludeId); }
  const rows = await all(`SELECT v.*, c.name AS category_name, c.slug AS category_slug
    FROM videos v LEFT JOIN categories c ON v.category_id = c.id
    WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, offset]);
  const total = (await get(`SELECT COUNT(*) AS c FROM videos v WHERE ${where}`, params)).c;
  return { rows, total: Number(total) };
}

function videoUrl(v) {
  return '/watch/' + v.video_id + '/' + v.slug;
}

function canonicalUrl(req, p) {
  const host = req.get('host');
  return req.protocol + '://' + host + p;
}

// ================= PUBLIC ROUTES =================

app.get('/', async (req, res, next) => {
  try {
    const latest = await listVideos({ limit: 8 });
    const featured = await listVideos({ featured: true, limit: 4 });
    const popular = await listVideos({ orderBy: 'view_count DESC', limit: 8 });
    res.render('index', {
      title: res.locals.settings.site_title,
      metaDescription: res.locals.settings.site_description,
      canonical: canonicalUrl(req, '/'),
      latest: latest.rows, featured: featured.rows, popular: popular.rows, videoUrl,
    });
  } catch (e) { next(e); }
});

app.get('/videos', async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = parseInt(res.locals.settings.videos_per_page || '12', 10);
    const { rows, total } = await listVideos({ limit: perPage, offset: (page - 1) * perPage });
    res.render('videos', {
      title: 'All Videos - ' + res.locals.settings.site_title,
      metaDescription: 'Browse all dance videos from ' + res.locals.settings.site_title,
      canonical: canonicalUrl(req, '/videos'),
      videos: rows, videoUrl, page, perPage, total,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (e) { next(e); }
});

app.get('/watch/:id/:slug?', async (req, res, next) => {
  try {
    const v = await getVideoById(req.params.id);
    if (!v) return res.status(404).render('notfound', { title: 'Video not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
    if (req.params.slug && req.params.slug !== v.slug) return res.redirect(301, videoUrl(v));
    const related = (await listVideos({ categoryId: v.category_id, excludeId: v.video_id, limit: 8 })).rows;
    const relatedFill = related.length < 8
      ? (await listVideos({ excludeId: v.video_id, limit: 8 - related.length })).rows.filter(r => !related.find(x => x.video_id === r.video_id))
      : [];
    res.render('watch', {
      title: v.title + ' - ' + res.locals.settings.site_title,
      metaDescription: truncate(v.description, 155) || v.title,
      canonical: canonicalUrl(req, videoUrl(v)),
      video: v, related: related.concat(relatedFill),
      ogImage: v.thumbnail, publishedAt: v.published_at,
    });
  } catch (e) { next(e); }
});

app.get('/category/:slug', async (req, res, next) => {
  try {
    const cat = await get('SELECT * FROM categories WHERE slug = ?', [req.params.slug]);
    if (!cat) return res.status(404).render('notfound', { title: 'Category not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const perPage = parseInt(res.locals.settings.videos_per_page || '12', 10);
    const { rows, total } = await listVideos({ categoryId: cat.id, limit: perPage, offset: (page - 1) * perPage });
    res.render('category', {
      title: cat.name + ' - ' + res.locals.settings.site_title,
      metaDescription: cat.description || cat.name,
      canonical: canonicalUrl(req, '/category/' + cat.slug),
      category: cat, videos: rows, videoUrl, page, totalPages: Math.ceil(total / perPage),
    });
  } catch (e) { next(e); }
});

app.get('/categories', async (req, res, next) => {
  try {
    const cats = await all(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
      FROM categories c ORDER BY c.sort_order, c.name`);
    res.render('categories', {
      title: 'Categories - ' + res.locals.settings.site_title,
      metaDescription: 'Browse videos by category',
      canonical: canonicalUrl(req, '/categories'),
      cats,
    });
  } catch (e) { next(e); }
});

app.get('/search', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    let videos = [];
    if (q) {
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      videos = await all(`SELECT v.*, c.name AS category_name, c.slug AS category_slug
        FROM videos v LEFT JOIN categories c ON v.category_id = c.id
        WHERE v.title LIKE ? OR v.description LIKE ? OR c.name LIKE ?
        ORDER BY v.published_at DESC LIMIT 24`, [like, like, like]);
    }
    res.render('search', {
      title: (q ? 'Search: ' + q : 'Search') + ' - ' + res.locals.settings.site_title,
      metaDescription: 'Search videos',
      canonical: canonicalUrl(req, '/search'),
      q, videos, videoUrl,
    });
  } catch (e) { next(e); }
});

app.get('/page/:slug', async (req, res, next) => {
  try {
    const p = await get('SELECT * FROM pages WHERE slug = ?', [req.params.slug]);
    if (!p) return res.status(404).render('notfound', { title: 'Page not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
    res.render('page', {
      title: p.title + ' - ' + res.locals.settings.site_title,
      metaDescription: truncate(p.content.replace(/<[^>]+>/g, ''), 155),
      canonical: canonicalUrl(req, '/page/' + p.slug),
      page: p, showForm: p.slug === 'contact',
    });
  } catch (e) { next(e); }
});

app.post('/page/contact', async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 100);
    const email = String(req.body.email || '').trim().slice(0, 150);
    const message = String(req.body.message || '').trim().slice(0, 2000);
    if (!name || !email.includes('@') || !message) {
      return res.redirect('/page/contact?error=1');
    }
    await run('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)', [name, email, message]);
    res.redirect('/page/contact?sent=1');
  } catch (e) { next(e); }
});

// ---- SEO files ----
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ' + canonicalUrl(req, '/sitemap.xml') + '\n'
  );
});

app.get('/sitemap.xml', async (req, res, next) => {
  try {
    const base = canonicalUrl(req, '');
    const urls = [
      { loc: base + '/', changefreq: 'daily', priority: '1.0' },
      { loc: base + '/videos', changefreq: 'daily', priority: '0.9' },
      { loc: base + '/categories', changefreq: 'weekly', priority: '0.7' },
    ];
    for (const c of res.locals.categories) {
      urls.push({ loc: base + '/category/' + c.slug, changefreq: 'daily', priority: '0.8' });
    }
    for (const v of await all('SELECT video_id, slug, published_at FROM videos ORDER BY published_at DESC LIMIT 500')) {
      urls.push({ loc: base + videoUrl(v), changefreq: 'weekly', priority: '0.8', lastmod: (v.published_at || '').slice(0, 10) });
    }
    for (const p of await all('SELECT slug FROM pages')) {
      urls.push({ loc: base + '/page/' + p.slug, changefreq: 'monthly', priority: '0.5' });
    }
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const u of urls) {
      xml += '  <url><loc>' + u.loc + '</loc>' +
        (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') +
        '<changefreq>' + u.changefreq + '</changefreq><priority>' + u.priority + '</priority></url>\n';
    }
    res.type('application/xml').send(xml + '</urlset>');
  } catch (e) { next(e); }
});

// ================= ADMIN =================

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  res.redirect('/admin/login');
}

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.render('admin/login', { title: 'Admin Login', error: req.query.error, layout: false });
});

app.post('/admin/login', async (req, res, next) => {
  try {
    const password = String(req.body.password || '');
    const hash = await getSetting('admin_password_hash');
    if (hash && bcrypt.compareSync(password, hash)) {
      req.session.admin = true;
      return res.redirect('/admin');
    }
    res.redirect('/admin/login?error=1');
  } catch (e) { next(e); }
});

app.get('/admin/logout', (req, res) => {
  req.session = null;
  res.redirect('/admin/login');
});

app.get('/admin', requireAdmin, async (req, res, next) => {
  try {
    const stats = {
      videos: Number((await get('SELECT COUNT(*) AS c FROM videos')).c),
      views24h: Number((await get(`SELECT COUNT(*) AS c FROM stats WHERE created_at > ${tsAgo(1, 'day')}`)).c),
      views7d: Number((await get(`SELECT COUNT(*) AS c FROM stats WHERE created_at > ${tsAgo(7, 'days')}`)).c),
      viewsTotal: Number((await get('SELECT COUNT(*) AS c FROM stats')).c),
      clicks: await all('SELECT kind, COUNT(*) AS c FROM clicks GROUP BY kind'),
      messages: Number((await get('SELECT COUNT(*) AS c FROM messages WHERE is_read = 0')).c),
    };
    const popularPages = await all(`SELECT path, COUNT(*) AS c FROM stats
      WHERE created_at > ${tsAgo(7, 'days')} GROUP BY path ORDER BY c DESC LIMIT 8`);
    res.render('admin/dashboard', {
      title: 'Dashboard', stats, popularPages,
      lastSync: await getSetting('last_sync_at'), lastSyncStatus: await getSetting('last_sync_status'),
      pwChanged: await getSetting('admin_password_changed'),
    });
  } catch (e) { next(e); }
});

// --- Admin: videos ---
app.get('/admin/videos', requireAdmin, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    let videos;
    if (q) {
      const like = '%' + q.replace(/[%_]/g, '') + '%';
      videos = await all(`SELECT v.*, c.name AS category_name FROM videos v
        LEFT JOIN categories c ON v.category_id = c.id
        WHERE v.title LIKE ? ORDER BY v.published_at DESC LIMIT 100`, [like]);
    } else {
      videos = await all(`SELECT v.*, c.name AS category_name FROM videos v
        LEFT JOIN categories c ON v.category_id = c.id ORDER BY v.published_at DESC LIMIT 100`);
    }
    const cats = await all('SELECT * FROM categories ORDER BY name');
    res.render('admin/videos', { title: 'Manage Videos', videos, cats, q, videoUrl, msg: req.query.msg });
  } catch (e) { next(e); }
});

app.post('/admin/videos/update', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.body.id, 10);
    const category_id = req.body.category_id ? parseInt(req.body.category_id, 10) : null;
    const featured = req.body.featured === '1' ? 1 : 0;
    await run('UPDATE videos SET category_id = ?, featured = ? WHERE id = ?', [category_id, featured, id]);
    res.redirect('/admin/videos?msg=saved');
  } catch (e) { next(e); }
});

app.post('/admin/videos/sync', requireAdmin, async (req, res, next) => {
  try {
    const n = await syncNow();
    res.redirect('/admin/videos?msg=synced-' + n);
  } catch (e) {
    res.redirect('/admin/videos?msg=sync-error');
  }
});

// --- Admin: categories ---
app.get('/admin/categories', requireAdmin, async (req, res, next) => {
  try {
    const cats = await all(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
      FROM categories c ORDER BY c.sort_order, c.name`);
    res.render('admin/categories', { title: 'Categories', cats, msg: req.query.msg });
  } catch (e) { next(e); }
});

app.post('/admin/categories/add', requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().slice(0, 80);
    if (!name) return res.redirect('/admin/categories');
    try {
      await run('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)',
        [name, slugify(name), String(req.body.description || '').slice(0, 300)]);
    } catch (e) {}
    res.redirect('/admin/categories?msg=saved');
  } catch (e) { next(e); }
});

app.post('/admin/categories/delete', requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.body.id, 10);
    await run('UPDATE videos SET category_id = NULL WHERE category_id = ?', [id]);
    await run('DELETE FROM categories WHERE id = ?', [id]);
    res.redirect('/admin/categories?msg=deleted');
  } catch (e) { next(e); }
});

// --- Admin: pages ---
app.get('/admin/pages', requireAdmin, async (req, res, next) => {
  try {
    const pages = await all('SELECT * FROM pages ORDER BY title');
    res.render('admin/pages', { title: 'Pages', pages, msg: req.query.msg });
  } catch (e) { next(e); }
});

app.get('/admin/pages/:id', requireAdmin, async (req, res, next) => {
  try {
    const p = await get('SELECT * FROM pages WHERE id = ?', [req.params.id]);
    if (!p) return res.redirect('/admin/pages');
    res.render('admin/page_edit', { title: 'Edit Page', page: p });
  } catch (e) { next(e); }
});

app.post('/admin/pages/:id', requireAdmin, async (req, res, next) => {
  try {
    await run('UPDATE pages SET title = ?, content = ?, show_in_nav = ?, updated_at = ' + tsNow + ' WHERE id = ?',
      [String(req.body.title || '').slice(0, 120), req.body.content || '',
        req.body.show_in_nav === '1' ? 1 : 0, req.params.id]);
    res.redirect('/admin/pages?msg=saved');
  } catch (e) { next(e); }
});

// --- Admin: ads ---
app.get('/admin/ads', requireAdmin, async (req, res, next) => {
  try {
    const ads = await all('SELECT * FROM ads');
    res.render('admin/ads', {
      title: 'Advertisements', ads, msg: req.query.msg,
      smartlink: await getSetting('adsterra_smartlink'),
    });
  } catch (e) { next(e); }
});

app.post('/admin/ads', requireAdmin, async (req, res, next) => {
  try {
    const codes = req.body.code || {};
    const enabled = req.body.enabled || {};
    for (const row of await all('SELECT slot FROM ads')) {
      await run('UPDATE ads SET code = ?, enabled = ? WHERE slot = ?',
        [String(codes[row.slot] || '').slice(0, 8000), enabled[row.slot] ? 1 : 0, row.slot]);
    }
    await setSetting('adsterra_smartlink', String(req.body.smartlink || '').slice(0, 500));
    res.redirect('/admin/ads?msg=saved');
  } catch (e) { next(e); }
});

// --- Admin: YouTube / API ---
app.get('/admin/youtube', requireAdmin, async (req, res, next) => {
  try {
    res.render('admin/youtube', {
      title: 'YouTube Settings', msg: req.query.msg,
      handle: await getSetting('youtube_channel_handle'), channelId: await getSetting('youtube_channel_id'),
      apiKey: (await getSetting('youtube_api_key')) ? '•••••••• (saved)' : '',
      channelUrl: await getSetting('youtube_channel_url'),
      lastSync: await getSetting('last_sync_at'), lastSyncStatus: await getSetting('last_sync_status'),
      interval: await getSetting('sync_interval_minutes'),
    });
  } catch (e) { next(e); }
});

app.post('/admin/youtube', requireAdmin, async (req, res, next) => {
  try {
    await setSetting('youtube_channel_handle', String(req.body.handle || '').slice(0, 80));
    await setSetting('youtube_channel_id', String(req.body.channel_id || '').slice(0, 80));
    await setSetting('youtube_channel_url', String(req.body.channel_url || '').slice(0, 200));
    if (String(req.body.api_key || '').trim()) await setSetting('youtube_api_key', String(req.body.api_key).trim().slice(0, 120));
    await setSetting('sync_interval_minutes', String(parseInt(req.body.interval || '30', 10) || 30));
    if (req.body.dosync === '1') {
      try { await syncNow(); return res.redirect('/admin/youtube?msg=synced'); }
      catch (e) { return res.redirect('/admin/youtube?msg=sync-error'); }
    }
    res.redirect('/admin/youtube?msg=saved');
  } catch (e) { next(e); }
});

// --- Admin: SEO + general settings ---
app.get('/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    const keys = ['site_title', 'site_tagline', 'site_description', 'ga_measurement_id', 'videos_per_page'];
    const vals = {};
    for (const k of keys) vals[k] = await getSetting(k);
    res.render('admin/settings', { title: 'Site Settings', vals, msg: req.query.msg });
  } catch (e) { next(e); }
});

app.post('/admin/settings', requireAdmin, async (req, res, next) => {
  try {
    for (const k of ['site_title', 'site_tagline', 'site_description', 'ga_measurement_id']) {
      await setSetting(k, String(req.body[k] || '').slice(0, 300));
    }
    await setSetting('videos_per_page', String(Math.min(48, Math.max(4, parseInt(req.body.videos_per_page || '12', 10)))));
    if (String(req.body.new_password || '').length >= 6) {
      await setSetting('admin_password_hash', bcrypt.hashSync(String(req.body.new_password), 10));
      await setSetting('admin_password_changed', '1');
    }
    res.redirect('/admin/settings?msg=saved');
  } catch (e) { next(e); }
});

// --- Admin: stats ---
app.get('/admin/stats', requireAdmin, async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days || '7', 10)));
    const cutoff = tsDaysAgoParam;
    const byDay = await all(`SELECT ${dayOf('created_at')} AS d, COUNT(*) AS c FROM stats
      WHERE created_at > ${cutoff} GROUP BY d ORDER BY d`, [days]);
    const byDevice = await all(`SELECT device, COUNT(*) AS c FROM stats
      WHERE created_at > ${cutoff} GROUP BY device`, [days]);
    const byPath = await all(`SELECT path, COUNT(*) AS c FROM stats
      WHERE created_at > ${cutoff} GROUP BY path ORDER BY c DESC LIMIT 15`, [days]);
    const byRef = await all(`SELECT referrer, COUNT(*) AS c FROM stats
      WHERE created_at > ${cutoff} AND referrer != ''
      GROUP BY referrer ORDER BY c DESC LIMIT 10`, [days]);
    const clicks = await all(`SELECT kind, label, COUNT(*) AS c FROM clicks
      WHERE created_at > ${cutoff} GROUP BY kind, label ORDER BY c DESC LIMIT 15`, [days]);
    res.render('admin/stats', { title: 'Statistics', days, byDay, byDevice, byPath, byRef, clicks });
  } catch (e) { next(e); }
});

// --- Admin: messages ---
app.get('/admin/messages', requireAdmin, async (req, res, next) => {
  try {
    const messages = await all('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100');
    res.render('admin/messages', { title: 'Messages', messages });
  } catch (e) { next(e); }
});

app.post('/admin/messages/read', requireAdmin, async (req, res, next) => {
  try {
    await run('UPDATE messages SET is_read = 1 WHERE id = ?', [parseInt(req.body.id, 10)]);
    res.redirect('/admin/messages');
  } catch (e) { next(e); }
});

// ---- 404 ----
app.use((req, res) => {
  res.status(404).render('notfound', { title: 'Page not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
});

// ---- Error handler ----
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  res.status(500).render('notfound', { title: 'Something went wrong', metaDescription: '', canonical: canonicalUrl(req, req.path) });
});

module.exports = app;

// Only listen when run directly (node server.js). On Vercel the exported app
// is used as a serverless function via api/index.js.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log('Baby Dance Party TV site running on http://localhost:' + PORT);
    console.log('Admin: http://localhost:' + PORT + '/admin');
  });
}
