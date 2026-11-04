/**
 * Where searches are kept. v1 keeps them in memory, so they disappear when
 * the server restarts. To persist searches (SQLite, MySQL...), implement
 * these same four methods on top of the database and pass that object to
 * SearchService instead; nothing else in the backend changes.
 */
export function createInMemorySearchRepository() {
  const jobs = new Map();

  return {
    save(job) {
      jobs.set(job.id, job);
    },
    get(id) {
      return jobs.get(id) ?? null;
    },
    delete(id) {
      jobs.delete(id);
    },
    all() {
      return [...jobs.values()];
    },
  };
}
