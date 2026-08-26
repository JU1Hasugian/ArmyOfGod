/**
 * Mechanism ⑦ — the Run trace.
 *
 * The platform already emitted the facts a reviewer needs: which contract
 * governed a turn, whether the budget admitted it, when the broker came up,
 * what it refused, how long the Runtime took. They were scattered across four
 * record types with no ordering and no causal link, which is the difference
 * between logs and a trace.
 *
 * This adds the missing three things — a shared `traceId`, a parent, and a
 * duration — and nothing else. A span carries the id of the record it
 * describes rather than restating it, so the trace stays a *view* of the
 * evidence rather than a second copy that can disagree with it.
 *
 * Tracing never changes an outcome. Every write is best-effort and swallowed:
 * a Run that succeeded must not be reported as failed because its trace could
 * not be persisted.
 */
import { randomUUID } from "node:crypto";
import type { JsonStore } from "../store.js";
import type { SpanCategory, TraceSpan } from "./types.js";

const now = () => new Date().toISOString();

export interface OpenSpanOptions {
  name: string;
  category: SpanCategory;
  parentId?: string | undefined;
  attributes?: Record<string, string | number | boolean> | undefined;
}

export interface SpanHandle {
  id: string;
  /** Close the span. Repeated calls are ignored, so `finally` is safe. */
  end: (
    outcome?: {
      status?: TraceSpan["status"];
      attributes?: Record<string, string | number | boolean>;
    },
  ) => void;
}

/**
 * Collects a Run's spans in memory and flushes them once.
 *
 * Buffered rather than written span-by-span because the store serialises every
 * mutation through one queue: a span per broker event would put a JSON rewrite
 * of the whole database in the middle of a hot loop. A Run produces a handful
 * of spans and they are all wanted at the same moment — when someone opens the
 * Run — so one write at the end is both cheaper and atomic.
 */
export class RunTracer {
  private readonly spans = new Map<string, TraceSpan>();
  private flushed = false;

  constructor(
    private readonly store: JsonStore,
    readonly traceId: string,
    private readonly runId: string,
    private readonly agentId: string,
  ) {}

  /** Open a span. The returned handle closes it. */
  open(options: OpenSpanOptions): SpanHandle {
    const id = randomUUID();
    const startedAt = now();
    this.spans.set(id, {
      id,
      traceId: this.traceId,
      runId: this.runId,
      agentId: this.agentId,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      name: options.name,
      category: options.category,
      status: "ok",
      startedAt,
      ...(options.attributes ? { attributes: options.attributes } : {}),
    });

    let closed = false;
    return {
      id,
      end: (outcome) => {
        if (closed) return;
        closed = true;
        const span = this.spans.get(id);
        if (!span) return;
        const endedAt = now();
        span.endedAt = endedAt;
        span.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(span.startedAt));
        if (outcome?.status) span.status = outcome.status;
        if (outcome?.attributes) {
          span.attributes = { ...(span.attributes ?? {}), ...outcome.attributes };
        }
      },
    };
  }

  /**
   * Close a span by id, for a caller that holds the id but not the handle.
   *
   * The turn span is opened where the request arrives and finishes where the
   * Run settles, which is a different method — and only the id travels between
   * them. Without this the turn span was never closed on the success path, so
   * `flush` treated it as an unterminated span and marked it `error`: every
   * completed Run carried a failed root span, and the timeline said a Run had
   * crashed while listing its own successful completion underneath.
   */
  close(
    spanId: string,
    outcome?: {
      status?: TraceSpan["status"];
      attributes?: Record<string, string | number | boolean>;
    },
  ): void {
    const span = this.spans.get(spanId);
    if (!span || span.endedAt) return;
    const endedAt = now();
    span.endedAt = endedAt;
    span.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(span.startedAt));
    if (outcome?.status) span.status = outcome.status;
    if (outcome?.attributes) {
      span.attributes = { ...(span.attributes ?? {}), ...outcome.attributes };
    }
  }

  /**
   * Record something that already happened and has no duration of its own —
   * a routing decision, a refusal at the broker.
   */
  event(
    options: OpenSpanOptions & { status?: TraceSpan["status"]; at?: string },
  ): string {
    const id = randomUUID();
    const at = options.at ?? now();
    this.spans.set(id, {
      id,
      traceId: this.traceId,
      runId: this.runId,
      agentId: this.agentId,
      ...(options.parentId ? { parentId: options.parentId } : {}),
      name: options.name,
      category: options.category,
      status: options.status ?? "ok",
      startedAt: at,
      endedAt: at,
      durationMs: 0,
      ...(options.attributes ? { attributes: options.attributes } : {}),
    });
    return id;
  }

  /** Spans collected so far, in start order. Used by tests and by the flush. */
  collected(): TraceSpan[] {
    return [...this.spans.values()].sort((left, right) =>
      left.startedAt === right.startedAt
        ? left.id.localeCompare(right.id)
        : left.startedAt.localeCompare(right.startedAt),
    );
  }

  /**
   * Persist the Run's spans. Idempotent, and never throws: a trace is evidence
   * about a Run, not part of it.
   */
  async flush(): Promise<void> {
    if (this.flushed) return;
    this.flushed = true;
    const spans = this.collected();
    if (spans.length === 0) return;
    // Anything still open when the Run ended is closed as an error rather than
    // left dangling — an unterminated span is exactly the shape of a crash.
    for (const span of spans) {
      if (span.endedAt) continue;
      span.endedAt = now();
      span.durationMs = Math.max(0, Date.parse(span.endedAt) - Date.parse(span.startedAt));
      span.status = "error";
    }
    try {
      await this.store.mutate((database) => {
        database.traceSpans.push(...spans);
      });
    } catch {
      /* Evidence must never change the outcome the caller already saw. */
    }
  }
}

/** One Run's spans, oldest first. */
export function runSpans(store: JsonStore, runId: string): TraceSpan[] {
  return store
    .snapshot()
    .traceSpans.filter((span) => span.runId === runId)
    .sort((left, right) =>
      left.startedAt === right.startedAt
        ? left.id.localeCompare(right.id)
        : left.startedAt.localeCompare(right.startedAt),
    );
}

export interface TraceSummary {
  traceId: string;
  runId: string;
  agentId: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  spanCount: number;
  denied: number;
  errored: number;
  spans: TraceSpan[];
}

/**
 * A Run's trace, with the roll-up a list view needs.
 *
 * `denied` is surfaced at the top because it is the number that decides whether
 * anyone opens the trace at all.
 */
export function traceForRun(store: JsonStore, runId: string): TraceSummary | null {
  const spans = runSpans(store, runId);
  const first = spans[0];
  if (!first) return null;
  const endedAt = spans.reduce(
    (latest, span) => (span.endedAt && span.endedAt > latest ? span.endedAt : latest),
    first.startedAt,
  );
  return {
    traceId: first.traceId,
    runId,
    agentId: first.agentId,
    startedAt: first.startedAt,
    endedAt,
    durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(first.startedAt)),
    spanCount: spans.length,
    denied: spans.filter((span) => span.status === "denied").length,
    errored: spans.filter((span) => span.status === "error").length,
    spans,
  };
}
