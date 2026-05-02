// match-worker.js — worker thread for parallel cosine similarity matching
// Spawned by match.js. Receives a slice of subject embeddings via workerData,
// then processes card batches sent by the main thread.
//
// Message protocol (main → worker):
//   { type: 'batch', cards: [{id, embedding}] }  → run cosine, reply { type: 'done' }
//   { type: 'finalize' }                          → trim heaps, reply { type: 'results', topN }, exit
//
// workerData: { subjects: [{id, embedding}], top }

import { workerData, parentPort } from 'worker_threads';

const { subjects, top } = workerData;

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

// Build Float32Arrays and heaps from the subject slice
const subjectVecs = subjects.map(s => ({ id: s.id, vec: new Float32Array(s.embedding) }));
const topN = new Map(subjectVecs.map(s => [s.id, []]));
const trimAt = top * 3;

parentPort.on('message', (msg) => {
  if (msg.type === 'batch') {
    const cards = msg.cards; // [{id, embedding}]
    for (const card of cards) {
      const cardVec = new Float32Array(card.embedding);
      for (const { id, vec } of subjectVecs) {
        const sim = cosine(vec, cardVec);
        const heap = topN.get(id);
        heap.push({ scryfall_id: card.id, similarity: sim });
        if (heap.length > trimAt) {
          heap.sort((a, b) => b.similarity - a.similarity);
          heap.splice(top * 2);
        }
      }
    }
    parentPort.postMessage({ type: 'done' });

  } else if (msg.type === 'finalize') {
    const results = [];
    for (const [id, heap] of topN) {
      heap.sort((a, b) => b.similarity - a.similarity);
      results.push([id, heap.slice(0, top)]);
    }
    parentPort.postMessage({ type: 'results', topN: results });
    process.exit(0);
  }
});
