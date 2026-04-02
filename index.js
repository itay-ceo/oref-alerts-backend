const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool, init: initDb } = require('./db');
const { uploadBuffer } = require('./cloudinary');
const CITIES_DATA = require('./cities-data');

const app = express();
app.use(express.json());

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }));

// Serve admin UI
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// Privacy policy
app.get('/privacy', (_req, res) => res.sendFile(path.join(__dirname, 'privacy.html')));

// ─── Multer setup (memory storage → Cloudinary) ─────────────────────
const upload = multer({ storage: multer.memoryStorage() });

const PORT = process.env.PORT || 3001;
const OREF_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const POLL_INTERVAL_MS = 3000;

// In-memory stores
const pushTokens = new Set();
let lastAlertId = null;
let wasActive = false; // tracks if previous poll had an active alert

// ─── Register push token ─────────────────────────────────────────────
app.post('/register', async (req, res) => {
  const { token, sounds } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  pushTokens.add(token);

  try {
    const warningSound = sounds?.warning?.id ? `${sounds.warning.id}.caf` : null;
    const activeSound = sounds?.active?.id ? `${sounds.active.id}.caf` : null;
    const allClearSound = sounds?.allClear?.id ? `${sounds.allClear.id}.caf` : null;

    await pool.query(
      `INSERT INTO devices (token, warning_sound, active_sound, all_clear_sound, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (token) DO UPDATE SET
         warning_sound = COALESCE($2, devices.warning_sound),
         active_sound = COALESCE($3, devices.active_sound),
         all_clear_sound = COALESCE($4, devices.all_clear_sound),
         updated_at = NOW()`,
      [token, warningSound, activeSound, allClearSound]
    );
  } catch (err) {
    console.error('Failed to upsert device:', err.message);
  }

  console.log(`Registered token (${pushTokens.size} total)`);
  res.json({ success: true });
});

// ─── Update sound preference for a device ────────────────────────────
app.post('/update-sounds', async (req, res) => {
  const { token, alertType, soundId } = req.body;
  if (!token || !alertType) return res.status(400).json({ error: 'token and alertType are required' });

  const columnMap = { warning: 'warning_sound', active: 'active_sound', allClear: 'all_clear_sound' };
  const column = columnMap[alertType];
  if (!column) return res.status(400).json({ error: 'invalid alertType' });

  const filename = soundId ? `${soundId}.caf` : null;
  try {
    await pool.query(
      `UPDATE devices SET ${column} = $1, updated_at = NOW() WHERE token = $2`,
      [filename, token]
    );
    console.log(`Updated ${alertType} sound for device: ${filename}`);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update sound:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Test alert endpoint ─────────────────────────────────────────────
const ALERT_TITLES = {
  active: '🚨 אזעקה',
  warning: 'התראה מוקדמת ⚠️',
  all_clear: '✅ סיום אירוע',
};

const ALERT_BODIES = {
  active: 'אזעקה אחים שלי, שיעבור מהר אמןןןן',
  warning: 'יש מצב שעוד מעט יהיו אזעקות, רק שפרו לכיוון מרחב מוגן (:',
  all_clear: 'אפשר לצאת, זהו, נגמר האירוע הכל סבבה.',
};

app.post('/test-alert', async (req, res) => {
  const { alertType = 'active', areas = ['תל אביב'] } = req.body;
  const title = ALERT_TITLES[alertType] || ALERT_TITLES.active;
  const body = areas.join(', ');
  console.log(`Test alert: ${title} → ${body}`);
  await sendPushToAll({ title, body, alertType });
  res.json({ success: true, tokenCount: pushTokens.size });
});

app.get('/test-alert', async (_req, res) => {
  if (process.env.FEATURE_TEST_ALERT !== 'true') {
    return res.status(404).json({ error: 'not found' });
  }
  const title = ALERT_TITLES.active;
  const body = ALERT_BODIES.active;
  console.log(`Test alert (GET): ${title} → ${body}`);
  await sendPushToAll({ title, body, alertType: 'active' });
  res.json({ success: true, tokenCount: pushTokens.size });
});

// ─── Alert classification ────────────────────────────────────────────
// Oref "cat" field values — all are active sirens:
//   1 = rockets/missiles, 2 = earthquake, 3 = tsunami,
//   4 = hostile aircraft, 5 = hazardous materials, 6 = terror attack,
//   7 = missile drill, 13 = non-conventional threat
// The API only returns active alerts. When the threat ends, the response
// becomes empty — that's how we detect "all clear".

function classifyAlert(alert) {
  const cat = parseInt(alert.cat, 10);
  const title = alert.title || '';

  // Drill alerts (cat 7) → warning
  if (cat === 7) {
    console.log(`  Classification: cat=${cat} → warning (drill)`);
    return 'warning';
  }

  // Everything else is an active siren
  console.log(`  Classification: cat=${cat} title="${title}" → active`);
  return 'active';
}

// ─── Oref poller ─────────────────────────────────────────────────────
async function pollOref() {
  try {
    const response = await fetch(OREF_URL, {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    const text = await response.text();

    // Empty response = no active alerts
    if (!text || text.trim() === '') {
      if (wasActive) {
        console.log('[all_clear] Alerts ended — sending all clear notification');
        wasActive = false;
        lastAlertId = null;
        const title = ALERT_TITLES.all_clear;
        await sendPushToAll({ title, body: ALERT_BODIES.all_clear, alertType: 'all_clear' });
      }
      return;
    }

    const data = JSON.parse(text);
    if (!data || (Array.isArray(data) && data.length === 0)) {
      if (wasActive) {
        console.log('[all_clear] Alerts ended (empty array) — sending all clear notification');
        wasActive = false;
        lastAlertId = null;
        const title = ALERT_TITLES.all_clear;
        await sendPushToAll({ title, body: ALERT_BODIES.all_clear, alertType: 'all_clear' });
      }
      return;
    }

    const alerts = Array.isArray(data) ? data : [data];
    const alert = alerts[0];

    console.log('[poll] Raw alert:', JSON.stringify(alert));

    const alertId = alert.id || JSON.stringify(alert);
    if (alertId === lastAlertId) return;
    lastAlertId = alertId;

    const alertType = classifyAlert(alert);
    wasActive = true;

    const title = ALERT_TITLES[alertType] || alert.title || 'התרעה';
    const areas = alert.data || [];
    const body = ALERT_BODIES[alertType] || areas.join(', ');

    console.log(`[${alertType}] ${title} → ${body} (${areas.length} areas)`);

    // Log alert to DB for stats
    try {
      await pool.query(
        'INSERT INTO alerts_log (alert_type, areas) VALUES ($1, $2)',
        [alertType, areas]
      );
    } catch (logErr) {
      console.error('[alerts_log] Failed to log alert:', logErr.message);
    }

    await sendPushToAll({ title, body, alertType });
  } catch (err) {
    if (err instanceof SyntaxError) return;
    console.error('Poll error:', err.message);
  }
}

// ─── One-shot fetch on startup to verify API connection ──────────────
async function testOrefConnection() {
  console.log('\n--- Testing Oref API connection ---');
  try {
    const response = await fetch(OREF_URL, {
      headers: {
        'Referer': 'https://www.oref.org.il/',
        'X-Requested-With': 'XMLHttpRequest',
      },
    });
    console.log(`HTTP ${response.status} ${response.statusText}`);
    const text = await response.text();
    if (!text || text.trim() === '') {
      console.log('Response: empty (no active alerts — this is normal)');
    } else {
      console.log('Response:', text.substring(0, 500));
      try {
        const data = JSON.parse(text);
        const alerts = Array.isArray(data) ? data : [data];
        console.log(`Parsed ${alerts.length} alert(s)`);
        alerts.forEach((a, i) => {
          console.log(`  Alert ${i}: cat=${a.cat} title="${a.title}" areas=${(a.data || []).length}`);
        });
      } catch { /* logged raw text above */ }
    }
  } catch (err) {
    console.error('API connection FAILED:', err.message);
  }
  console.log('--- End connection test ---\n');
}

// ─── Send push notifications ─────────────────────────────────────────
const ALERT_TYPE_COLUMN = { warning: 'warning_sound', active: 'active_sound', all_clear: 'all_clear_sound' };

async function sendPushToAll({ title, body, alertType }) {
  if (pushTokens.size === 0) {
    console.log('No registered tokens, skipping push');
    return;
  }

  // Load per-device sound preferences from DB
  let deviceSounds = {};
  try {
    const { rows } = await pool.query('SELECT token, warning_sound, active_sound, all_clear_sound FROM devices');
    for (const row of rows) {
      deviceSounds[row.token] = row;
    }
  } catch (err) {
    console.error('Failed to load device sounds:', err.message);
  }

  const soundColumn = ALERT_TYPE_COLUMN[alertType];
  const messages = [...pushTokens].map((token) => {
    const device = deviceSounds[token];
    const sound = (device && soundColumn && device[soundColumn]) || 'default';
    const shortToken = token.length > 20 ? `${token.slice(0, 10)}...${token.slice(-6)}` : token;
    console.log(`  Sending to ${shortToken} with sound: ${sound}`);
    return {
      to: token,
      sound,
      title,
      body,
      data: { alertType },
      priority: 'high',
    };
  });

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    const result = await response.json();
    console.log(`Push sent to ${messages.length} token(s)`, result.data?.map((d) => d.status));
  } catch (err) {
    console.error('Push send error:', err.message);
  }
}

// ─── Cities list (static, sourced from Oref GetCitiesMix) ───────────
app.get('/cities', (_req, res) => {
  res.json(CITIES_DATA);
});

// ─── Admin CRUD: sounds ──────────────────────────────────────────────
app.get('/admin/sounds', async (req, res) => {
  const { category } = req.query;
  const { rows } = category
    ? await pool.query('SELECT * FROM sounds WHERE category = $1 ORDER BY category, created_at DESC', [category])
    : await pool.query('SELECT * FROM sounds ORDER BY category, created_at DESC');
  res.json(rows);
});

app.post('/admin/sounds', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  console.log('[POST /admin/sounds] Start — body:', req.body, 'files:', Object.keys(req.files || {}));
  try {
    const { title, category } = req.body;
    if (!title || !category) return res.status(400).json({ error: 'title and category are required' });

    const id = req.body.id || `${category}_${Date.now().toString(36)}`;
    let imageUrl = null;
    let audioUrl = null;

    if (req.files?.image?.[0]) {
      console.log('[POST /admin/sounds] Uploading image to Cloudinary...', req.files.image[0].size, 'bytes');
      imageUrl = await uploadBuffer(req.files.image[0].buffer, 'oref-sounds', 'image');
      console.log('[POST /admin/sounds] Image uploaded:', imageUrl);
    }
    if (req.files?.audio?.[0]) {
      console.log('[POST /admin/sounds] Uploading audio to Cloudinary...', req.files.audio[0].size, 'bytes');
      audioUrl = await uploadBuffer(req.files.audio[0].buffer, 'oref-sounds', 'video');
      console.log('[POST /admin/sounds] Audio uploaded:', audioUrl);
    }

    console.log('[POST /admin/sounds] Inserting into DB...');
    const { rows } = await pool.query(
      'INSERT INTO sounds (id, title, category, image_path, audio_path) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [id, title, category, imageUrl, audioUrl]
    );
    console.log(`[POST /admin/sounds] Done — added "${title}" (${category}) id=${id}`);
    res.json(rows[0]);
  } catch (err) {
    console.error('[POST /admin/sounds] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

const uploadFields = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]);
const maybeUpload = (req, res, next) => {
  if (req.is('multipart/form-data')) return uploadFields(req, res, next);
  next();
};

app.put('/admin/sounds/:id', maybeUpload, async (req, res) => {
  const { id } = req.params;
  const { rows: existing } = await pool.query('SELECT * FROM sounds WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'sound not found' });

  const old = existing[0];
  const title = req.body.title ?? old.title;
  const category = req.body.category ?? old.category;
  const isActive = req.body.is_active !== undefined ? Boolean(Number(req.body.is_active)) : old.is_active;

  let imageUrl = old.image_path;
  let audioUrl = old.audio_path;

  if (req.files?.image?.[0]) {
    imageUrl = await uploadBuffer(req.files.image[0].buffer, 'oref-sounds', 'image');
  }
  if (req.files?.audio?.[0]) {
    audioUrl = await uploadBuffer(req.files.audio[0].buffer, 'oref-sounds', 'video');
  }

  const { rows } = await pool.query(
    'UPDATE sounds SET title = $1, category = $2, image_path = $3, audio_path = $4, is_active = $5 WHERE id = $6 RETURNING *',
    [title, category, imageUrl, audioUrl, isActive, id]
  );
  console.log(`[admin] Updated sound #${id}: "${title}"`);
  res.json(rows[0]);
});

app.delete('/admin/sounds/:id', async (req, res) => {
  const { id } = req.params;
  const { rows: existing } = await pool.query('SELECT * FROM sounds WHERE id = $1', [id]);
  if (!existing[0]) return res.status(404).json({ error: 'sound not found' });

  await pool.query('DELETE FROM sounds WHERE id = $1', [id]);
  console.log(`[admin] Deleted sound #${id}: "${existing[0].title}"`);
  res.json({ success: true });
});

// ─── Public API: sounds by category (for the app) ───────────────────
app.get('/sounds/:category', async (req, res) => {
  const { category } = req.params;
  const { rows } = await pool.query(
    'SELECT id, title, category, image_path, audio_path FROM sounds WHERE category = $1 AND is_active = true ORDER BY created_at DESC',
    [category]
  );

  const sounds = rows.map((r) => ({
    id: r.id,
    name: r.title,
    image: r.image_path || null,
    audio: r.audio_path || null,
  }));
  res.json(sounds);
});

// ─── Feature flags ───────────────────────────────────────────────
app.get('/features', (_req, res) => {
  const features = {
    userSounds: process.env.FEATURE_USER_SOUNDS !== 'false',
    funStats: process.env.FEATURE_FUN_STATS !== 'false',
  };
  console.log('[features] Returning feature flags:', features);
  res.json(features);
});

// ─── User sound upload ──────────────────────────────────────────
app.post('/user-sounds', upload.fields([{ name: 'audio', maxCount: 1 }]), async (req, res) => {
  console.log('[user-sounds] POST /user-sounds — body:', req.body, 'files:', Object.keys(req.files || {}));
  try {
    const { title, pushToken } = req.body;
    if (!title || !pushToken) {
      console.log('[user-sounds] Missing title or pushToken');
      return res.status(400).json({ error: 'title and pushToken are required' });
    }

    const id = `user_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let audioUrl = null;

    if (req.files?.audio?.[0]) {
      console.log('[user-sounds] Uploading audio to Cloudinary...', req.files.audio[0].size, 'bytes');
      audioUrl = await uploadBuffer(req.files.audio[0].buffer, 'oref-user-sounds', 'video');
      console.log('[user-sounds] Audio uploaded:', audioUrl);
    } else {
      console.log('[user-sounds] No audio file provided');
      return res.status(400).json({ error: 'audio file is required' });
    }

    await pool.query(
      'INSERT INTO user_sounds (id, push_token, title, audio_path) VALUES ($1, $2, $3, $4)',
      [id, pushToken, title, audioUrl]
    );
    console.log(`[user-sounds] Saved user sound "${title}" (${id}) for token ${pushToken.slice(0, 10)}...`);

    res.json({ id, title, audio: audioUrl });
  } catch (err) {
    console.error('[user-sounds] Error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/user-sounds/:token', async (req, res) => {
  const { token } = req.params;
  console.log(`[user-sounds] GET /user-sounds/${token.slice(0, 10)}...`);
  try {
    const { rows } = await pool.query(
      'SELECT id, title, audio_path FROM user_sounds WHERE push_token = $1 ORDER BY created_at DESC',
      [token]
    );
    const sounds = rows.map((r) => ({
      id: r.id,
      name: r.title,
      image: null,
      audio: r.audio_path,
      isUserSound: true,
    }));
    console.log(`[user-sounds] Found ${sounds.length} sounds for token`);
    res.json(sounds);
  } catch (err) {
    console.error('[user-sounds] Error fetching user sounds:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/user-sounds/:id', async (req, res) => {
  const { id } = req.params;
  const { pushToken } = req.body;
  console.log(`[user-sounds] DELETE /user-sounds/${id}`);
  try {
    await pool.query('DELETE FROM user_sounds WHERE id = $1 AND push_token = $2', [id, pushToken]);
    console.log(`[user-sounds] Deleted sound ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[user-sounds] Error deleting:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Fun Stats ──────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  const { token, zones } = req.query;
  console.log(`[fun-stats] GET /stats — token=${(token || '').slice(0, 10)}..., zones=${zones}`);
  try {
    // Get all alerts from log
    const { rows: allAlerts } = await pool.query(
      'SELECT alert_type, areas, timestamp FROM alerts_log ORDER BY timestamp DESC'
    );
    console.log(`[fun-stats] Total alerts in DB: ${allAlerts.length}`);

    // Parse user zones
    const userZones = zones ? (Array.isArray(zones) ? zones : zones.split(',')) : [];

    // Filter alerts relevant to user's areas
    const userAlerts = userZones.length > 0
      ? allAlerts.filter((a) => a.areas && a.areas.some((area) => userZones.includes(area)))
      : allAlerts;

    // Weekly user alerts (last 7 days)
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weeklyUserAlerts = userAlerts.filter((a) => new Date(a.timestamp) >= oneWeekAgo).length;

    // Count by hour
    const hourCounts = new Array(24).fill(0);
    for (const a of userAlerts) {
      const hour = new Date(a.timestamp).getHours();
      hourCounts[hour]++;
    }

    // Busiest hour
    const busiestHour = hourCounts.indexOf(Math.max(...hourCounts));

    // Busiest day of week (0=Sunday, 6=Saturday)
    const dayCounts = new Array(7).fill(0);
    for (const a of userAlerts) {
      const day = new Date(a.timestamp).getDay();
      dayCounts[day]++;
    }
    const busiestDay = dayCounts.indexOf(Math.max(...dayCounts));

    // Average hours between consecutive user alerts
    let avgHoursBetweenAlerts = null;
    if (userAlerts.length >= 2) {
      const sorted = userAlerts
        .map((a) => new Date(a.timestamp).getTime())
        .sort((a, b) => a - b);
      let totalGap = 0;
      for (let i = 1; i < sorted.length; i++) {
        totalGap += sorted[i] - sorted[i - 1];
      }
      avgHoursBetweenAlerts = Math.round((totalGap / (sorted.length - 1) / (1000 * 60 * 60)) * 10) / 10;
    }

    const stats = {
      totalAlerts: allAlerts.length,
      userAlerts: userAlerts.length,
      weeklyUserAlerts,
      busiestDay,
      busiestHour,
      avgHoursBetweenAlerts,
      hourCounts,
    };

    console.log(`[stats] Computed stats: userAlerts=${userAlerts.length}, weeklyUserAlerts=${weeklyUserAlerts}`);
    res.json(stats);
  } catch (err) {
    console.error('[fun-stats] Error:', err.stack || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => console.error('UNCAUGHT:', err));
process.on('unhandledRejection', (err) => console.error('UNHANDLED:', err));

(async () => {
  try {
    await initDb();
    // Load existing push tokens from DB
    const { rows } = await pool.query('SELECT token FROM devices');
    for (const row of rows) pushTokens.add(row.token);
    if (rows.length > 0) console.log(`Loaded ${rows.length} push token(s) from DB`);
  } catch (err) {
    console.error('DB init failed (continuing):', err.message);
  }
  app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    try {
      await testOrefConnection();
    } catch (err) {
      console.error('Oref test failed:', err.message);
    }
    console.log('Polling oref every 3s...');
    setInterval(pollOref, POLL_INTERVAL_MS);
  });
})();
