const express = require('express');
const path = require('path');
const multer = require('multer');
const { pool, init: initDb } = require('./db');

const app = express();
app.use(express.json());

// Serve uploaded files and admin UI
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'admin.html')));

// ─── Multer setup for file uploads ──────────────────────────────────
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'uploads'),
  filename: (_req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e6);
    const ext = path.extname(file.originalname);
    cb(null, unique + ext);
  },
});
const upload = multer({ storage });

const PORT = process.env.PORT || 3001;
const OREF_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const POLL_INTERVAL_MS = 3000;

// In-memory stores
const pushTokens = new Set();
let lastAlertId = null;
let wasActive = false; // tracks if previous poll had an active alert

// ─── Register push token ─────────────────────────────────────────────
app.post('/register', (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'token is required' });
  pushTokens.add(token);
  console.log(`Registered token (${pushTokens.size} total)`);
  res.json({ success: true });
});

// ─── Test alert endpoint ─────────────────────────────────────────────
const ALERT_TITLES = {
  active: 'פיקוד העורף 🚨',
  warning: 'התראה מוקדמת ⚠️',
  all_clear: 'סיום אירוע ✅',
};

app.post('/test-alert', async (req, res) => {
  const { alertType = 'active', areas = ['תל אביב'] } = req.body;
  const title = ALERT_TITLES[alertType] || ALERT_TITLES.active;
  const body = areas.join(', ');
  console.log(`Test alert: ${title} → ${body}`);
  await sendPushToAll({ title, body, alertType });
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
        await sendPushToAll({ title, body: 'האיום הוסר, ניתן לחזור לשגרה', alertType: 'all_clear' });
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
        await sendPushToAll({ title, body: 'האיום הוסר, ניתן לחזור לשגרה', alertType: 'all_clear' });
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
    const body = areas.join(', ');

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
async function sendPushToAll({ title, body, alertType }) {
  if (pushTokens.size === 0) {
    console.log('No registered tokens, skipping push');
    return;
  }

  const messages = [...pushTokens].map((token) => ({
    to: token,
    sound: 'default',
    title,
    body,
    data: { alertType },
    priority: 'high',
  }));

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

// ─── Admin CRUD: sounds ──────────────────────────────────────────────
app.get('/admin/sounds', async (req, res) => {
  const { category } = req.query;
  const { rows } = category
    ? await pool.query('SELECT * FROM sounds WHERE category = $1 ORDER BY category, created_at DESC', [category])
    : await pool.query('SELECT * FROM sounds ORDER BY category, created_at DESC');
  res.json(rows);
});

app.post('/admin/sounds', upload.fields([{ name: 'image', maxCount: 1 }, { name: 'audio', maxCount: 1 }]), async (req, res) => {
  const { title, category } = req.body;
  if (!title || !category) return res.status(400).json({ error: 'title and category are required' });

  const id = req.body.id || `${category}_${Date.now().toString(36)}`;
  const imagePath = req.files?.image?.[0]?.filename || null;
  const audioPath = req.files?.audio?.[0]?.filename || null;

  const { rows } = await pool.query(
    'INSERT INTO sounds (id, title, category, image_path, audio_path) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [id, title, category, imagePath, audioPath]
  );
  console.log(`[admin] Added sound: "${title}" (${category})`);
  res.json(rows[0]);
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
  const imagePath = req.files?.image?.[0]?.filename || old.image_path;
  const audioPath = req.files?.audio?.[0]?.filename || old.audio_path;

  const { rows } = await pool.query(
    'UPDATE sounds SET title = $1, category = $2, image_path = $3, audio_path = $4, is_active = $5 WHERE id = $6 RETURNING *',
    [title, category, imagePath, audioPath, isActive, id]
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

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const sounds = rows.map((r) => ({
    id: r.id,
    name: r.title,
    image: r.image_path ? `${baseUrl}/uploads/${r.image_path}` : null,
    audio: r.audio_path ? `${baseUrl}/uploads/${r.audio_path}` : null,
  }));
  res.json(sounds);
});

// ─── Start ───────────────────────────────────────────────────────────
(async () => {
  await initDb();
  app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await testOrefConnection();
    console.log('Polling oref every 3s...');
    setInterval(pollOref, POLL_INTERVAL_MS);
  });
})();
