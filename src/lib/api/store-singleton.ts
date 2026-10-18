import { RtdbStore } from "@/lib/db/rtdb-store";
import type { Store } from "@/lib/db/store";

export type { Store };

/**
 * Singleton Store for request handlers. The production store is the Firebase
 * Realtime Database (persistent). Tests construct `MemoryStore` directly; this
 * factory is never used to persist records in memory.
 */
let store: Store | null = null;

export function getStore(): Store {
  if (!store) store = new RtdbStore();
  return store;
}

export function setStore(s: Store | null): void {
  store = s;
}
