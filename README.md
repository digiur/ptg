# Pathfinder the Gathering

Match Pathfinder 2e entities to Magic: The Gathering card art using AI embeddings.

Each Pathfinder creature, spell, item, or hazard is matched to the MTG cards whose art most closely resembles it — based on GPT-4o-mini visual descriptions and cosine similarity of text embeddings.

Static site hosted on GitHub Pages. No server, no database. Everything pre-computed locally and committed as JSON.

---

## How it works

1. **Sync cards** — fetch all ~52K unique MTG artworks from Scryfall
2. **Sync subjects** — fetch Pathfinder 2e entities from the Foundry VTT PF2e repo
3. **Describe cards** — GPT-4o-mini writes a 1-2 sentence visual description of each card's art
4. **Embed** — `text-embedding-3-small` (512d) embeds both the card descriptions and the subject descriptions
5. **Match** — cosine similarity; top 20 most visually similar cards per subject → `data/matches.json`
6. **Browse** — plain HTML site reads the JSON files directly

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

## Script options

| Script | Options |
|---|---|
| `sync-subjects.js` | `--types=npc,spell,equipment,hazard` |
| `describe-cards.js` | `--limit=N`, `--concurrency=N` (default 20) |
| `embed.js` | `--subjects-only`, `--cards-only`, `--types=...`, `--limit=N` |
| `match.js` | `--types=...`, `--force` (recompute existing), `--top=N` (default 20) |

---

## Data files

| File | Committed | Notes |
|---|---|---|
| `data/subjects.json` | yes | All PF2e subjects |
| `data/cards.json` | yes | All MTG cards + vision descriptions |
| `data/matches.json` | yes | Top-20 matches per subject (denormalized) |
| `data/embeddings/subjects.ndjson` | yes | Subject embedding vectors |
| `data/embeddings/cards.ndjson` | **no** | ~107 MB, over GitHub limit — regenerate with `embed.js --cards-only` |

---

## Publishing

GitHub Pages from the root of `main`. After running the pipeline and committing the data files:

```bash
git add data/subjects.json data/cards.json data/matches.json data/embeddings/subjects.ndjson
git commit -m "data: update matches"
git push
```

Enable GitHub Pages in repo Settings → Pages → Source: `main` / `/ (root)`.
