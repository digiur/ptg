#!/usr/bin/env node
// describe-cards.js — add GPT-4o-mini vision descriptions to data/cards.json
// Skips cards that already have vision_description. Writes back after each batch (resumable).
//
// Usage:
//   node scripts/describe-cards.js
//   node scripts/describe-cards.js --limit=100     # only process N cards (testing)
//   node scripts/describe-cards.js --concurrency=20

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
import OpenAI from 'openai';

const CARDS_FILE    = path.resolve('data/cards.json');
const MODEL         = 'gpt-4o-mini';
const MAX_TOKENS    = 80;
const SYSTEM_PROMPT =
  'You are describing MTG card artwork for a fantasy creature-matching system. ' +
  'Given a card name, type line, and art image, write 1-2 sentences describing only the visual content: ' +
  'what creature or character appears, their key physical features, and the mood or setting. ' +
  'Be concise and specific. Do not mention the card name or game mechanics.';

const DEFAULT_CONCURRENCY = 80;  // concurrent requests per batch
const MIN_BATCH_MS = 1000;       // minimum ms per batch → caps at ~4800 RPM at concurrency 80
const MAX_RETRIES = 4;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Shared quota snapshot — updated by whichever request finishes last
const quota = { remainingReqs: null, remainingTokens: null, resetReqs: null };

function parseArgs() {
  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0');
  const concurrency = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? String(DEFAULT_CONCURRENCY));
  const verbose = process.argv.includes('--verbose');
  const dryRun = process.argv.includes('--dry-run');
  return { limit, concurrency, verbose, dryRun };
}

async function describeCard(client, card, retries = 0) {
  if (!card.art_crop_uri) return null;
  try {
    const { data: resp, response } = await client.chat.completions.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: `Card name: ${card.name}\nType: ${card.type_line}` },
            { type: 'image_url', image_url: { url: card.art_crop_uri, detail: 'low' } },
          ],
        },
      ],
    }).withResponse();
    // Capture rate-limit headers for display
    quota.remainingReqs   = response.headers.get('x-ratelimit-remaining-requests') ?? quota.remainingReqs;
    quota.remainingTokens = response.headers.get('x-ratelimit-remaining-tokens')   ?? quota.remainingTokens;
    quota.resetReqs       = response.headers.get('x-ratelimit-reset-requests')      ?? quota.resetReqs;
    return resp.choices[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    const status = err?.status ?? err?.response?.status;
    if ((status === 429 || status === 503) && retries < MAX_RETRIES) {
      const delay = Math.pow(2, retries) * 2000 + Math.random() * 1000;
      await sleep(delay);
      return describeCard(client, card, retries + 1);
    }
    throw err;
  }
}

async function processBatch(client, cards, batch, verbose) {
  await Promise.all(batch.map(async (card) => {
    try {
      const desc = await describeCard(client, card);
      card.vision_description = desc;
      if (verbose) console.log(`    ✓ ${card.name}: ${desc?.slice(0, 80) ?? '(no description)'}`);
    } catch (err) {
      if (verbose) console.log(`    ✗ ${card.name}: ERROR`);
      console.warn(`  WARN: ${card.name} (${card.scryfall_id}): ${err.message}`);
    }
  }));
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local');
    process.exit(1);
  }

  const { limit, concurrency, verbose, dryRun } = parseArgs();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  const todo = cards.filter(c => !c.vision_description && c.art_crop_uri);
  const work = limit > 0 ? todo.slice(0, limit) : todo;

  console.log(`${cards.length.toLocaleString()} total cards, ${work.length.toLocaleString()} need descriptions`);
  if (dryRun) {
    if (verbose) work.forEach(c => console.log(`  - ${c.name} (${c.scryfall_id})`));
    return;
  }
  if (work.length === 0) { console.log('Nothing to do.'); return; }

  let done = 0;
  const batchSize = concurrency;
  const startTime = Date.now();

  for (let i = 0; i < work.length; i += batchSize) {
    const batch = work.slice(i, i + batchSize);
    const batchStart = Date.now();
    await processBatch(client, cards, batch, verbose);
    done += batch.length;

    // Write back every 5 batches (or on the last batch) — resumable
    const batchNum = Math.floor(i / batchSize);
    if (batchNum % 5 === 4 || i + batchSize >= work.length) {
      fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 0));
    }

    // Rate-limit guard: ensure each batch takes at least MIN_BATCH_MS
    const elapsed = Date.now() - batchStart;
    if (elapsed < MIN_BATCH_MS && i + batchSize < work.length) {
      await sleep(MIN_BATCH_MS - elapsed);
    }

    const pct = ((done / work.length) * 100).toFixed(1);
    const totalElapsed = (Date.now() - startTime) / 1000;
    const rate = done / totalElapsed;
    const remaining = work.length - done;
    const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
    const eta = etaSec > 60 ? `${Math.floor(etaSec / 60)}m ${etaSec % 60}s` : `${etaSec}s`;
    const lastName = batch[batch.length - 1].name;
    const quotaStr = quota.remainingReqs !== null
      ? ` — quota: ${quota.remainingReqs} req / ${quota.remainingTokens} tok remaining (resets ${quota.resetReqs})`
      : '';
    console.log(`  ${done.toLocaleString()} / ${work.length.toLocaleString()} (${pct}%) — ${rate.toFixed(1)} cards/s — ETA ${eta} — last: ${lastName}${quotaStr}`);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
