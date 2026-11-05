/**
 * Small pool of tile workers.
 *
 * Two workers on a typical machine: enough to overlap JSON fetch/parse with
 * geometry building for the next tile, while keeping memory bounded. Every job
 * has a timeout, can be cancelled (e.g. the tile was evicted or the camera
 * panned away) and failures reject the promise so the streamer can retry or
 * fall back to main-thread building.
 */

import type {
  TileWorkerResponse,
  TileWirePayload,
  TileWorkerLoadRequest,
  TileWorkerCancelRequest,
  GroundBuildMode,
} from './serialization';

export interface TileWorkerJobInput {
  key: string;
  url: string;
  facadeDetail: boolean;
  trees: boolean;
  groundMode?: GroundBuildMode;
  groundRes?: number;
  groundOnly?: boolean;
}

export interface TileWorkerPoolOptions {
  size?: number;
  /** Per-tile timeout, milliseconds. */
  timeoutMs?: number;
  /** Called once if the pool becomes unusable (main thread then falls back). */
  onFatal?: (reason: string) => void;
}

interface Job {
  id: number;
  input: TileWorkerJobInput;
  resolve: (payload: TileWirePayload | null) => void;
  reject: (error: Error) => void;
  settled: boolean;
  cancelled: boolean;
  timeout: ReturnType<typeof setTimeout> | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class TileWorkerPool {
  private readonly workers: Worker[] = [];
  private readonly idle: Worker[] = [];
  private readonly running = new Map<Worker, Job>();
  private readonly jobs = new Map<number, Job>();
  private readonly queue: Job[] = [];
  private nextId = 1;
  private failed = false;
  private disposed = false;
  private readonly timeoutMs: number;
  private readonly options: TileWorkerPoolOptions;
  private failureReason = '';

  constructor(options: TileWorkerPoolOptions = {}) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const size = Math.max(1, Math.min(options.size ?? 2, 4));
    if (typeof Worker === 'undefined') {
      this.fail('Web Workers are not available');
      return;
    }
    try {
      for (let i = 0; i < size; i += 1) {
        const worker = new Worker(new URL('./tileWorker.ts', import.meta.url), {
          type: 'module',
          name: `tile-worker-${i}`,
        });
        worker.onmessage = (event: MessageEvent<TileWorkerResponse>) => {
          this.handleMessage(worker, event.data);
        };
        worker.onerror = (event: ErrorEvent) => {
          this.fail(`tile worker crashed: ${event.message || 'unknown error'}`);
        };
        worker.onmessageerror = () => {
          this.fail('tile worker message could not be deserialised');
        };
        this.workers.push(worker);
        this.idle.push(worker);
      }
    } catch (error) {
      this.fail(`could not start tile workers: ${String(error)}`);
    }
  }

  get available(): boolean {
    return !this.failed && !this.disposed && this.workers.length > 0;
  }

  get fatalReason(): string {
    return this.failureReason;
  }

  /** Queue a tile build. Resolves null when cancelled. */
  load(input: TileWorkerJobInput): { id: number; promise: Promise<TileWirePayload | null> } {
    const id = this.nextId;
    this.nextId += 1;
    let resolveJob: (payload: TileWirePayload | null) => void = () => undefined;
    let rejectJob: (error: Error) => void = () => undefined;
    const promise = new Promise<TileWirePayload | null>((resolve, reject) => {
      resolveJob = resolve;
      rejectJob = reject;
    });
    const job: Job = {
      id,
      input,
      resolve: resolveJob,
      reject: rejectJob,
      settled: false,
      cancelled: false,
      timeout: null,
    };
    if (this.failed || this.disposed) {
      job.settled = true;
      rejectJob(new Error(this.failureReason || 'tile worker pool is not available'));
      return { id, promise };
    }
    job.timeout = setTimeout(() => {
      if (job.settled) return;
      job.cancelled = true;
      const worker = this.findWorkerForJob(job);
      if (worker) {
        const message: TileWorkerCancelRequest = { type: 'cancel', id: job.id };
        try {
          worker.postMessage(message);
        } catch {
          /* ignore */
        }
      }
      this.settle(job, undefined, new Error(`tile build timed out after ${this.timeoutMs} ms`));
    }, this.timeoutMs);

    this.jobs.set(id, job);
    this.queue.push(job);
    this.dispatch();
    return { id, promise };
  }

  cancel(id: number): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.cancelled = true;
    const queuedIndex = this.queue.indexOf(job);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.settle(job, null);
      return;
    }
    const worker = this.findWorkerForJob(job);
    if (worker) {
      const message: TileWorkerCancelRequest = { type: 'cancel', id: job.id };
      try {
        worker.postMessage(message);
      } catch {
        /* worker may be gone */
      }
    }
    // Resolve immediately: the streamer no longer cares about this tile. The
    // worker response is ignored when it eventually arrives.
    this.settle(job, null);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const job of this.jobs.values()) {
      if (!job.settled) {
        job.settled = true;
        job.reject(new Error('tile worker pool disposed'));
      }
      if (job.timeout) clearTimeout(job.timeout);
    }
    this.jobs.clear();
    this.queue.length = 0;
    this.running.clear();
    this.idle.length = 0;
    for (const worker of this.workers) worker.terminate();
    this.workers.length = 0;
  }

  // -------------------------------------------------------------------------

  private fail(reason: string): void {
    if (this.failed) return;
    this.failed = true;
    this.failureReason = reason;
    for (const job of this.jobs.values()) {
      if (!job.settled) {
        job.settled = true;
        if (job.timeout) clearTimeout(job.timeout);
        job.reject(new Error(reason));
      }
    }
    this.jobs.clear();
    this.queue.length = 0;
    this.running.clear();
    this.idle.length = 0;
    for (const worker of this.workers) {
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
    }
    this.workers.length = 0;
    this.options.onFatal?.(reason);
  }

  private findWorkerForJob(job: Job): Worker | null {
    for (const [worker, runningJob] of this.running) {
      if (runningJob === job) return worker;
    }
    return null;
  }

  private dispatch(): void {
    if (this.failed || this.disposed) return;
    while (this.idle.length > 0 && this.queue.length > 0) {
      const worker = this.idle.pop();
      const job = this.queue.shift();
      if (!worker || !job) break;
      if (job.settled) {
        this.idle.push(worker);
        continue;
      }
      this.running.set(worker, job);
      const message: TileWorkerLoadRequest = {
        type: 'load',
        id: job.id,
        key: job.input.key,
        url: job.input.url,
        facadeDetail: job.input.facadeDetail,
        trees: job.input.trees,
        groundMode: job.input.groundMode,
        groundRes: job.input.groundRes,
        groundOnly: job.input.groundOnly,
      };
      try {
        worker.postMessage(message);
      } catch (error) {
        this.running.delete(worker);
        this.settle(job, undefined, new Error(`could not post tile job: ${String(error)}`));
        this.idle.push(worker);
      }
    }
  }

  private handleMessage(worker: Worker, message: TileWorkerResponse): void {
    const job = this.running.get(worker);
    this.running.delete(worker);
    if (job) {
      if (message.type === 'result') {
        this.settle(job, message.payload);
      } else if (message.type === 'cancelled') {
        this.settle(job, null);
      } else {
        this.settle(job, undefined, new Error(message.message));
      }
    }
    if (!this.failed && !this.disposed) {
      this.idle.push(worker);
      this.dispatch();
    }
  }

  private settle(
    job: Job,
    payload: TileWirePayload | null | undefined,
    error?: Error,
  ): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timeout) clearTimeout(job.timeout);
    job.timeout = null;
    this.jobs.delete(job.id);
    if (error) job.reject(error);
    else job.resolve(payload ?? null);
  }
}
