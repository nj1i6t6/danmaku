export function createClientIdProvider({ load, save, generate }) {
  for (const [name, value] of Object.entries({ load, save, generate })) {
    if (typeof value !== 'function') throw new TypeError(`client identity ${name} adapter is required`);
  }

  let current = null;
  return {
    async get() {
      if (current) return current;
      try {
        const stored = await load();
        if (typeof stored === 'string' && stored) {
          current = stored;
          return current;
        }
      } catch {
        // Fall through to a process-local identity when the OS keyring is unavailable.
      }

      current = generate();
      try {
        await save(current);
      } catch {
        // The in-memory value keeps this process usable without exposing it to localStorage.
      }
      return current;
    },
  };
}
