/**
 * `usageAggregate` domain — persisted wire usage scanner.
 *
 * Reads both legacy root `wire.jsonl` logs and v2 per-agent
 * `agents/<agentId>/wire.jsonl` logs to fold `usage.record` ops into
 * per-model totals without depending on live Agent services. Same file
 * walking strategy as `sessionExport/wire-scan.ts`; the extraction is
 * specialized to usage records.
 */

import { open, readdir, type FileHandle } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { join } from 'pathe';

import { addUsage, type TokenUsage } from '#/kosong/contract/usage';

const WIRE_FILENAME = 'wire.jsonl';
const USAGE_RECORD_TYPE = '"usage.record"';

export interface UsageScanResult {
  readonly byModel: Record<string, TokenUsage>;
  /** Whether at least one usage record in the window was found. */
  readonly matched: boolean;
}

export async function scanSessionUsage(
  sessionDir: string,
  sinceMs: number,
  signal?: AbortSignal,
): Promise<UsageScanResult> {
  signal?.throwIfAborted();
  const byModel: Record<string, TokenUsage> = {};
  let matched = false;

  for (const file of await collectWireFiles(sessionDir, signal)) {
    signal?.throwIfAborted();
    for await (const hit of scanWireFile(file, sinceMs, signal)) {
      matched = true;
      const current = byModel[hit.model];
      byModel[hit.model] = current === undefined ? { ...hit.usage } : addUsage(current, hit.usage);
    }
  }

  return { byModel, matched };
}

async function collectWireFiles(
  sessionDir: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const files = [join(sessionDir, WIRE_FILENAME)];
  const agentsDir = join(sessionDir, 'agents');
  try {
    const entries = await readdir(agentsDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      signal?.throwIfAborted();
      if (!entry.isFile() || entry.name !== WIRE_FILENAME) continue;
      files.push(join(entry.parentPath, entry.name));
    }
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  return files;
}

interface UsageRecordHit {
  readonly model: string;
  readonly usage: TokenUsage;
}

async function* scanWireFile(
  path: string,
  sinceMs: number,
  signal?: AbortSignal,
): AsyncIterable<UsageRecordHit> {
  let file: FileHandle;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return;
  }

  let input: Readable | undefined;
  try {
    signal?.throwIfAborted();
    const size = (await file.stat()).size;
    signal?.throwIfAborted();
    input =
      size === 0
        ? Readable.from([])
        : file.createReadStream({
            encoding: 'utf8',
            autoClose: false,
            end: size - 1,
            signal,
          });
    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
      // Cheap pre-filter: usage records are a small minority of a wire log.
      if (!line.includes(USAGE_RECORD_TYPE)) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch {
        continue;
      }
      const hit = toUsageHit(parsed, sinceMs);
      if (hit !== undefined) yield hit;
    }
  } finally {
    input?.destroy();
    if (input !== undefined) await finished(input, { cleanup: true }).catch(() => {});
    await file.close();
  }
}

function toUsageHit(parsed: unknown, sinceMs: number): UsageRecordHit | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as {
    type?: unknown;
    time?: unknown;
    model?: unknown;
    usage?: unknown;
  };
  if (record.type !== 'usage.record') return undefined;
  const timeMs = typeof record.time === 'number' ? normalizeTimestampMs(record.time) : undefined;
  if (timeMs === undefined || timeMs < sinceMs) return undefined;
  if (typeof record.model !== 'string' || record.model.length === 0) return undefined;
  const usage = toTokenUsage(record.usage);
  if (usage === undefined) return undefined;
  return { model: record.model, usage };
}

function toTokenUsage(raw: unknown): TokenUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const rec = raw as Record<string, unknown>;
  return {
    inputOther: toCount(rec['inputOther']),
    output: toCount(rec['output']),
    inputCacheRead: toCount(rec['inputCacheRead']),
    inputCacheCreation: toCount(rec['inputCacheCreation']),
  };
}

function toCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function normalizeTimestampMs(value: number): number | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
