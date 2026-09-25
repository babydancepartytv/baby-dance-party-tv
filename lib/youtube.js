'use strict';

const { run, getSetting, setSetting } = require('./db');
const { slugify, formatDuration } = require('./helpers');

async function apiGet(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'BabyDancePartyTV-Site/1.0' } });
  if (!res.ok) {
    let reason = '';
    try {
      const j = await res.json();
      reason = j && j.error && j.error.errors && j.error.errors[0] ? j.error.errors[0].reason : '';
    } catch (e) { /* ignore */ }
    throw new Error('YouTube API error: ' + res.status + (reason ? ' (' + reason + ')' : ''));
  }
  return res.json();
}

// Resolve a channel handle (@name) to a channel ID using the API
async function resolveChannelId(apiKey, handle) {
  const h = String(handle || '').replace(/^@/, '');
  const data = await apiGet(
    'https://www.googleapis.com/youtube/v3/channels?part=id&forHandle=' +
    encodeURIComponent(h) + '&key=' + encodeURIComponent(apiKey)
  );
  if (data.items && data.items.length > 0) return data.items[0].id;
  throw new Error('Channel not found for handle ' + handle);
}

async function syncFromApi(apiKey, channelId) {
  // 1. Get uploads playlist + channel snippet
  const ch = await apiGet(
    'https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet,statistics&id=' +
    encodeURIComponent(channelId) + '&key=' + encodeURIComponent(apiKey)
  );
  if (!ch.items || !ch.items.length) throw new Error('Channel not found: ' + channelId);
  const uploadsId = ch.items[0].contentDetails.relatedPlaylists.uploads;
  await setSetting('youtube_channel_title', ch.items[0].snippet.title || '');
  if (ch.items[0].snippet.thumbnails) {
    const t = ch.items[0].snippet.thumbnails;
    await setSetting('youtube_channel_avatar', (t.medium || t.default || {}).url || '');
  }

  // 2. Walk the uploads playlist (a brand-new channel has no uploads playlist yet — treat as empty)
  let pageToken = '';
  let count = 0;
  const batch = [];
  try {
    do {
      const pl = await apiGet(
        'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=' +
        encodeURIComponent(uploadsId) + '&key=' + encodeURIComponent(apiKey) +
        (pageToken ? '&pageToken=' + pageToken : '')
      );
      for (const item of pl.items || []) {
        const vid = item.contentDetails.videoId;
        const sn = item.snippet;
        const thumbs = sn.thumbnails || {};
        batch.push({
          video_id: vid,
          title: sn.title,
          description: sn.description || '',
          thumbnail: (thumbs.maxres || thumbs.standard || thumbs.high || thumbs.medium || thumbs.default || {}).url || '',
          published_at: sn.publishedAt,
        });
      }
      pageToken = pl.nextPageToken || '';
      if (count++ > 10) break; // safety: max ~550 videos
    } while (pageToken);
  } catch (e) {
    if (/playlistNotFound/.test(e.message)) {
      await setSetting('last_sync_at', new Date().toISOString());
      await setSetting('last_sync_status', 'ok (channel has no videos yet — upload the first video and sync again)');
      return 0;
    }
    throw e;
  }

  // 3. Fetch durations + view counts in batches of 50
  for (let i = 0; i < batch.length; i += 50) {
    const ids = batch.slice(i, i + 50).map(v => v.video_id).join(',');
    try {
      const det = await apiGet(
        'https://www.googleapis.com/youtube/v3/videos?part=contentDetails,statistics&id=' +
        encodeURIComponent(ids) + '&key=' + encodeURIComponent(apiKey)
      );
      const map = {};
      for (const v of det.items || []) {
        map[v.id] = {
          duration: formatDuration(v.contentDetails.duration),
          views: parseInt((v.statistics || {}).viewCount || '0', 10),
        };
      }
      for (const v of batch.slice(i, i + 50)) {
        if (map[v.video_id]) {
          v.duration = map[v.video_id].duration;
          v.view_count = map[v.video_id].views;
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  await upsertVideos(batch);
  await setSetting('last_sync_at', new Date().toISOString());
  await setSetting('last_sync_status', 'ok (' + batch.length + ' videos via API)');
  return batch.length;
}

// Fallback: public RSS feed, no API key needed
async function syncFromRss(channelId) {
  const res = await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + encodeURIComponent(channelId),
    { headers: { 'User-Agent': 'BabyDancePartyTV-Site/1.0' } });
  if (!res.ok) throw new Error('RSS fetch failed: ' + res.status);
  const xml = await res.text();
  const videos = [];
  const entries = xml.split('<entry>').slice(1);
  for (const e of entries) {
    const id = /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e);
    const title = /<title>([^<]*)<\/title>/.exec(e);
    const pub = /<published>([^<]+)<\/published>/.exec(e);
    const thumb = /<media:thumbnail url="([^"]+)"/.exec(e);
    const desc = /<media:description>([\s\S]*?)<\/media:description>/.exec(e);
    if (id) {
      videos.push({
        video_id: id[1],
        title: title ? decodeXml(title[1]) : id[1],
        description: desc ? decodeXml(desc[1]).slice(0, 500) : '',
        thumbnail: thumb ? thumb[1] : '',
        published_at: pub ? pub[1] : '',
        duration: '',
        view_count: 0,
      });
    }
  }
  await upsertVideos(videos);
  await setSetting('last_sync_at', new Date().toISOString());
  await setSetting('last_sync_status', 'ok (' + videos.length + ' videos via RSS fallback)');
  return videos.length;
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function upsertVideos(videos) {
  for (const v of videos) {
    await run(`
      INSERT INTO videos (video_id, title, slug, description, thumbnail, published_at, duration, view_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(video_id) DO UPDATE SET
        title = excluded.title,
        description = excluded.description,
        thumbnail = excluded.thumbnail,
        published_at = excluded.published_at,
        duration = excluded.duration,
        view_count = excluded.view_count
    `, [v.video_id, v.title, slugify(v.title) + '-' + v.video_id.slice(-6),
      v.description, v.thumbnail, v.published_at, v.duration || '', v.view_count || 0]);
  }
}

async function syncNow() {
  const apiKey = await getSetting('youtube_api_key');
  let channelId = await getSetting('youtube_channel_id');
  try {
    if (apiKey) {
      if (!channelId) {
        channelId = await resolveChannelId(apiKey, await getSetting('youtube_channel_handle'));
        await setSetting('youtube_channel_id', channelId);
      }
      return await syncFromApi(apiKey, channelId);
    }
    if (channelId) return await syncFromRss(channelId);
    throw new Error('No YouTube API key or channel ID configured. Set them in Admin → YouTube.');
  } catch (e) {
    await setSetting('last_sync_status', 'error: ' + e.message);
    throw e;
  }
}

module.exports = { syncNow, resolveChannelId };
