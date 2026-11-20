/**
 * Tile worker — fetches tile JSON, builds city geometry and posts transferable
 * buffers back to the main thread.
 *
 * The worker owns the network request so that JSON parsing of multi-megabyte
 * tiles never blocks the render loop. Cancellation aborts the request; the main
 * thread ignores stale results via request ids.
 *
 * `request.url` arrives as an absolute URL resolved by the main thread against
 * the document base (`TileWorkerPool`): a project-relative payload URL would
 * otherwise resolve against this worker script instead of the application and
 * break deployments below a prefix such as `/VoxelMinsk/`.
 */

import type { TileData } from '../../shared/types';
import { buildTilePayload } from './tileBuild';
import {
  collectTransferables,
  type TileWorkerRequest,
  type TileWorkerResponse,
} from './serialization';

interface WorkerScope {
  onmessage: ((event: MessageEvent<TileWorkerRequest>) => void) | null;
  postMessage: (message: TileWorkerResponse, transfer?: Transferable[]) => void;
}

const scope = self as unknown as WorkerScope;
const controllers = new Map<number, AbortController>();

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function respond(message: TileWorkerResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

async function handleLoad(request: Extract<TileWorkerRequest, { type: 'load' }>): Promise<void> {
  const controller = new AbortController();
  controllers.set(request.id, controller);
  const fetchStart = now();
  try {
    const response = await fetch(request.url, {
      signal: controller.signal,
      // Tile payloads change whenever the dataset is regenerated (same URL!),
      // so always revalidate with the server instead of trusting the HTTP cache.
      // A 304 keeps the fast path; stale geometry after a data update is much
      // worse than a conditional request per tile.
      cache: 'no-cache',
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching ${request.url}`);
    }
    const data = (await response.json()) as TileData;
    const fetchMs = now() - fetchStart;
    if (controller.signal.aborted) {
      respond({ type: 'cancelled', id: request.id });
      return;
    }
    const payload = buildTilePayload(data, {
      facadeDetail: request.facadeDetail,
      trees: request.trees,
      treeStyle: request.treeStyle,
      groundMode: request.groundMode,
      groundRes: request.groundRes,
      groundOnly: request.groundOnly,
    });
    payload.fetchMs = fetchMs;
    if (controller.signal.aborted) {
      respond({ type: 'cancelled', id: request.id });
      return;
    }
    respond({ type: 'result', id: request.id, payload }, collectTransferables(payload));
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      respond({ type: 'cancelled', id: request.id });
    } else {
      respond({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    controllers.delete(request.id);
  }
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'name' in error &&
      (error as { name?: string }).name === 'AbortError',
  );
}

scope.onmessage = (event: MessageEvent<TileWorkerRequest>) => {
  const request = event.data;
  if (!request || typeof request !== 'object') return;
  if (request.type === 'load') {
    void handleLoad(request);
  } else if (request.type === 'cancel') {
    controllers.get(request.id)?.abort();
  }
};
