#!/usr/bin/env node
// embed.js — generate embeddings for subjects and/or cards → data/embeddings/*.ndjson
// Resumable: stores {id, hash, embedding} per line; skips entries whose text hash hasn't changed.
//
// Usage:
//   node scripts/embed.js --types=all              # embed both subjects and cards
//   node scripts/embed.js --types=subjects         # all subjects
//   node scripts/embed.js --types=cards            # all cards
//   node scripts/embed.js --types=npc,spell        # only subjects of these subject_types
//   node scripts/embed.js --types=subjects --limit=50  # testing

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import OpenAI from 'openai';

const MODEL      = 'text-embedding-3-small';
const DIMENSIONS = 512;
const BATCH_SIZE = 100;

const SUBJECTS_FILE     = path.resolve('data/subjects.json');
const CARDS_FILE        = path.resolve('data/cards.json');
const EMBEDDINGS_DIR    = path.resolve('data/embeddings');
const SUBJECTS_NDJSON   = path.join(EMBEDDINGS_DIR, 'subjects.ndjson');
const CARDS_NDJSON      = path.join(EMBEDDINGS_DIR, 'cards.ndjson');

function parseArgs() {
  const args = process.argv.slice(2);
  const typesArg = args.find(a => a.startsWith('--types='));
  if (!typesArg) {
    console.error('Missing --types. Use --types=all, --types=subjects, --types=cards, or a comma-separated list of subject types.');
    process.exit(1);
  }
  const raw = typesArg.split('=')[1].split(',');
  const limit   = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0');
  const verbose = args.includes('--verbose');
  const dryRun  = args.includes('--dry-run');

  let doSubjects, doCards, subjectTypeFilter;
  if (raw.includes('all')) {
    doSubjects = true; doCards = true; subjectTypeFilter = null;
  } else if (raw.includes('subjects')) {
    doSubjects = true; doCards = false; subjectTypeFilter = null;
  } else if (raw.includes('cards')) {
    doSubjects = false; doCards = true; subjectTypeFilter = null;
  } else {
    doSubjects = true; doCards = false; subjectTypeFilter = raw;
  }

  return { doSubjects, doCards, subjectTypeFilter, limit, verbose, dryRun };
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function loadExistingHashes(ndjsonPath) {
  const map = new Map(); // id → hash
  if (!fs.existsSync(ndjsonPath)) return map;
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const { id, hash } = JSON.parse(line);
      if (id && hash) map.set(id, hash);
    } catch { /* skip malformed lines */ }
  }
  return map;
}

async function embedBatch(client, texts) {
  const resp = await client.embeddings.create({
    model: MODEL,
    dimensions: DIMENSIONS,
    input: texts,
  });
  return resp.data.map(d => d.embedding);
}

async function embedItems(client, items, ndjsonPath, opts = {}) {
  const { limit = 0, verbose = false } = opts;
  fs.mkdirSync(EMBEDDINGS_DIR, { recursive: true });

  const existing = await loadExistingHashes(ndjsonPath);
  const todo = items.filter(({ id, text }) => {
    const h = sha256(text);
    return existing.get(id) !== h;
  });

  const work = limit > 0 ? todo.slice(0, limit) : todo;
  console.log(`  ${items.length.toLocaleString()} total, ${work.length.toLocaleString()} to embed`);
  if (work.length === 0) return;

  // Re-write the ndjson: carry forward unchanged entries, replace changed ones
  // Strategy: load all existing into a Map, merge new embeddings, write fresh
  const allEmbeddings = new Map();

  // Load existing embeddings
  if (fs.existsSync(ndjsonPath)) {
    const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.id) allEmbeddings.set(obj.id, obj);
      } catch { /* skip */ }
    }
  }

  let done = 0;
  const startTime = Date.now();
  for (let i = 0; i < work.length; i += BATCH_SIZE) {
    const batch = work.slice(i, i + BATCH_SIZE);
    const texts = batch.map(b => b.text);
    if (verbose) batch.forEach(b => console.log(`    → ${b.name ?? b.id}`));
    const vectors = await embedBatch(client, texts);
    for (let j = 0; j < batch.length; j++) {
      const { id, text } = batch[j];
      allEmbeddings.set(id, { id, hash: sha256(text), embedding: vectors[j] });
    }
    done += batch.length;
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = done / elapsed;
    const etaSec = rate > 0 ? Math.round((work.length - done) / rate) : 0;
    const eta = etaSec > 60 ? `${Math.floor(etaSec/60)}m ${etaSec%60}s` : `${etaSec}s`;
    console.log(`  ${done.toLocaleString()} / ${work.length.toLocaleString()} (${((done/work.length)*100).toFixed(1)}%) — ${rate.toFixed(1)}/s — ETA ${eta}`);
  }

  // Write fresh ndjson
  const out = fs.createWriteStream(ndjsonPath);
  for (const obj of allEmbeddings.values()) {
    out.write(JSON.stringify(obj) + '\n');
  }
  await new Promise((res, rej) => { out.end(); out.on('finish', res); out.on('error', rej); });
  console.log(`  Wrote ${allEmbeddings.size.toLocaleString()} entries → ${ndjsonPath}`);
}

function subjectText(s) {
  return [s.name, s.subject_type, s.size, (s.traits ?? []).join(', '), s.description]
    .filter(Boolean).join('. ').slice(0, 2000);
}

function cardText(c) {
  return [c.name, c.type_line, c.flavor_text, c.vision_description]
    .filter(Boolean).join('. ').slice(0, 2000);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local');
    process.exit(1);
  }

  const { doSubjects, doCards, subjectTypeFilter, limit, verbose, dryRun } = parseArgs();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  if (doSubjects) {
    console.log('Embedding subjects…');
    let subjects = JSON.parse(fs.readFileSync(SUBJECTS_FILE, 'utf8'));
    if (subjectTypeFilter) subjects = subjects.filter(s => subjectTypeFilter.includes(s.subject_type));
    const items = subjects.map(s => ({ id: s.id, name: s.name, text: subjectText(s) }));
    if (dryRun) {
      const existing = await loadExistingHashes(SUBJECTS_NDJSON);
      const toEmbed = items.filter(({ id, text }) => existing.get(id) !== sha256(text));
      console.log(`  ${items.length.toLocaleString()} total, ${toEmbed.length.toLocaleString()} to embed (dry run — no API calls)`);
      if (verbose) toEmbed.forEach(it => console.log(`    ✓ ${it.name}`));
    } else {
      await embedItems(client, items, SUBJECTS_NDJSON, { limit, verbose });
    }
  }

  if (doCards) {
    console.log('Embedding cards…');
    const cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
    const items = cards
      .filter(c => c.vision_description) // only cards with descriptions
      .map(c => ({ id: c.scryfall_id, name: c.name, text: cardText(c) }));
    if (dryRun) {
      const existing = await loadExistingHashes(CARDS_NDJSON);
      const toEmbed = items.filter(({ id, text }) => existing.get(id) !== sha256(text));
      console.log(`  ${items.length.toLocaleString()} total, ${toEmbed.length.toLocaleString()} to embed (dry run — no API calls)`);
      if (verbose) toEmbed.forEach(it => console.log(`    ✓ ${it.name}`));
    } else {
      await embedItems(client, items, CARDS_NDJSON, { limit, verbose });
    }
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
