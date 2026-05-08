// In-memory itinerary store, keyed by signed-in email or anon session ID.
// Each scope is capped (FIFO) to avoid unbounded growth.

const crypto = require('crypto');

class SavedItineraryStore {
  constructor({ maxPerScope = 25 } = {}) {
    this.store = new Map();
    this.maxPerScope = maxPerScope;
  }

  list(scope) {
    return this.store.get(scope) || [];
  }

  save(scope, itinerary) {
    const list = this.list(scope).slice();
    const id = crypto.randomBytes(8).toString('hex');
    list.unshift({
      id,
      savedAt: new Date().toISOString(),
      tripTitle: String(itinerary?.tripTitle || 'Untitled trip').slice(0, 160),
      itinerary: structuredClone(itinerary)
    });
    while (list.length > this.maxPerScope) list.pop();
    this.store.set(scope, list);
    return { id, count: list.length };
  }

  get(scope, id) {
    return this.list(scope).find((entry) => entry.id === id) || null;
  }

  remove(scope, id) {
    const list = this.list(scope);
    const next = list.filter((entry) => entry.id !== id);
    this.store.set(scope, next);
    return list.length - next.length;
  }
}

module.exports = { SavedItineraryStore };
