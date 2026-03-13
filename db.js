const path = require('path');
const fs = require('fs');
const { Pool } = require('pg');
const { uploadFile } = require('./cloudinary');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

const SEED_SOUNDS = [
  { id: 'biton1', title: 'ביטון 1', category: 'warning', imageFile: 'biton1.jpg', audioFile: 'biton1.mp3' },
  { id: 'biton2', title: 'ביטון 2', category: 'active', imageFile: 'biton2.jpg', audioFile: 'biton2.mp3' },
  { id: 'cant_touch_this', title: "Can't Touch This", category: 'all_clear', imageFile: 'cant_touch_this.jpg', audioFile: 'cant_touch_this.mp3' },
  { id: 'everybody_dance', title: 'Everybody Dance Now', category: 'all_clear', imageFile: 'everybody_dance.jpg', audioFile: 'everybody_dance.mp3' },
  { id: 'hakol_beseder', title: 'הכל יהיה בסדר', category: 'all_clear', imageFile: 'hakol_beseder..jpg', audioFile: 'hakol_beseder.mp3' },
  { id: 'hay', title: 'חי חי חי', category: 'all_clear', imageFile: 'hay.jpg', audioFile: 'hay.mp3' },
  { id: 'ilanit_cut', title: 'הנה ימים באים', category: 'all_clear', imageFile: 'ilanit_cut.jpg', audioFile: 'ilanit_cut.mp3' },
  { id: 'sheket_shalva', title: 'שקט שלווה', category: 'all_clear', imageFile: 'sheket_shalva.jpg', audioFile: 'sheket_shalva.mp3' },
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS devices (
      token TEXT PRIMARY KEY,
      warning_sound TEXT,
      active_sound TEXT,
      all_clear_sound TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('DB: devices table ready');

  // Auto-seed if empty
  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*) AS n FROM sounds');
  if (Number(n) === 0) {
    console.log('DB: table empty — seeding default sounds via Cloudinary...');
    const uploadsDir = path.join(__dirname, 'uploads');

    try {
      for (const s of SEED_SOUNDS) {
        let imageUrl = null;
        let audioUrl = null;

        const imgPath = path.join(uploadsDir, s.imageFile);
        const audPath = path.join(uploadsDir, s.audioFile);

        if (fs.existsSync(imgPath)) {
          imageUrl = await uploadFile(imgPath, 'oref-sounds', 'image');
          console.log(`  ${s.id} image → ${imageUrl}`);
        }
        if (fs.existsSync(audPath)) {
          audioUrl = await uploadFile(audPath, 'oref-sounds', 'video');
          console.log(`  ${s.id} audio → ${audioUrl}`);
        }

        await pool.query(
          'INSERT INTO sounds (id, title, category, image_path, audio_path) VALUES ($1, $2, $3, $4, $5)',
          [s.id, s.title, s.category, imageUrl, audioUrl]
        );
      }
      console.log(`DB: seeded ${SEED_SOUNDS.length} sounds`);
    } catch (err) {
      console.error('DB: seed failed (server will continue):', err.message);
    }
  } else {
    console.log(`DB: ${n} sounds already in table`);
  }
}

module.exports = { pool, init };
