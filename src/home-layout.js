'use strict';
/* Today page card layout — which card sits in which column, and in what order. Pure logic: no DOM.
   Loaded by the renderer (script tag → window.PerflwHomeLayout) and by the tests (require).

   A layout is { main: [ids], side: [ids] }. Every known card appears exactly once.
   The main column is a two-column grid: wide cards (Plan, Automate) always take the full row;
   other cards share a row in pairs, and a card left without a partner takes the full row. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PerflwHomeLayout = factory();
})(globalThis, function () {

const CARDS = Object.freeze(['plan', 'learn', 'create', 'automate', 'todo', 'routine']);
const ZONES = Object.freeze(['main', 'side']);
const DEFAULT = Object.freeze({ main: Object.freeze(['plan', 'learn', 'create', 'automate']), side: Object.freeze(['todo', 'routine']) });
const WIDE = new Set(['plan', 'automate']);

const homeZone = id => (DEFAULT.side.includes(id) ? 'side' : 'main');

/* Any stored value → a valid layout. Unknown ids and repeats are dropped (the first place wins);
   cards that are missing return at the end of their default column. */
function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { main: [...DEFAULT.main], side: [...DEFAULT.side] };
  const seen = new Set();
  const out = { main: [], side: [] };
  for (const zone of ZONES) {
    const list = Array.isArray(raw[zone]) ? raw[zone] : [];
    for (const id of list) {
      if (typeof id !== 'string' || !CARDS.includes(id) || seen.has(id)) continue;
      seen.add(id); out[zone].push(id);
    }
  }
  for (const id of CARDS) if (!seen.has(id)) out[homeZone(id)].push(id);
  return out;
}

/* Moves one card to a column and position (index within that column, after the card is taken out). */
function move(layout, id, zone, index) {
  const base = normalize(layout);
  if (!CARDS.includes(id) || !ZONES.includes(zone)) return base;
  const next = { main: base.main.filter(x => x !== id), side: base.side.filter(x => x !== id) };
  const target = next[zone];
  const at = Math.max(0, Math.min(target.length, Number.isFinite(index) ? Math.trunc(index) : target.length));
  target.splice(at, 0, id);
  return next;
}

function isDefault(layout) {
  const l = normalize(layout);
  return ZONES.every(zone => l[zone].length === DEFAULT[zone].length && l[zone].every((id, i) => id === DEFAULT[zone][i]));
}

/* The main-column cards that take a full row: wide cards, and any other card without a neighbour to pair with. */
function spans(main) {
  const list = Array.isArray(main) ? main : [];
  const out = new Set();
  for (let i = 0; i < list.length; i++) {
    const id = list[i];
    if (WIDE.has(id)) { out.add(id); continue; }
    const next = list[i + 1];
    if (next !== undefined && !WIDE.has(next)) { i++; continue; }
    out.add(id);
  }
  return out;
}

return Object.freeze({ CARDS, ZONES, DEFAULT, WIDE, normalize, move, isDefault, spans });
});
