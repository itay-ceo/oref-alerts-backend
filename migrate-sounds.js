const fs = require('fs');
const path = require('path');
const { pool, init: initDb } = require('./db');

const ASSETS_ROOT = path.join(__dirname, '..', 'assets', 'sounds');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// All sounds to migrate, matching constants/sounds.ts
const SOUNDS = [
  { id: 'biton1', title: 'ביטון 1', category: 'warning', imageFile: 'warning/biton1.jpg', audioFile: 'warning/biton1.mp3' },
  { id: 'biton2', title: 'ביטון 2', category: 'active', imageFile: 'active/biton2.jpg', audioFile: 'active/biton2.mp3' },
  { id: 'cant_touch_this', title: "Can't Touch This", category: 'all_clear', imageFile: 'all_clear/cant touch this.jpg', audioFile: 'all_clear/cant touch this.mp3' },
  { id: 'everybody_dance', title: 'Everybody Dance Now', category: 'all_clear', imageFile: 'all_clear/everybody dance.jpg', audioFile: 'all_clear/everybody dance.mp3' },
  { id: 'hakol_beseder', title: 'הכל יהיה בסדר', category: 'all_clear', imageFile: 'all_clear/hakol beseder..jpg', audioFile: 'all_clear/hakol beseder.mp3' },
  { id: 'hay', title: 'חי חי חי', category: 'all_clear', imageFile: 'all_clear/hay.jpg', audioFile: 'all_clear/Hay.mp3' },
  { id: 'ilanit_cut', title: 'הנה ימים באים', category: 'all_clear', imageFile: 'all_clear/ilanit_cut.jpg', audioFile: 'all_clear/ilanit_cut.mp3' },
  { id: 'sheket_shalva', title: 'שקט שלווה', category: 'all_clear', imageFile: 'all_clear/Sheket Shalva.jpg', audioFile: 'all_clear/Sheket Shalva.mp3' },
];

function copyFile(srcRelative) {
  const src = path.join(ASSETS_ROOT, srcRelative);
  if (!fs.existsSync(src)) {
    console.warn(`  SKIP (not found): ${src}`);
    return null;
  }
  const cleanName = path.basename(srcRelative).replace(/\s+/g, '_').toLowerCase();
  const dest = path.join(UPLOADS_DIR, cleanName);
  fs.copyFileSync(src, dest);
  return cleanName;
}

async function migrate() {
  console.log('=== Sound Migration ===\n');

  await initDb();

  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }

  for (const sound of SOUNDS) {
    console.log(`Migrating: ${sound.id} (${sound.category})`);
    const imagePath = copyFile(sound.imageFile);
    const audioPath = copyFile(sound.audioFile);

    await pool.query(
      `INSERT INTO sounds (id, title, category, image_path, audio_path)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET title = $2, category = $3, image_path = $4, audio_path = $5`,
      [sound.id, sound.title, sound.category, imagePath, audioPath]
    );
    console.log(`  → image: ${imagePath || 'NONE'}, audio: ${audioPath || 'NONE'}`);
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
