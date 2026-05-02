# Pathfinder the Gathering

Match Pathfinder 2e entities to Magic: The Gathering card art using AI embeddings.

Each Pathfinder creature, spell, item, or hazard is matched to the MTG cards whose art most closely resembles it — based on GPT-4o-mini visual descriptions and cosine similarity of text embeddings.

---

## Setup

```bash
npm install
```

Create `.env.local` in the project root:

```
OPENAI_API_KEY=sk-proj-...
```

---

## Pipeline

Run these in order the first time. Each step is resumable — re-running skips already-completed work.

```bash
# 1. Fetch all MTG cards from Scryfall (~52K cards, ~30 MB)
node scripts/sync-cards.js

# 2. Fetch PF2e subjects (default: NPCs/creatures only)
node scripts/sync-subjects.js --types=npc

# 3. Generate AI visual descriptions for each card (~2 hrs, ~$5-10)
node scripts/describe-cards.js

# 4. Generate embeddings for subjects + cards (~20 min, ~$0.02)
node scripts/embed.js

# 5. Compute top-20 matches per subject (~1-5 min)
node scripts/match.js
```

Then open `index.html` in a browser (or `npx serve .`).

---

## Adding more entity types later

Each type is independent. Adding spells doesn't touch NPC data:

```bash
node scripts/sync-subjects.js --types=spell
node scripts/embed.js --subjects-only --types=spell
node scripts/match.js --types=spell
```

Supported types: `npc` (creature), `spell`, `equipment` (item), `hazard`

---

## Script reference

### `sync-cards.js`
Fetches all unique MTG artworks from Scryfall and writes `data/cards.json`. Safe to re-run — preserves existing `vision_description` values.

| Flag | Default | Description |
|---|---|---|
| `--dry-run` | off | Fetch the bulk-data index, print filename/size/URL and existing card count, then exit without downloading |
| `--verbose` | off | After writing, print the first 5 card names |

```bash
node scripts/sync-cards.js --dry-run
node scripts/sync-cards.js
```

### `sync-subjects.js`
Fetches PF2e entities from the local `data/pf2e-repo/` clone and writes `data/subjects.json`.

| Flag | Default | Description |
|---|---|---|
| `--types=<list>` | `npc` | Comma-separated entity types to include. Supported: `npc`, `spell`, `equipment`, `hazard` |
| `--dry-run` | off | Scan repo and print counts by type without writing; add `--verbose` to list every subject |
| `--verbose` | off | Print a `✓ name (type)` line per subject as it is found |

```bash
node scripts/sync-subjects.js --dry-run
node scripts/sync-subjects.js --types=npc,spell
```

> **Troubleshooting:** if `sync-subjects.js` fails with `fatal: Not possible to fast-forward`, the shallow clone has diverged from the remote. Fix with:
> ```bash
> cd data/pf2e-repo && git fetch --depth=1 origin HEAD && git reset --hard FETCH_HEAD
> ```

### `describe-cards.js`
Calls GPT-4o-mini vision on each card's art crop and writes a short visual description back into `data/cards.json`. Resumable — skips cards that already have a description.

| Flag | Default | Description |
|---|---|---|
| `--limit=N` | none | Stop after N cards (useful for testing) |
| `--verbose` | off | Print a `✓` line per card as it completes |
| `--dry-run` | off | Print count of cards that need describing and exit; add `--verbose` to list them |

```bash
node scripts/describe-cards.js --dry-run --verbose
node scripts/describe-cards.js --limit=50 --verbose
node scripts/describe-cards.js                      # full run (~2 hrs, ~$5–10)
```

### `embed.js`
Generates `text-embedding-3-small` (512d) embeddings for subjects and/or cards. Writes to `data/embeddings/subjects.ndjson` and `data/embeddings/cards.ndjson` — **does not modify `data/subjects.json` or `data/cards.json`**. Resumable — skips entries whose input text hash hasn't changed.

| Flag | Default | Description |
|---|---|---|
| `--subjects-only` | off | Only embed subjects |
| `--cards-only` | off | Only embed cards |
| `--types=<list>` | all | With `--subjects-only`, restrict to these subject types |
| `--limit=N` | none | Stop after N items per target (testing) |
| `--verbose` | off | Print a `✓` line per item |
| `--dry-run` | off | Print counts and exit; add `--verbose` to list items |

```bash
node scripts/embed.js --dry-run
node scripts/embed.js --subjects-only --types=spell
node scripts/embed.js --cards-only
node scripts/embed.js                               # embed everything (~20 min, ~$0.02)
```

### `match.js`
Computes cosine similarity between subject and card embeddings. Writes one `data/matches/{id}.json` per subject. Skips subjects that already have a match file unless `--force` is passed.

| Flag | Default | Description |
|---|---|---|
| `--force` | off | Recompute and overwrite all existing match files |
| `--types=<list>` | all | Only match subjects of these types |
| `--top=N` | `20` | Number of top card matches to store per subject |
| `--verbose` | off | Print `✓ Subject → Card (score)` for each subject written |
| `--dry-run` | off | Print counts and exit; add `--verbose` to list subjects |

```bash
node scripts/match.js --dry-run
node scripts/match.js --types=spell                 # only newly-added spell subjects
node scripts/match.js --force                       # recompute everything (~5–20 min)
```

---

## Data files

| File | Committed | Notes |
|---|---|---|
| `data/subjects.json` | yes | All PF2e subjects |
| `data/cards.json` | **no** | ~52K cards + vision descriptions; regenerate with `sync-cards.js` + `describe-cards.js` |
| `data/matches/{id}.json` | yes | One file per subject; top-20 matching cards (denormalized) |
| `data/embeddings/subjects.ndjson` | **no** | Subject embedding vectors; regenerate with `embed.js --subjects-only` |
| `data/embeddings/cards.ndjson` | **no** | ~107 MB, over GitHub limit; regenerate with `embed.js --cards-only` |

---

## Publishing

GitHub Pages from the root of `main`. After running the pipeline and committing the data files:

```bash
git add data/subjects.json data/matches/
git commit -m "data: update matches"
git push
```

Enable GitHub Pages in repo Settings → Pages → Source: `main` / `/ (root)`.
