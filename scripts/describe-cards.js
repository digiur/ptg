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
import 'dotenv/config';
import OpenAI from 'openai';

const CARDS_FILE    = path.resolve('data/cards.json');
const MODEL         = 'gpt-4o-mini';
const MAX_TOKENS    = 80;
const SYSTEM_PROMPT =
  'You are describing MTG card artwork for a fantasy creature-matching system. ' +
  'Given a card name, type line, and art image, write 1-2 sentences describing only the visual content: ' +
  'what creature or character appears, their key physical features, and the mood or setting. ' +
  'Be concise and specific. Do not mention the card name or game mechanics.';

function parseArgs() {
  const limit = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '0');
  const concurrency = parseInt(process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] ?? '20');
  return { limit, concurrency };
}

async function describeCard(client, card) {
  if (!card.art_crop_uri) return null;
  const resp = await client.chat.completions.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Card name: ${card.name}\nType: ${card.type_line}`,
          },
          {
            type: 'image_url',
            image_url: { url: card.art_crop_uri, detail: 'low' },
          },
        ],
      },
    ],
  });
  return resp.choices[0]?.message?.content?.trim() ?? null;
}

async function processBatch(client, cards, batch) {
  await Promise.all(batch.map(async (card) => {
    try {
      const desc = await describeCard(client, card);
      card.vision_description = desc;
    } catch (err) {
      console.warn(`  WARN: ${card.name} (${card.scryfall_id}): ${err.message}`);
      // leave vision_description as null — will retry on next run
    }
  }));
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY in .env.local');
    process.exit(1);
  }

  const { limit, concurrency } = parseArgs();
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const cards = JSON.parse(fs.readFileSync(CARDS_FILE, 'utf8'));
  const todo = cards.filter(c => !c.vision_description && c.art_crop_uri);
  const work = limit > 0 ? todo.slice(0, limit) : todo;

  console.log(`${cards.length.toLocaleString()} total cards, ${work.length.toLocaleString()} need descriptions`);
  if (work.length === 0) { console.log('Nothing to do.'); return; }

  let done = 0;
  const batchSize = concurrency;

  for (let i = 0; i < work.length; i += batchSize) {
    const batch = work.slice(i, i + batchSize);
    await processBatch(client, cards, batch);
    done += batch.length;

    // Write back after every batch — resumable
    fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 0));
    const pct = ((done / work.length) * 100).toFixed(1);
    console.log(`  ${done.toLocaleString()} / ${work.length.toLocaleString()} (${pct}%)`);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
