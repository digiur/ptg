// app.js — shared helpers for index.html and subject.html

const _cache = new Map();

export async function fetchJSON(url) {
  if (_cache.has(url)) return _cache.get(url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  const data = await res.json();
  _cache.set(url, data);
  return data;
}

export function getParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}
