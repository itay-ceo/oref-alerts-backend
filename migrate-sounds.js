require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool, init: initDb } = require('./db');
const { uploadFile } = require('./cloudinary');

const UPLOADS_DIR = path.join(__dirname, 'uploads');

// All sounds to migrate
const SOUNDS = [
  { id: 'biton1', title: 'ביטון 1', category: 'warning', imageFile: 'biton1.jpg', audioFile: 'biton1.mp3' },
  { id: 'biton2', title: 'ביטון 2', category: 'active', imageFile: 'biton2.jpg', audioFile: 'biton2.mp3' },
  { id: 'cant_touch_this', title: "Can't Touch This", category: 'all_clear', imageFile: 'cant_touch_this.jpg', audioFile: 'cant_touch_this.mp3' },
  { id: 'everybody_dance', title: 'Everybody Dance Now', category: 'all_clear', imageFile: 'everybody_dance.jpg', audioFile: 'everybody_dance.mp3' },
  { id: 'hakol_beseder', title: 'הכל יהיה בסדר', category: 'all_clear', imageFile: 'hakol_beseder..jpg', audioFile: 'hakol_beseder.mp3' },
  { id: 'hay', title: 'חי חי חי', category: 'all_clear', imageFile: 'hay.jpg', audioFile: 'hay.mp3' },
  { id: 'ilanit_cut', title: 'הנה ימים באים', category: 'all_clear', imageFile: 'ilanit_cut.jpg', audioFile: 'ilanit_cut.mp3' },
  { id: 'sheket_shalva', title: 'שקט שלווה', category: 'all_clear', imageFile: 'sheket_shalva.jpg', audioFile: 'sheket_shalva.mp3' },
];

async function migrate() {
  console.log('=== Sound Migration (Cloudinary) ===\n');

  await initDb();

  for (const sound of SOUNDS) {
    console.log(`Migrating: ${sound.id} (${sound.category})`);

    let imageUrl = null;
    let audioUrl = null;

    const imgPath = path.join(UPLOADS_DIR, sound.imageFile);
    const audPath = path.join(UPLOADS_DIR, sound.audioFile);

    if (fs.existsSync(imgPath)) {
      imageUrl = await uploadFile(imgPath, 'oref-sounds', 'image');
      console.log(`  image → ${imageUrl}`);
    } else {
      console.warn(`  SKIP image (not found): ${imgPath}`);
    }

    if (fs.existsSync(audPath)) {
      audioUrl = await uploadFile(audPath, 'oref-sounds', 'video');
      console.log(`  audio → ${audioUrl}`);
    } else {
      console.warn(`  SKIP audio (not found): ${audPath}`);
    }

    await pool.query(
      `INSERT INTO sounds (id, title, category, image_path, audio_path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET title = $2, category = $3, image_path = $4, audio_path = $5`,
      [sound.id, sound.title, sound.category, imageUrl, audioUrl]
    );
  }

  const { rows: [{ n }] } = await pool.query('SELECT COUNT(*) as n FROM sounds');
  console.log(`\nDone! ${n} sounds in database.\n`);

  const { rows } = await pool.query('SELECT id, title, category, image_path, audio_path FROM sounds ORDER BY category');
  rows.forEach((r) => {
    console.log(`  [${r.category}] ${r.id}: "${r.title}" img=${r.image_path} audio=${r.audio_path}`);
  });

  await pool.end();
}

migrate().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
