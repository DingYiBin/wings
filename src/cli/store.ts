/**
 * Lightweight reactive store — matches claude-code's state/store.ts pattern.
 *
 * Single closure, immutable updates via functional `setState(prev => next)`.
 * Listeners fire only when Object.is detects a change.
 */

export type Listener = () => void;

export interface Store<T> {
  getState(): T;
  setState(updater: (prev: T) => T): void;
  subscribe(listener: Listener): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<Listener>();

  return {
    getState() {
      return state;
    },

    setState(updater: (prev: T) => T) {
      const next = updater(state);
      if (!Object.is(next, state)) {
        state = next;
        for (const fn of listeners) fn();
      }
    },

    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
