#!/usr/bin/env node
// sync-subjects.js — fetch PF2e entities → upserts into data/subjects.json
//
// Usage:
//   node scripts/sync-subjects.js                    # default: --types=npc
//   node scripts/sync-subjects.js --types=npc,spell,equipment,hazard
//   node scripts/sync-subjects.js --types=spell

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import crypto from 'crypto';

const REPO_URL  = 'https://github.com/foundryvtt/pf2e.git';
const REPO_DIR  = path.resolve('data/pf2e-repo');
const OUT_FILE  = path.resolve('data/subjects.json');

const SIZE_MAP = {
  tiny: 'Tiny', sm: 'Small', med: 'Medium',
  lg: 'Large', huge: 'Huge', grg: 'Gargantuan',
};

// Which Foundry document types map to which subject_type
const TYPE_MAP = {
  npc:       'creature',
  spell:     'spell',
  equipment: 'item',
  hazard:    'hazard',
};

function parseArgs() {
  const args = process.argv.slice(2);
  const typesArg = args.find(a => a.startsWith('--types='));
  const types = typesArg ? typesArg.replace('--types=', '').split(',') : ['npc'];
  const invalid = types.filter(t => !TYPE_MAP[t]);
  if (invalid.length) {
    console.error(`Unknown types: ${invalid.join(', ')}. Valid: ${Object.keys(TYPE_MAP).join(', ')}`);
    process.exit(1);
  }
  return { types, dryRun: args.includes('--dry-run'), verbose: args.includes('--verbose') };
}

function deterministicId(name, sourceBook) {
  return crypto.createHash('sha256').update(`${name}|${sourceBook}`).digest('hex').slice(0, 36);
}

function stripHtml(str) {
  return (str ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function syncRepo() {
  if (fs.existsSync(path.join(REPO_DIR, '.git'))) {
    console.log('Updating PF2e repo…');
    execSync('git pull --depth=1', { cwd: REPO_DIR, stdio: 'inherit' });
  } else {
    console.log('Cloning PF2e repo (shallow)…');
    fs.mkdirSync(REPO_DIR, { recursive: true });
    execSync(`git clone --depth=1 ${REPO_URL} "${REPO_DIR}"`, { stdio: 'inherit' });
  }
}

function* walkJsonFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJsonFiles(full);
    else if (entry.name.endsWith('.json')) yield full;
  }
}

function mapNpc(data) {
  const sys = data.system ?? {};
  const details = sys.details ?? {};
  const traits = sys.traits ?? {};
  return {
    subject_type: 'creature',
    level:        sys.details?.level?.value ?? sys.level?.value ?? 0,
    size:         SIZE_MAP[traits.size?.value] ?? 'Medium',
    rarity:       traits.rarity?.value ?? 'common',
    traits:       (traits.value ?? []).map(String),
    source_book:  details.source?.value ?? sys.source?.book ?? '',
    description:  stripHtml(details.publicNotes ?? details.privateNotes ?? ''),
    is_npc:       true,
  };
}

function mapSpell(data) {
  const sys = data.system ?? {};
  const traits = sys.traits ?? {};
  return {
    subject_type: 'spell',
    level:        sys.level?.value ?? 0,
    size:         'Medium',
    rarity:       traits.rarity?.value ?? 'common',
    traits:       (traits.value ?? []).map(String),
    source_book:  sys.publication?.title ?? sys.source?.value ?? '',
    description:  stripHtml(sys.description?.value ?? ''),
    is_npc:       false,
  };
}

function mapEquipment(data) {
  const sys = data.system ?? {};
  const traits = sys.traits ?? {};
  return {
    subject_type: 'item',
    level:        sys.level?.value ?? 0,
    size:         'Medium',
    rarity:       traits.rarity?.value ?? 'common',
    traits:       (traits.value ?? []).map(String),
    source_book:  sys.publication?.title ?? sys.source?.value ?? '',
    description:  stripHtml(sys.description?.value ?? ''),
    is_npc:       false,
  };
}

function mapHazard(data) {
  const sys = data.system ?? {};
  const details = sys.details ?? {};
  const traits = sys.traits ?? {};
  return {
    subject_type: 'hazard',
    level:        sys.level?.value ?? 0,
    size:         'Medium',
    rarity:       traits.rarity?.value ?? 'common',
    traits:       (traits.value ?? []).map(String),
    source_book:  details.source?.value ?? sys.source?.book ?? '',
    description:  stripHtml(details.description?.value ?? sys.description?.value ?? ''),
    is_npc:       false,
  };
}

const MAPPERS = { npc: mapNpc, spell: mapSpell, equipment: mapEquipment, hazard: mapHazard };

function parsePacksDir(packsDir, requestedTypes, verbose = false) {
  const subjects = [];
  if (!fs.existsSync(packsDir)) return subjects;

  let filesScanned = 0;
  let lastDir = '';

  for (const file of walkJsonFiles(packsDir)) {
    filesScanned++;

    // Report when entering a new top-level pack subdirectory
    const rel = path.relative(packsDir, file);
    const topDir = rel.split(path.sep)[0];
    if (topDir !== lastDir) {
      lastDir = topDir;
      console.log(`  scanning: ${topDir}`);
    }

    if (filesScanned % 1000 === 0) {
      console.log(`  ${filesScanned.toLocaleString()} files scanned, ${subjects.length.toLocaleString()} found so far`);
    }

    let data;
    try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }

    // Foundry packs can be arrays or single objects
    const entries = Array.isArray(data) ? data : [data];
    for (const entry of entries) {
      const docType = entry.type;
      if (!requestedTypes.includes(docType)) continue;
      const mapper = MAPPERS[docType];
      if (!mapper) continue;

      const name = entry.name?.trim();
      if (!name) continue;

      const mapped = mapper(entry);
      const id = deterministicId(name, mapped.source_book);
      subjects.push({ id, name, ...mapped });
      if (verbose) console.log(`    ✓ ${name} (${mapped.subject_type})`);
    }
  }

  return subjects;
}

async function main() {
  const { types: requestedTypes, dryRun, verbose } = parseArgs();
  console.log(`Syncing types: ${requestedTypes.join(', ')}`);

  syncRepo();

  // Try both known packs layouts
  const packsDir = fs.existsSync(path.join(REPO_DIR, 'packs', 'pf2e'))
    ? path.join(REPO_DIR, 'packs', 'pf2e')
    : path.join(REPO_DIR, 'packs');

  console.log(`Scanning ${packsDir}…`);
  const newSubjects = parsePacksDir(packsDir, requestedTypes, verbose);
  console.log(`Found ${newSubjects.length.toLocaleString()} subjects`);

  if (dryRun) {
    const byCounts = {};
    for (const s of newSubjects) byCounts[s.subject_type] = (byCounts[s.subject_type] ?? 0) + 1;
    console.log('Dry run. Counts by type:');
    for (const [type, count] of Object.entries(byCounts)) {
      console.log(`  ${type}: ${count.toLocaleString()}`);
    }
    if (fs.existsSync(OUT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
      console.log(`Existing subjects.json: ${existing.length.toLocaleString()} entries`);
    }
    return;
  }

  // Upsert into existing subjects.json
  fs.mkdirSync('data', { recursive: true });
  let existing = [];
  if (fs.existsSync(OUT_FILE)) {
    existing = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
  }

  const byId = new Map(existing.map(s => [s.id, s]));
  let added = 0, updated = 0;
  for (const s of newSubjects) {
    if (byId.has(s.id)) updated++;
    else added++;
    byId.set(s.id, s);
  }

  const merged = Array.from(byId.values());
  fs.writeFileSync(OUT_FILE, JSON.stringify(merged, null, 0));
  console.log(`Done. ${added} added, ${updated} updated. Total: ${merged.length.toLocaleString()} subjects → ${OUT_FILE}`);
}

main().catch(err => { console.error(err); process.exit(1); });
