#!/usr/bin/env node
// match.js — cosine similarity between subjects and cards → data/matches.json
// Subjects loaded into memory (~1 MB). Cards streamed line-by-line (~107 MB, never fully in memory).
// Output is denormalized: each match entry includes card display fields so the browser
// never needs to load cards.json.
//
// Usage:
//   node scripts/match.js                        # match all subjects not yet in matches.json
//   node scripts/match.js --types=npc,spell      # only (re-)match subjects of these types
//   node scripts/match.js --force                # recompute all, replacing existing matches
//   node scripts/match.js --top=20               # how many cards per subject (default 20)

import fs from 'fs';
import path from 'path';
import readline from 'readline';

const SUBJECTS_FILE   = path.resolve('data/subjects.json');
const SUBJECTS_NDJSON = path.resolve('data/embeddings/subjects.ndjson');
const CARDS_FILE      = path.resolve('data/cards.json');
const CARDS_NDJSON    = path.resolve('data/embeddings/cards.ndjson');
const MATCHES_FILE    = path.resolve('data/matches.json');

function parseArgs() {
  const args = process.argv.slice(2);
  const force   = args.includes('--force');
  const typesArg = args.find(a => a.startsWith('--types='));
  const types   = typesArg ? typesArg.split('=')[1].split(',') : null;
  const top     = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] ?? '20');
  return { force, types, top };
}

function cosine(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

async function loadSubjectEmbeddings(ids) {
  // ids: Set of subject ids to load (null = load all)
  const map = new Map(); // id → Float32Array
  const rl = readline.createInterface({ input: fs.createReadStream(SUBJECTS_NDJSON), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const { id, embedding } = JSON.parse(line);
      if (ids === null || ids.has(id)) {
        map.set(id, new Float32Array(embedding));
      }
    } catch { /* skip */ }
  }
  return map;
}

async function main() {
  const { force, types, top } = parseArgs();

  const subjects = JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8'));
  const cardsArr = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  const cardsMap = new Map(cardsArr.map(c => [c.scryfall_id, c]));

  // Load existing matches
  let matches = {};
  if (fs.existsSync(MATCHES_FILE)) {
    matches = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
  }

  // Determine which subjects to (re-)match
  let targets = subjects;
  if (types) targets = targets.filter(s => types.includes(s.subject_type));
  if (!force) targets = targets.filter(s => !matches[s.id]);

  console.log(`${subjects.length.toLocaleString()} total subjects, ${targets.length.toLocaleString()} to match`);
  if (targets.length === 0) { console.log('Nothing to do. Use --force to recompute.'); return; }

  const targetIds = new Set(targets.map(s => s.id));
  console.log('Loading subject embeddings…');
  const subjectVecs = await loadSubjectEmbeddings(targetIds);

  if (subjectVecs.size === 0) {
    console.error('No subject embeddings found. Run: node scripts/embed.js --subjects-only');
    process.exit(1);
  }

  // Initialize top-N heaps for each subject: Map<subjectId, [{scryfall_id, similarity}]>
  const topN = new Map();
  for (const id of subjectVecs.keys()) topN.set(id, []);

  console.log('Streaming card embeddings…');
  let cardCount = 0;

  const rl = readline.createInterface({ input: fs.createReadStream(CARDS_NDJSON), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let cardVec, cardId;
    try {
      const obj = JSON.parse(line);
      cardId  = obj.id;
      cardVec = new Float32Array(obj.embedding);
    } catch { continue; }

    for (const [subjectId, subjectVec] of subjectVecs) {
      const sim = cosine(subjectVec, cardVec);
      const heap = topN.get(subjectId);
      heap.push({ scryfall_id: cardId, similarity: sim });
      // Keep only top*2 in memory during streaming to avoid unbounded growth;
      // we'll trim to `top` at the end
      if (heap.length > top * 3) {
        heap.sort((a, b) => b.similarity - a.similarity);
        heap.splice(top * 2);
      }
    }

    cardCount++;
    if (cardCount % 10000 === 0) console.log(`  Streamed ${cardCount.toLocaleString()} cards…`);
  }

  console.log(`Streamed ${cardCount.toLocaleString()} card embeddings. Building matches…`);

  // Sort and trim, then denormalize
  let matched = 0;
  for (const [subjectId, heap] of topN) {
    heap.sort((a, b) => b.similarity - a.similarity);
    const top20 = heap.slice(0, top);

    matches[subjectId] = top20.map(m => {
      const card = cardsMap.get(m.scryfall_id);
      return {
        scryfall_id:   m.scryfall_id,
        similarity:    parseFloat(m.similarity.toFixed(4)),
        name:          card?.name ?? '',
        image_uri:     card?.image_uri ?? null,
        art_crop_uri:  card?.art_crop_uri ?? null,
        artist:        card?.artist ?? null,
        set_name:      card?.set_name ?? null,
      };
    });
    matched++;
  }

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(MATCHES_FILE, JSON.stringify(matches, null, 0));
  console.log(`Done. Matched ${matched.toLocaleString()} subjects → ${MATCHES_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
