import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LifecycleScope,
  ScopeActivation,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import {
  ISessionIndex,
  type SessionListQuery,
  type SessionSummary,
} from '#/app/sessionIndex/sessionIndex';
import { IUsageAggregateService } from '#/app/usageAggregate/usageAggregate';
import { UsageAggregateService } from '#/app/usageAggregate/usageAggregateService';
import type { Page } from '#/persistence/interface/queryStore';

import { stubLog } from '../../_base/log/stubs';
import { stubBootstrap } from '../bootstrap/stubs';

const WS_A = 'ws-a';
const WS_B = 'ws-b';
const NOW = Date.now();
const WEEK_MS = 7 * 24 * 3600 * 1000;

function usageRecord(model: string, time: number, tokens: Record<string, number>) {
  return JSON.stringify({
    type: 'usage.record',
    time,
    model,
    usage: { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0, ...tokens },
    usageScope: 'session',
  });
}

function stubIndex(summaries: readonly SessionSummary[]): ISessionIndex {
  return {
    _serviceBrand: undefined,
    list: (query: SessionListQuery): Promise<Page<SessionSummary>> => {
      const items = summaries.filter(
        (s) => query.includeArchived === true || !s.archived,
      );
      return Promise.resolve({ items });
    },
    get: (id: string) => Promise.resolve(summaries.find((s) => s.id === id)),
    countActive: () => Promise.resolve(summaries.filter((s) => !s.archived).length),
  };
}

function summary(id: string, workspaceId: string, archived = false): SessionSummary {
  return { id, workspaceId, createdAt: NOW, updatedAt: NOW, archived };
}

describe('UsageAggregateService', () => {
  let homeDir: string;
  let disposeHost: (() => void) | undefined;

  beforeEach(async () => {
    _clearScopedRegistryForTests();
    registerScopedService(
      LifecycleScope.App,
      IUsageAggregateService,
      UsageAggregateService,
      ScopeActivation.OnDemand,
      'usageAggregate',
    );
    homeDir = await fsp.mkdtemp(join(os.tmpdir(), 'usage-aggregate-'));
  });

  afterEach(async () => {
    disposeHost?.();
    disposeHost = undefined;
    await fsp.rm(homeDir, { recursive: true, force: true });
  });

  function build(summaries: readonly SessionSummary[]): IUsageAggregateService {
    const host = createScopedTestHost([
      stubPair(IBootstrapService, stubBootstrap(homeDir)),
      stubPair(ISessionIndex, stubIndex(summaries)),
      stubPair(ILogService, stubLog()),
    ]);
    disposeHost = () => {
      host.dispose();
    };
    return host.app.accessor.get(IUsageAggregateService);
  }

  async function seedWire(
    workspaceId: string,
    sessionId: string,
    lines: readonly string[],
    agentId?: string,
  ): Promise<void> {
    const dir =
      agentId === undefined
        ? join(homeDir, 'sessions', workspaceId, sessionId)
        : join(homeDir, 'sessions', workspaceId, sessionId, 'agents', agentId);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'wire.jsonl'), lines.join('\n') + '\n');
  }

  it('folds usage records across workspaces, sessions, and agents within the window', async () => {
    await seedWire(WS_A, 's1', [usageRecord('kimi-k2.6', NOW - 1000, { inputOther: 100, output: 10 })]);
    await seedWire(WS_A, 's1', [usageRecord('kimi-k2.6', NOW - 2000, { inputOther: 50 })], 'sub-1');
    await seedWire(WS_B, 's2', [usageRecord('kimi-k3', NOW - 3000, { output: 5, inputCacheRead: 700 })]);

    const svc = build([summary('s1', WS_A), summary('s2', WS_B)]);
    const result = await svc.aggregate(NOW - WEEK_MS);

    expect(result.since).toBe(NOW - WEEK_MS);
    expect(result.sessionsScanned).toBe(2);
    expect(result.byModel['kimi-k2.6']).toEqual({
      inputOther: 150,
      output: 10,
      inputCacheRead: 0,
      inputCacheCreation: 0,
    });
    expect(result.byModel['kimi-k3']).toEqual({
      inputOther: 0,
      output: 5,
      inputCacheRead: 700,
      inputCacheCreation: 0,
    });
  });

  it('ignores records older than the window and non-usage records', async () => {
    await seedWire(WS_A, 's1', [
      usageRecord('kimi-k2.6', NOW - WEEK_MS - 60_000, { inputOther: 999 }),
      JSON.stringify({ type: 'turn_begin', time: NOW - 1000, userInput: 'hi' }),
      JSON.stringify({ type: 'metadata', protocol_version: '1.5', created_at: NOW - WEEK_MS }),
    ]);

    const svc = build([summary('s1', WS_A)]);
    const result = await svc.aggregate(NOW - WEEK_MS);

    expect(result.byModel).toEqual({});
    expect(result.sessionsScanned).toBe(0);
  });

  it('counts archived sessions that burned quota inside the window', async () => {
    await seedWire(WS_A, 'old', [usageRecord('kimi-k2.6', NOW - 1000, { inputOther: 42 })]);

    const svc = build([summary('old', WS_A, true)]);
    const result = await svc.aggregate(NOW - WEEK_MS);

    expect(result.sessionsScanned).toBe(1);
    expect(result.byModel['kimi-k2.6']?.inputOther).toBe(42);
  });

  it('skips missing session dirs, corrupted lines, and legacy second timestamps', async () => {
    await seedWire(WS_A, 's1', [
      '{ not json',
      // legacy wire logs may carry epoch seconds instead of ms
      usageRecord('kimi-k2.6', (NOW - 1000) / 1000, { inputOther: 7 }),
    ]);

    const svc = build([summary('s1', WS_A), summary('ghost', WS_B)]);
    const result = await svc.aggregate(NOW - WEEK_MS);

    expect(result.sessionsScanned).toBe(1);
    expect(result.byModel['kimi-k2.6']?.inputOther).toBe(7);
  });
});
