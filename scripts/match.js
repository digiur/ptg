#!/usr/bin/env node
// match.js — cosine similarity between subjects and cards → data/matches/{id}.json
// Subjects loaded into memory (~1 MB). Cards streamed line-by-line (~107 MB, never fully in memory).
// Output is denormalized: each match entry includes card display fields so the browser
// never needs to load cards.json. Each subject gets its own tiny JSON file so the
// subject page only downloads ~2 KB instead of the full matches corpus.
//
// Usage:
//   node scripts/match.js --types=all             # match all subjects not yet written
//   node scripts/match.js --types=npc,spell       # only (re-)match subjects of these types
//   node scripts/match.js --types=all --force     # recompute all, replacing existing matches
//   node scripts/match.js --top=20               # how many cards per subject (default 20)

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import os from 'os';
import { Worker } from 'worker_threads';

const WORKER_FILE    = path.resolve('scripts/match-worker.js');
const CARD_BATCH_SIZE = 500;

const SUBJECTS_FILE   = path.resolve('data/subjects.json');
const SUBJECTS_NDJSON = path.resolve('data/embeddings/subjects.ndjson');
const CARDS_FILE      = path.resolve('data/cards.json');
const CARDS_NDJSON    = path.resolve('data/embeddings/cards.ndjson');
const MATCHES_DIR     = path.resolve('data/matches');

function parseArgs() {
  const args = process.argv.slice(2);
  const force   = args.includes('--force');
  const dryRun  = args.includes('--dry-run');
  const verbose = args.includes('--verbose');
  const typesArg = args.find(a => a.startsWith('--types='));
  if (!typesArg) {
    console.error('Missing --types. Use --types=all or a comma-separated list of subject types.');
    process.exit(1);
  }
  const raw = typesArg.split('=')[1].split(',');
  const types = raw.includes('all') ? null : raw;
  const top     = parseInt(args.find(a => a.startsWith('--top='))?.split('=')[1] ?? '20');
  return { force, dryRun, verbose, types, top };
}

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMsg = (msg) => { if (msg.type === type) { worker.off('message', onMsg); worker.off('error', onErr); resolve(msg); } };
    const onErr = (err) => { worker.off('message', onMsg); worker.off('error', onErr); reject(err); };
    worker.on('message', onMsg);
    worker.on('error', onErr);
  });
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
  const { force, dryRun, verbose, types, top } = parseArgs();

  const subjects = JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8'));
  const cardsArr = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  const cardsMap = new Map(cardsArr.map(c => [c.scryfall_id, c]));

  fs.mkdirSync(MATCHES_DIR, { recursive: true });

  // Determine which subjects to (re-)match
  let targets = subjects;
  if (types) targets = targets.filter(s => types.includes(s.subject_type));
  if (!force) targets = targets.filter(s => !fs.existsSync(path.join(MATCHES_DIR, `${s.id}.json`)));

  console.log(`${subjects.length.toLocaleString()} total subjects, ${targets.length.toLocaleString()} to match`);
  if (dryRun) {
    if (verbose) targets.forEach(s => console.log(`  - ${s.name} (${s.id})`));
    return;
  }
  if (targets.length === 0) { console.log('Nothing to do. Use --force to recompute.'); return; }

  const targetIds = new Set(targets.map(s => s.id));
  console.log('Loading subject embeddings…');
  const subjectVecs = await loadSubjectEmbeddings(targetIds);

  if (subjectVecs.size === 0) {
    console.error('No subject embeddings found. Run: node scripts/embed.js --types=subjects');
    process.exit(1);
  }
  console.log(`Subject embeddings: ${subjectVecs.size.toLocaleString()} loaded`);

  // Split subjects across workers
  const numWorkers = Math.max(1, os.availableParallelism() - 1);
  const subjectEntries = [...subjectVecs.entries()].map(([id, vec]) => ({ id, embedding: Array.from(vec) }));
  const sliceSize = Math.ceil(subjectEntries.length / numWorkers);
  const slices = Array.from({ length: numWorkers }, (_, i) => subjectEntries.slice(i * sliceSize, (i + 1) * sliceSize)).filter(s => s.length > 0);

  console.log(`Spawning ${slices.length} workers (${os.availableParallelism()} logical cores)…`);
  const workers = slices.map(subjects => new Worker(WORKER_FILE, { workerData: { subjects, top } }));

  // Stream cards and broadcast batches
  console.log('Streaming card embeddings…');
  let cardCount = 0;
  let batch = [];
  const streamStart = Date.now();

  const rl = readline.createInterface({ input: fs.createReadStream(CARDS_NDJSON), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.id || !obj.embedding) continue;

    batch.push({ id: obj.id, embedding: obj.embedding });

    if (batch.length >= CARD_BATCH_SIZE) {
      const b = batch; batch = [];
      workers.forEach(w => w.postMessage({ type: 'batch', cards: b }));
      await Promise.all(workers.map(w => waitFor(w, 'done')));
      cardCount += b.length;
      const elapsed = (Date.now() - streamStart) / 1000;
      console.log(`  Streamed ${cardCount.toLocaleString()} cards — ${(cardCount / elapsed).toFixed(0)}/s`);
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    workers.forEach(w => w.postMessage({ type: 'batch', cards: batch }));
    await Promise.all(workers.map(w => waitFor(w, 'done')));
    cardCount += batch.length;
  }

  console.log(`Streamed ${cardCount.toLocaleString()} card embeddings. Collecting results…`);

  // Finalize all workers and collect results
  workers.forEach(w => w.postMessage({ type: 'finalize' }));
  const resultMsgs = await Promise.all(workers.map(w => waitFor(w, 'results')));

  // Merge topN maps from all workers
  const topN = new Map();
  for (const msg of resultMsgs) {
    for (const [id, heap] of msg.topN) topN.set(id, heap);
  }

  console.log(`Writing ${topN.size.toLocaleString()} match files…`);

  // Write match files
  let matched = 0;
  const writeStart = Date.now();
  for (const [subjectId, heap] of topN) {
    const topMatches = heap.map(m => {
      const card = cardsMap.get(m.scryfall_id);
      return {
        scryfall_id:  m.scryfall_id,
        similarity:   parseFloat(m.similarity.toFixed(4)),
        name:         card?.name ?? '',
        image_uri:    card?.image_uri ?? null,
        art_crop_uri: card?.art_crop_uri ?? null,
        artist:       card?.artist ?? null,
        set_name:     card?.set_name ?? null,
      };
    });
    fs.writeFileSync(path.join(MATCHES_DIR, `${subjectId}.json`), JSON.stringify(topMatches));
    matched++;
    if (verbose) {
      const top1 = topMatches[0];
      const subj = targets.find(s => s.id === subjectId);
      console.log(`  ✓ ${subj?.name ?? subjectId} → ${top1?.name ?? '?'} (${top1?.similarity ?? '?'})`);
    } else if (matched % 500 === 0 || matched === topN.size) {
      const elapsed = (Date.now() - writeStart) / 1000;
      const rate = matched / elapsed;
      const etaSec = rate > 0 ? Math.round((topN.size - matched) / rate) : 0;
      const eta = etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`;
      console.log(`  Writing matches… ${matched.toLocaleString()} / ${topN.size.toLocaleString()} (${((matched/topN.size)*100).toFixed(1)}%) — ${rate.toFixed(0)}/s — ETA ${eta}`);
    }
  }

  console.log(`Done. Matched ${matched.toLocaleString()} subjects → ${MATCHES_DIR}/`);
}

main().catch(err => { console.error(err); process.exit(1); });
