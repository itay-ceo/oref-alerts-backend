const fs = require('fs');
const path = require('path');
const db = require('./db');

const ASSETS_ROOT = path.join(__dirname, '..', 'assets', 'sounds');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// All sounds to migrate, matching constants/sounds.ts
const SOUNDS = [
  // warning
  { id: 'biton1', title: 'ביטון 1', category: 'warning', imageFile: 'warning/biton1.jpg', audioFile: 'warning/biton1.mp3' },
  // active
  { id: 'biton2', title: 'ביטון 2', category: 'active', imageFile: 'active/biton2.jpg', audioFile: 'active/biton2.mp3' },
  // all_clear
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
  // Use a clean filename: replace spaces with underscores, lowercase
  const cleanName = path.basename(srcRelative).replace(/\s+/g, '_').toLowerCase();
  const dest = path.join(UPLOADS_DIR, cleanName);
  fs.copyFileSync(src, dest);
  return cleanName;
}

console.log('=== Sound Migration ===\n');

// Ensure uploads dir exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const insert = db.prepare(
  'INSERT OR REPLACE INTO sounds (id, title, category, image_path, audio_path) VALUES (?, ?, ?, ?, ?)'
);

const migrate = db.transaction(() => {
  for (const sound of SOUNDS) {
    console.log(`Migrating: ${sound.id} (${sound.category})`);

    const imagePath = copyFile(sound.imageFile);
    const audioPath = copyFile(sound.audioFile);

    insert.run(sound.id, sound.title, sound.category, imagePath, audioPath);
    console.log(`  → image: ${imagePath || 'NONE'}, audio: ${audioPath || 'NONE'}`);
  }
});

migrate();

// Verify
const count = db.prepare('SELECT COUNT(*) as n FROM sounds').get();
console.log(`\nDone! ${count.n} sounds in database.\n`);

const rows = db.prepare('SELECT id, title, category, image_path, audio_path FROM sounds ORDER BY category').all();
rows.forEach((r) => {
  console.log(`  [${r.category}] ${r.id}: "${r.title}" img=${r.image_path} audio=${r.audio_path}`);
});
