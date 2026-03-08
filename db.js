const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const SEED_SOUNDS = [
  { id: 'biton1', title: 'ביטון 1', category: 'warning', image_path: 'biton1.jpg', audio_path: 'biton1.mp3' },
  { id: 'biton2', title: 'ביטון 2', category: 'active', image_path: 'biton2.jpg', audio_path: 'biton2.mp3' },
  { id: 'cant_touch_this', title: "Can't Touch This", category: 'all_clear', image_path: 'cant_touch_this.jpg', audio_path: 'cant_touch_this.mp3' },
  { id: 'everybody_dance', title: 'Everybody Dance Now', category: 'all_clear', image_path: 'everybody_dance.jpg', audio_path: 'everybody_dance.mp3' },
  { id: 'hakol_beseder', title: 'הכל יהיה בסדר', category: 'all_clear', image_path: 'hakol_beseder..jpg', audio_path: 'hakol_beseder.mp3' },
  { id: 'hay', title: 'חי חי חי', category: 'all_clear', image_path: 'hay.jpg', audio_path: 'hay.mp3' },
  { id: 'ilanit_cut', title: 'הנה ימים באים', category: 'all_clear', image_path: 'ilanit_cut.jpg', audio_path: 'ilanit_cut.mp3' },
  { id: 'sheket_shalva', title: 'שקט שלווה', category: 'all_clear', image_path: 'sheket_shalva.jpg', audio_path: 'sheket_shalva.mp3' },
];

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sounds (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('warning', 'active', 'all_clear')),
      image_path TEXT,
      audio_path TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('DB: sounds table ready');

  // Auto-seed if empty
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*) AS n FROM sounds');
  if (Number(n) === 0) {
    console.log('DB: table empty — seeding default sounds...');
    for (const s of SEED_SOUNDS) {
      await pool.query(
        'INSERT INTO sounds (id, title, category, image_path, audio_path) VALUES ($1, $2, $3, $4, $5)',
        [s.id, s.title, s.category, s.image_path, s.audio_path]
      );
    }
    console.log(`DB: seeded ${SEED_SOUNDS.length} sounds`);
  } else {
    console.log(`DB: ${n} sounds already in table`);
  }
}

module.exports = { pool, init };
