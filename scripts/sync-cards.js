#!/usr/bin/env node
// sync-cards.js — fetch Scryfall unique_artwork bulk data → data/cards.json
//
// Usage:
//   node scripts/sync-cards.js
//   node scripts/sync-cards.js --dry-run    # show what would be downloaded, no write
//   node scripts/sync-cards.js --verbose    # print sample of first 5 cards after write

import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';

const OUT_FILE = path.resolve('data/cards.json');
const USER_AGENT = 'pathfinder-the-gathering/0.1 (https://github.com/digiur/pathfinder-the-gathering)';

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    dryRun:  args.includes('--dry-run'),
    verbose: args.includes('--verbose'),
  };
}

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
  const { dryRun, verbose } = parseArgs();

  console.log('Fetching Scryfall bulk-data index…');
  const meta = await fetchJSON('https://api.scryfall.com/bulk-data');
  const entry = meta.data.find(d => d.type === 'unique_artwork');
  if (!entry) throw new Error('Could not find unique_artwork bulk-data entry');

  const totalMB = (entry.size / 1e6).toFixed(0);
  console.log(`Found: ${entry.name}, ${totalMB} MB, updated ${entry.updated_at?.slice(0, 10) ?? 'unknown'}`);

  if (dryRun) {
    const existingCount = fs.existsSync(OUT_FILE)
      ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')).length.toLocaleString()
      : 'none';
    console.log(`Dry run. Would download: ${entry.download_uri}`);
    console.log(`Existing cards.json: ${existingCount} cards`);
    return;
  }

  fs.mkdirSync('data', { recursive: true });
  console.log(`Downloading ${totalMB} MB…`);

  const tmpFile = OUT_FILE + '.tmp';
  const res = await fetch(entry.download_uri, { headers: { 'User-Agent': USER_AGENT } });
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading bulk data`);

  // Stream with progress reporting — plain newlines, no \r
  let downloaded = 0;
  let lastReported = 0;
  const reportEvery = 10 * 1e6; // every 10 MB
  const progressStream = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.byteLength;
      if (downloaded - lastReported >= reportEvery) {
        lastReported = downloaded;
        console.log(`  ${(downloaded / 1e6).toFixed(0)} / ${totalMB} MB`);
      }
      controller.enqueue(chunk);
    },
  });
  await pipeline(res.body.pipeThrough(progressStream), createWriteStream(tmpFile));
  console.log(`  ${(downloaded / 1e6).toFixed(0)} / ${totalMB} MB — download complete`);

  console.log('Parsing…');
  const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
  fs.unlinkSync(tmpFile);

  const cards = raw.map(mapCard);

  // Preserve existing vision_description values if cards.json already exists
  if (fs.existsSync(OUT_FILE)) {
    console.log('Merging existing vision_description values…');
    const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    const visionMap = new Map(existing.map(c => [c.scryfall_id, c.vision_description]));
    let preserved = 0;
    for (const card of cards) {
      if (visionMap.has(card.scryfall_id) && visionMap.get(card.scryfall_id)) {
        card.vision_description = visionMap.get(card.scryfall_id);
        preserved++;
      }
    }
    console.log(`  ${preserved.toLocaleString()} existing descriptions preserved`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify(cards, null, 0));
  console.log(`Done. ${cards.length.toLocaleString()} cards written → ${OUT_FILE}`);

  if (verbose) {
    console.log('Sample (first 5):');
    cards.slice(0, 5).forEach(c => console.log(`  ${c.name} (${c.set_code})`));
  }
}

main().catch(err => { console.error(err); process.exit(1); });
