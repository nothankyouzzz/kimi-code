/**
 * Local cross-session usage aggregate.
 *
 * Folds every persisted `usage.record` op with `time >= sinceMs` across all
 * sessions under `<home>/sessions/<workspace>/<session>` (any workspace,
 * live or archived — v1 archival is a state flag, the directory stays)
 * into per-model totals.
 *
 * Pure filesystem scan, engine-agnostic by design: the v1 engine has no
 * aggregation RPC, and the in-process v2 route (`IUsageAggregateService`,
 * App scope) folds the same durable records. Durable-only lower bound —
 * records still buffered in a live agent's append log are invisible until
 * flushed.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { scanSessionUsage } from '@moonshot-ai/agent-core-v2/app/usageAggregate/usage-scan';

import type { TokenUsage, UsageAggregate } from '#/types';

export async function scanLocalUsageAggregate(
  homeDir: string,
  sinceMs: number,
): Promise<UsageAggregate> {
  const byModel: Record<string, TokenUsage> = {};
  let sessionsScanned = 0;

  for (const sessionDir of await listSessionDirs(join(homeDir, 'sessions'))) {
    let scan;
    try {
      scan = await scanSessionUsage(sessionDir, sinceMs);
    } catch {
      // One corrupted session never sinks the whole aggregate.
      continue;
    }
    if (!scan.matched) continue;
    sessionsScanned += 1;
    for (const [model, usage] of Object.entries(scan.byModel)) {
      const current = byModel[model];
      byModel[model] = current === undefined ? usage : addTokenUsage(current, usage);
    }
  }

  return { since: sinceMs, byModel, sessionsScanned };
}

/** Every directory two levels down: `<root>/<workspace>/<session>`. */
async function listSessionDirs(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  for (const workspace of await readDirs(root)) {
    for (const session of await readDirs(join(root, workspace))) {
      out.push(join(root, workspace, session));
    }
  }
  return out;
}

async function readDirs(path: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    output: a.output + b.output,
    inputCacheRead: a.inputCacheRead + b.inputCacheRead,
    inputCacheCreation: a.inputCacheCreation + b.inputCacheCreation,
  };
}
