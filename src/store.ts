/** Default in-memory MeterStore. Great for demos and single-process servers; swap for a DB adapter
 * in production by implementing the same MeterStore interface. */

import type { MeterStore, Session, SettlementEvent, StreamSpec } from "./types.js";

export class MemoryStore implements MeterStore {
  readonly streams = new Map<string, StreamSpec>();
  private readonly sessions = new Map<string, Session>();
  private readonly events: SettlementEvent[] = [];

  constructor(streams: StreamSpec[] = []) {
    for (const s of streams) this.streams.set(s.id, s);
  }

  addStream(stream: StreamSpec): StreamSpec {
    this.streams.set(stream.id, stream);
    return stream;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  putSession(s: Session): void {
    this.sessions.set(s.id, s);
  }

  addEvent(e: SettlementEvent): void {
    this.events.push(e);
  }

  listEvents(): SettlementEvent[] {
    return this.events;
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  updateEventsByBatchId(batchId: string, patch: { txHash: string; explorerUrl: string }): void {
    for (const e of this.events) {
      if (e.batchId === batchId) {
        e.txHash = patch.txHash;
        e.explorerUrl = patch.explorerUrl;
      }
    }
  }
}
