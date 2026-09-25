'use strict';

const express = require('express');
const path = require('path');
const helmet = require('helmet');
const compression = require('compression');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { db, getSetting, setSetting } = require('./lib/db');
const { syncNow } = require('./lib/youtube');
const { slugify, timeAgo, formatDate, formatViews, truncate, detectDevice } = require('./lib/helpers');

const app = express();
const PORT = process.env.PORT || 3000;

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

app.use(session({
  secret: process.env.SESSION_SECRET || 'babydanceparty-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 },
}));

// ---- Shared locals: settings, categories, ads ----
app.use((req, res, next) => {
  const s = {};
  for (const row of db.prepare('SELECT key, value FROM settings').all()) s[row.key] = row.value;
  res.locals.settings = s;
  res.locals.categories = db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();
  res.locals.ads = {};
  for (const row of db.prepare('SELECT slot, code, enabled FROM ads').all()) {
    res.locals.ads[row.slot] = row.enabled ? row.code : '';
  }
  res.locals.nav_pages = db.prepare('SELECT slug, title FROM pages WHERE show_in_nav = 1 ORDER BY title').all();
  res.locals.helpers = { timeAgo, formatDate, formatViews, truncate, slugify };
  res.locals.req = req;
  next();
});

// ---- Lightweight analytics: page views ----
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/admin') && !req.path.startsWith('/api/') && !req.path.match(/\.(css|js|png|jpg|webp|ico|svg)$/)) {
    try {
      db.prepare('INSERT INTO stats (path, referrer, device) VALUES (?, ?, ?)')
        .run(req.path, (req.get('referer') || '').slice(0, 300), detectDevice(req.get('user-agent')));
    } catch (e) { /* ignore */ }
  }
  next();
});

// ---- Click tracking (ad + youtube clicks) ----
app.post('/api/track-click', (req, res) => {
  const kind = String(req.body.kind || '').slice(0, 30);
  const label = String(req.body.label || '').slice(0, 100);
  if (['ad', 'youtube', 'smartlink'].includes(kind)) {
    try { db.prepare('INSERT INTO clicks (kind, label) VALUES (?, ?)').run(kind, label); } catch (e) {}
  }
  res.json({ ok: true });
});

// ---- Video helpers ----
function getVideoById(videoId) {
  return db.prepare(`SELECT v.*, c.name AS category_name, c.slug AS category_slug
    FROM videos v LEFT JOIN categories c ON v.category_id = c.id WHERE v.video_id = ?`).get(videoId);
}

function listVideos({ categoryId, featured, orderBy = 'published_at DESC', limit = 12, offset = 0, excludeId } = {}) {
  let where = '1=1';
  const params = [];
  if (categoryId) { where += ' AND v.category_id = ?'; params.push(categoryId); }
  if (featured) { where += ' AND v.featured = 1'; }
  if (excludeId) { where += ' AND v.video_id != ?'; params.push(excludeId); }
  const rows = db.prepare(`SELECT v.*, c.name AS category_name, c.slug AS category_slug
    FROM videos v LEFT JOIN categories c ON v.category_id = c.id
    WHERE ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS c FROM videos v WHERE ${where}`).get(...params).c;
  return { rows, total };
}

function videoUrl(v) {
  return '/watch/' + v.video_id + '/' + v.slug;
}

function canonicalUrl(req, p) {
  const host = req.get('host');
  return req.protocol + '://' + host + p;
}

// ================= PUBLIC ROUTES =================

app.get('/', (req, res) => {
  const latest = listVideos({ limit: 8 });
  const featured = listVideos({ featured: true, limit: 4 });
  const popular = listVideos({ orderBy: 'view_count DESC', limit: 8 });
  res.render('index', {
    title: res.locals.settings.site_title,
    metaDescription: res.locals.settings.site_description,
    canonical: canonicalUrl(req, '/'),
    latest: latest.rows, featured: featured.rows, popular: popular.rows, videoUrl,
  });
});

app.get('/videos', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = parseInt(res.locals.settings.videos_per_page || '12', 10);
  const { rows, total } = listVideos({ limit: perPage, offset: (page - 1) * perPage });
  res.render('videos', {
    title: 'All Videos - ' + res.locals.settings.site_title,
    metaDescription: 'Browse all dance videos from ' + res.locals.settings.site_title,
    canonical: canonicalUrl(req, '/videos'),
    videos: rows, videoUrl, page, perPage, total,
    totalPages: Math.ceil(total / perPage),
  });
});

app.get('/watch/:id/:slug?', (req, res) => {
  const v = getVideoById(req.params.id);
  if (!v) return res.status(404).render('notfound', { title: 'Video not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
  if (req.params.slug && req.params.slug !== v.slug) return res.redirect(301, videoUrl(v));
  const related = listVideos({ categoryId: v.category_id, excludeId: v.video_id, limit: 8 }).rows;
  const relatedFill = related.length < 8
    ? listVideos({ excludeId: v.video_id, limit: 8 - related.length }).rows.filter(r => !related.find(x => x.video_id === r.video_id))
    : [];
  res.render('watch', {
    title: v.title + ' - ' + res.locals.settings.site_title,
    metaDescription: truncate(v.description, 155) || v.title,
    canonical: canonicalUrl(req, videoUrl(v)),
    video: v, related: related.concat(relatedFill),
    ogImage: v.thumbnail, publishedAt: v.published_at,
  });
});

app.get('/category/:slug', (req, res) => {
  const cat = db.prepare('SELECT * FROM categories WHERE slug = ?').get(req.params.slug);
  if (!cat) return res.status(404).render('notfound', { title: 'Category not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const perPage = parseInt(res.locals.settings.videos_per_page || '12', 10);
  const { rows, total } = listVideos({ categoryId: cat.id, limit: perPage, offset: (page - 1) * perPage });
  res.render('category', {
    title: cat.name + ' - ' + res.locals.settings.site_title,
    metaDescription: cat.description || cat.name,
    canonical: canonicalUrl(req, '/category/' + cat.slug),
    category: cat, videos: rows, videoUrl, page, totalPages: Math.ceil(total / perPage),
  });
});

app.get('/categories', (req, res) => {
  const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
    FROM categories c ORDER BY c.sort_order, c.name`).all();
  res.render('categories', {
    title: 'Categories - ' + res.locals.settings.site_title,
    metaDescription: 'Browse videos by category',
    canonical: canonicalUrl(req, '/categories'),
    cats,
  });
});

app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  let videos = [];
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    videos = db.prepare(`SELECT v.*, c.name AS category_name, c.slug AS category_slug
      FROM videos v LEFT JOIN categories c ON v.category_id = c.id
      WHERE v.title LIKE ? OR v.description LIKE ? OR c.name LIKE ?
      ORDER BY v.published_at DESC LIMIT 24`).all(like, like, like);
  }
  res.render('search', {
    title: (q ? 'Search: ' + q : 'Search') + ' - ' + res.locals.settings.site_title,
    metaDescription: 'Search videos',
    canonical: canonicalUrl(req, '/search'),
    q, videos, videoUrl,
  });
});

app.get('/page/:slug', (req, res) => {
  const p = db.prepare('SELECT * FROM pages WHERE slug = ?').get(req.params.slug);
  if (!p) return res.status(404).render('notfound', { title: 'Page not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
  res.render('page', {
    title: p.title + ' - ' + res.locals.settings.site_title,
    metaDescription: truncate(p.content.replace(/<[^>]+>/g, ''), 155),
    canonical: canonicalUrl(req, '/page/' + p.slug),
    page: p, showForm: p.slug === 'contact',
  });
});

app.post('/page/contact', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const email = String(req.body.email || '').trim().slice(0, 150);
  const message = String(req.body.message || '').trim().slice(0, 2000);
  if (!name || !email.includes('@') || !message) {
    return res.redirect('/page/contact?error=1');
  }
  db.prepare('INSERT INTO messages (name, email, message) VALUES (?, ?, ?)').run(name, email, message);
  res.redirect('/page/contact?sent=1');
});

// ---- SEO files ----
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /admin/\nSitemap: ' + canonicalUrl(req, '/sitemap.xml') + '\n'
  );
});

app.get('/sitemap.xml', (req, res) => {
  const base = canonicalUrl(req, '');
  const urls = [
    { loc: base + '/', changefreq: 'daily', priority: '1.0' },
    { loc: base + '/videos', changefreq: 'daily', priority: '0.9' },
    { loc: base + '/categories', changefreq: 'weekly', priority: '0.7' },
  ];
  for (const c of res.locals.categories) {
    urls.push({ loc: base + '/category/' + c.slug, changefreq: 'daily', priority: '0.8' });
  }
  for (const v of db.prepare('SELECT video_id, slug, published_at FROM videos ORDER BY published_at DESC LIMIT 500').all()) {
    urls.push({ loc: base + videoUrl(v), changefreq: 'weekly', priority: '0.8', lastmod: (v.published_at || '').slice(0, 10) });
  }
  for (const p of db.prepare('SELECT slug FROM pages').all()) {
    urls.push({ loc: base + '/page/' + p.slug, changefreq: 'monthly', priority: '0.5' });
  }
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const u of urls) {
    xml += '  <url><loc>' + u.loc + '</loc>' +
      (u.lastmod ? '<lastmod>' + u.lastmod + '</lastmod>' : '') +
      '<changefreq>' + u.changefreq + '</changefreq><priority>' + u.priority + '</priority></url>\n';
  }
  res.type('application/xml').send(xml + '</urlset>');
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

app.post('/admin/login', (req, res) => {
  const password = String(req.body.password || '');
  const hash = getSetting('admin_password_hash');
  if (hash && bcrypt.compareSync(password, hash)) {
    req.session.admin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin/login?error=1');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin', requireAdmin, (req, res) => {
  const stats = {
    videos: db.prepare('SELECT COUNT(*) AS c FROM videos').get().c,
    views24h: db.prepare("SELECT COUNT(*) AS c FROM stats WHERE created_at > datetime('now', '-1 day')").get().c,
    views7d: db.prepare("SELECT COUNT(*) AS c FROM stats WHERE created_at > datetime('now', '-7 days')").get().c,
    viewsTotal: db.prepare('SELECT COUNT(*) AS c FROM stats').get().c,
    clicks: db.prepare('SELECT kind, COUNT(*) AS c FROM clicks GROUP BY kind').all(),
    messages: db.prepare('SELECT COUNT(*) AS c FROM messages WHERE is_read = 0').get().c,
  };
  const popularPages = db.prepare(`SELECT path, COUNT(*) AS c FROM stats
    WHERE created_at > datetime('now', '-7 days') GROUP BY path ORDER BY c DESC LIMIT 8`).all();
  res.render('admin/dashboard', {
    title: 'Dashboard', stats, popularPages,
    lastSync: getSetting('last_sync_at'), lastSyncStatus: getSetting('last_sync_status'),
    pwChanged: getSetting('admin_password_changed'),
  });
});

// --- Admin: videos ---
app.get('/admin/videos', requireAdmin, (req, res) => {
  const q = String(req.query.q || '').trim();
  let videos;
  if (q) {
    const like = '%' + q.replace(/[%_]/g, '') + '%';
    videos = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
      LEFT JOIN categories c ON v.category_id = c.id
      WHERE v.title LIKE ? ORDER BY v.published_at DESC LIMIT 100`).all(like);
  } else {
    videos = db.prepare(`SELECT v.*, c.name AS category_name FROM videos v
      LEFT JOIN categories c ON v.category_id = c.id ORDER BY v.published_at DESC LIMIT 100`).all();
  }
  const cats = db.prepare('SELECT * FROM categories ORDER BY name').all();
  res.render('admin/videos', { title: 'Manage Videos', videos, cats, q, videoUrl, msg: req.query.msg });
});

app.post('/admin/videos/update', requireAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10);
  const category_id = req.body.category_id ? parseInt(req.body.category_id, 10) : null;
  const featured = req.body.featured === '1' ? 1 : 0;
  db.prepare('UPDATE videos SET category_id = ?, featured = ? WHERE id = ?').run(category_id, featured, id);
  res.redirect('/admin/videos?msg=saved');
});

app.post('/admin/videos/sync', requireAdmin, async (req, res) => {
  try {
    const n = await syncNow();
    res.redirect('/admin/videos?msg=synced-' + n);
  } catch (e) {
    res.redirect('/admin/videos?msg=sync-error');
  }
});

// --- Admin: categories ---
app.get('/admin/categories', requireAdmin, (req, res) => {
  const cats = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM videos v WHERE v.category_id = c.id) AS video_count
    FROM categories c ORDER BY c.sort_order, c.name`).all();
  res.render('admin/categories', { title: 'Categories', cats, msg: req.query.msg });
});

app.post('/admin/categories/add', requireAdmin, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 80);
  if (!name) return res.redirect('/admin/categories');
  try {
    db.prepare('INSERT INTO categories (name, slug, description) VALUES (?, ?, ?)')
      .run(name, slugify(name), String(req.body.description || '').slice(0, 300));
  } catch (e) {}
  res.redirect('/admin/categories?msg=saved');
});

app.post('/admin/categories/delete', requireAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10);
  db.prepare('UPDATE videos SET category_id = NULL WHERE category_id = ?').run(id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  res.redirect('/admin/categories?msg=deleted');
});

// --- Admin: pages ---
app.get('/admin/pages', requireAdmin, (req, res) => {
  const pages = db.prepare('SELECT * FROM pages ORDER BY title').all();
  res.render('admin/pages', { title: 'Pages', pages, msg: req.query.msg });
});

app.get('/admin/pages/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM pages WHERE id = ?').get(req.params.id);
  if (!p) return res.redirect('/admin/pages');
  res.render('admin/page_edit', { title: 'Edit Page', page: p });
});

app.post('/admin/pages/:id', requireAdmin, (req, res) => {
  db.prepare('UPDATE pages SET title = ?, content = ?, show_in_nav = ?, updated_at = datetime(\'now\') WHERE id = ?')
    .run(String(req.body.title || '').slice(0, 120), req.body.content || '',
      req.body.show_in_nav === '1' ? 1 : 0, req.params.id);
  res.redirect('/admin/pages?msg=saved');
});

// --- Admin: ads ---
app.get('/admin/ads', requireAdmin, (req, res) => {
  const ads = db.prepare('SELECT * FROM ads').all();
  res.render('admin/ads', {
    title: 'Advertisements', ads, msg: req.query.msg,
    smartlink: getSetting('adsterra_smartlink'),
  });
});

app.post('/admin/ads', requireAdmin, (req, res) => {
  const codes = req.body.code || {};
  const enabled = req.body.enabled || {};
  for (const row of db.prepare('SELECT slot FROM ads').all()) {
    db.prepare('UPDATE ads SET code = ?, enabled = ? WHERE slot = ?')
      .run(String(codes[row.slot] || '').slice(0, 8000), enabled[row.slot] ? 1 : 0, row.slot);
  }
  setSetting('adsterra_smartlink', String(req.body.smartlink || '').slice(0, 500));
  res.redirect('/admin/ads?msg=saved');
});

// --- Admin: YouTube / API ---
app.get('/admin/youtube', requireAdmin, (req, res) => {
  res.render('admin/youtube', {
    title: 'YouTube Settings', msg: req.query.msg,
    handle: getSetting('youtube_channel_handle'), channelId: getSetting('youtube_channel_id'),
    apiKey: getSetting('youtube_api_key') ? '•••••••• (saved)' : '',
    channelUrl: getSetting('youtube_channel_url'),
    lastSync: getSetting('last_sync_at'), lastSyncStatus: getSetting('last_sync_status'),
    interval: getSetting('sync_interval_minutes'),
  });
});

app.post('/admin/youtube', requireAdmin, async (req, res) => {
  setSetting('youtube_channel_handle', String(req.body.handle || '').slice(0, 80));
  setSetting('youtube_channel_id', String(req.body.channel_id || '').slice(0, 80));
  setSetting('youtube_channel_url', String(req.body.channel_url || '').slice(0, 200));
  if (String(req.body.api_key || '').trim()) setSetting('youtube_api_key', String(req.body.api_key).trim().slice(0, 120));
  setSetting('sync_interval_minutes', String(parseInt(req.body.interval || '30', 10) || 30));
  if (req.body.dosync === '1') {
    try { await syncNow(); return res.redirect('/admin/youtube?msg=synced'); }
    catch (e) { return res.redirect('/admin/youtube?msg=sync-error'); }
  }
  res.redirect('/admin/youtube?msg=saved');
});

// --- Admin: SEO + general settings ---
app.get('/admin/settings', requireAdmin, (req, res) => {
  const keys = ['site_title', 'site_tagline', 'site_description', 'ga_measurement_id', 'videos_per_page'];
  const vals = {};
  for (const k of keys) vals[k] = getSetting(k);
  res.render('admin/settings', { title: 'Site Settings', vals, msg: req.query.msg });
});

app.post('/admin/settings', requireAdmin, (req, res) => {
  for (const k of ['site_title', 'site_tagline', 'site_description', 'ga_measurement_id']) {
    setSetting(k, String(req.body[k] || '').slice(0, 300));
  }
  setSetting('videos_per_page', String(Math.min(48, Math.max(4, parseInt(req.body.videos_per_page || '12', 10)))));
  if (String(req.body.new_password || '').length >= 6) {
    setSetting('admin_password_hash', bcrypt.hashSync(String(req.body.new_password), 10));
    setSetting('admin_password_changed', '1');
  }
  res.redirect('/admin/settings?msg=saved');
});

// --- Admin: stats ---
app.get('/admin/stats', requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days || '7', 10)));
  const byDay = db.prepare(`SELECT date(created_at) AS d, COUNT(*) AS c FROM stats
    WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY d ORDER BY d`).all(days);
  const byDevice = db.prepare(`SELECT device, COUNT(*) AS c FROM stats
    WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY device`).all(days);
  const byPath = db.prepare(`SELECT path, COUNT(*) AS c FROM stats
    WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY path ORDER BY c DESC LIMIT 15`).all(days);
  const byRef = db.prepare(`SELECT referrer, COUNT(*) AS c FROM stats
    WHERE created_at > datetime('now', '-' || ? || ' days') AND referrer != ''
    GROUP BY referrer ORDER BY c DESC LIMIT 10`).all(days);
  const clicks = db.prepare(`SELECT kind, label, COUNT(*) AS c FROM clicks
    WHERE created_at > datetime('now', '-' || ? || ' days') GROUP BY kind, label ORDER BY c DESC LIMIT 15`).all(days);
  res.render('admin/stats', { title: 'Statistics', days, byDay, byDevice, byPath, byRef, clicks });
});

// --- Admin: messages ---
app.get('/admin/messages', requireAdmin, (req, res) => {
  const messages = db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 100').all();
  res.render('admin/messages', { title: 'Messages', messages });
});

app.post('/admin/messages/read', requireAdmin, (req, res) => {
  db.prepare('UPDATE messages SET is_read = 1 WHERE id = ?').run(parseInt(req.body.id, 10));
  res.redirect('/admin/messages');
});

// ---- 404 ----
app.use((req, res) => {
  res.status(404).render('notfound', { title: 'Page not found', metaDescription: '', canonical: canonicalUrl(req, req.path) });
});

// ---- Auto YouTube sync ----
let syncTimer = null;
function scheduleSync() {
  if (syncTimer) clearInterval(syncTimer);
  const mins = Math.max(10, parseInt(getSetting('sync_interval_minutes') || '30', 10));
  syncTimer = setInterval(async () => {
    try { await syncNow(); console.log('[sync] auto-sync done'); }
    catch (e) { console.log('[sync] auto-sync failed:', e.message); }
  }, mins * 60 * 1000);
}

app.listen(PORT, async () => {
  console.log('Baby Dance Party TV site running on http://localhost:' + PORT);
  console.log('Admin: http://localhost:' + PORT + '/admin');
  scheduleSync();
  // Initial sync in background (non-blocking)
  setTimeout(async () => {
    try {
      const n = await syncNow();
      console.log('[sync] initial sync done:', n, 'videos');
    } catch (e) { console.log('[sync] initial sync skipped:', e.message); }
  }, 3000);
});
