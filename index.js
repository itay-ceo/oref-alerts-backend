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
