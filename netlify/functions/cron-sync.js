'use strict';

// Netlify Scheduled Function — YouTube auto-sync every 30 minutes.
const { schedule } = require('@netlify/functions');
const { init } = require('../../lib/db');
const { syncNow } = require('../../lib/youtube');

let ready = null;

exports.handler = schedule('*/30 * * * *', async () => {
  try {
    if (!ready) ready = init();
    await ready;
    const n = await syncNow();
    console.log('[cron] sync done:', n, 'videos');
    return { statusCode: 200, body: JSON.stringify({ ok: true, videos: n }) };
  } catch (e) {
    console.log('[cron] sync failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: e.message }) };
  }
});
