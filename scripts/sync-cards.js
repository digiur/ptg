#!/usr/bin/env node
// sync-cards.js — fetch Scryfall unique_artwork bulk data → data/cards.json
// Usage: node scripts/sync-cards.js

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const OUT_FILE = path.resolve('data/cards.json');
const USER_AGENT = 'pathfinder-the-gathering/0.1 (https://github.com/digiur/pathfinder-the-gathering)';

async function fetchJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.json();
}

function mapCard(c) {
  // Multi-face cards: fall back to first face for per-face fields
  const face = c.card_faces?.[0] ?? {};
  const imageUris = c.image_uris ?? face.image_uris ?? null;
  return {
    scryfall_id:       c.id,
    name:              c.name,
    type_line:         c.type_line ?? face.type_line ?? '',
    flavor_text:       c.flavor_text ?? face.flavor_text ?? null,
    artist:            c.artist ?? face.artist ?? null,
    image_uri:         imageUris?.normal ?? null,
    art_crop_uri:      imageUris?.art_crop ?? null,
    set_code:          c.set,
    set_name:          c.set_name,
    released_at:       c.released_at,
    colors:            c.colors ?? face.colors ?? [],
    color_identity:    c.color_identity ?? [],
    subtypes:          (c.type_line ?? face.type_line ?? '').split('—')[1]?.trim().split(' ').filter(Boolean) ?? [],
    vision_description: null,
  };
}

async function main() {
  fs.mkdirSync('data', { recursive: true });

  console.log('Fetching Scryfall bulk-data index…');
  const meta = await fetchJSON('https://api.scryfall.com/bulk-data');
  const entry = meta.data.find(d => d.type === 'unique_artwork');
  if (!entry) throw new Error('Could not find unique_artwork bulk-data entry');

  const totalMB = (entry.size / 1e6).toFixed(0);
  console.log(`Downloading ${entry.name} (${totalMB} MB)…`);

  const tmpFile = OUT_FILE + '.tmp';
  const res = await fetch(entry.download_uri, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading bulk data`);

  // Stream with progress reporting
  let downloaded = 0;
  let lastReported = 0;
  const reportEvery = 10 * 1e6; // every 10 MB
  const progressStream = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.byteLength;
      if (downloaded - lastReported >= reportEvery) {
        lastReported = downloaded;
        process.stdout.write(`  ${(downloaded / 1e6).toFixed(0)} / ${totalMB} MB\r`);
      }
      controller.enqueue(chunk);
    },
    flush() { process.stdout.write('\n'); }
  });
  await pipeline(res.body.pipeThrough(progressStream), createWriteStream(tmpFile));

  console.log('Parsing…');
  const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  fs.unlinkSync(tmpFile);

  const cards = raw.map(mapCard);

  // Preserve existing vision_description values if cards.json already exists
  if (fs.existsSync(OUT_FILE)) {
    console.log('Merging existing vision_description values…');
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    const visionMap = new Map(existing.map(c => [c.scryfall_id, c.vision_description]));
    for (const card of cards) {
      if (visionMap.has(card.scryfall_id)) {
        card.vision_description = visionMap.get(card.scryfall_id);
      }
    }
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(cards, null, 0));
  console.log(`Done. Wrote ${cards.length.toLocaleString()} cards to ${OUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
