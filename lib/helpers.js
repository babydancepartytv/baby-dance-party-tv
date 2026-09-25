'use strict';

// Shared helper functions

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'video';
}

function timeAgo(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' min ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + ' hour' + (h > 1 ? 's' : '') + ' ago';
  const days = Math.floor(h / 24);
  if (days < 30) return days + ' day' + (days > 1 ? 's' : '') + ' ago';
  const months = Math.floor(days / 30);
  if (months < 12) return months + ' month' + (months > 1 ? 's' : '') + ' ago';
  const y = Math.floor(months / 12);
  return y + ' year' + (y > 1 ? 's' : '') + ' ago';
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatViews(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function formatDuration(iso) {
  // ISO 8601 duration (PT1H2M3S) -> H:MM:SS
  if (!iso) return '';
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso);
  if (!m) return '';
  const h = parseInt(m[1] || '0', 10);
  const min = parseInt(m[2] || '0', 10);
  const sec = parseInt(m[3] || '0', 10);
  const mm = h > 0 ? String(min).padStart(2, '0') : String(min);
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}

function detectDevice(ua) {
  ua = String(ua || '').toLowerCase();
  if (/mobile|android|iphone|ipod|blackberry|iemobile|opera mini/.test(ua)) return 'mobile';
  if (/tablet|ipad/.test(ua)) return 'tablet';
  return 'desktop';
}

function truncate(text, len) {
  text = String(text || '');
  if (text.length <= len) return text;
  return text.slice(0, len).replace(/\s+\S*$/, '') + '…';
}

module.exports = { slugify, timeAgo, formatDate, formatViews, formatDuration, detectDevice, truncate };
