import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createKimiHarness, ImageLimits, KimiHarness, SDKRpcClientBase } from '#/index';

import { recordingTelemetry } from './telemetry';
import { TEST_IDENTITY } from './test-identity';

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * The recursive RPC surface KimiHarness touches for the tests below: kept
 * minimal like the StubRpc in create-session-transport.test.ts.
 */
class StubRpc extends SDKRpcClientBase {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  protected async getRpc(): Promise<any> {
    throw new Error('no core calls expected');
  }
}

function makeHarnessWithRpc(rpc: SDKRpcClientBase): KimiHarness {
  return new KimiHarness(rpc, {
    homeDir: '/tmp/home',
    configPath: '/tmp/config.toml',
    auth: { status: async () => ({ providers: [] }) } as never,
    telemetry: recordingTelemetry([]),
    ensureConfigFile: async () => undefined,
    onClose: () => undefined,
  });
}

describe('KimiHarness capability facade', () => {
  const ready = {
    id: 'kimi-webbridge',
    displayName: 'Kimi WebBridge',
    description: 'd',
    supported: true,
    state: 'ready',
    steps: [],
    install: { running: false },
  } as const;

  it('routes capability calls through the global channel with no session', async () => {
    const calls: string[] = [];
    class CapabilityRpc extends StubRpc {
      async listCapabilities() {
        calls.push('list');
        return [ready];
      }
      async getCapability(id: string) {
        calls.push(`get:${id}`);
        return ready;
      }
      async installCapability(id: string) {
        calls.push(`install:${id}`);
        return ready;
      }
    }
    const harness = makeHarnessWithRpc(new CapabilityRpc());

    expect(await harness.listCapabilities()).toEqual([ready]);
    expect((await harness.getCapability('kimi-webbridge')).state).toBe('ready');
    await harness.installCapability('kimi-webbridge');
    expect(calls).toEqual(['list', 'get:kimi-webbridge', 'install:kimi-webbridge']);
  });

  it('reports the capability surface as unavailable on v1', async () => {
    // The v1 rpc has no capability methods, exactly like the real v1 client.
    const harness = makeHarnessWithRpc(new StubRpc());
    await expect(harness.listCapabilities()).rejects.toThrow(/requires v2/);
    await expect(harness.installCapability('kimi-cu')).rejects.toThrow(/requires v2/);
  });
});

describe('KimiHarness imageLimits', () => {
  it('exposes the in-process core [image] limits loaded from config.toml', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);
    await writeFile(
      join(homeDir, 'config.toml'),
      `
[image]
max_edge_px = 1200
read_byte_budget = 65536
`,
      'utf-8',
    );

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      // The core was constructed in-process; its owner-scoped [image] limits
      // must be readable on the harness for prompt-ingestion paths.
      expect(harness.imageLimits).toBeInstanceOf(ImageLimits);
      expect(harness.imageLimits?.maxEdgePx()).toBe(1200);
      expect(harness.imageLimits?.readByteBudget()).toBe(65536);
    } finally {
      await harness.close();
    }
  });

  it('falls back to built-in defaults when no [image] section is configured', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);

    const harness = createKimiHarness({ identity: TEST_IDENTITY, homeDir });
    try {
      expect(harness.imageLimits).toBeInstanceOf(ImageLimits);
      expect(harness.imageLimits?.maxEdgePx()).toBe(2000);
      expect(harness.imageLimits?.readByteBudget()).toBe(256 * 1024);
    } finally {
      await harness.close();
    }
  });

  it('a hand-built harness returns the injected ImageLimits as-is', () => {
    const limits = new ImageLimits(process.env, { maxEdgePx: 900 });
    const harness = new KimiHarness(new StubRpc(), {
      homeDir: '/tmp/home',
      configPath: '/tmp/config.toml',
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry([]),
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
      imageLimits: limits,
    });

    expect(harness.imageLimits).toBe(limits);
    expect(harness.imageLimits?.maxEdgePx()).toBe(900);
  });
});

describe('KimiHarness getUsageAggregate', () => {
  function usageRecord(
    model: string,
    usage: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number },
    time: number,
    usageScope: 'session' | 'turn' = 'turn',
  ): string {
    return JSON.stringify({ type: 'usage.record', model, usage, usageScope, time });
  }

  function harnessFor(homeDir: string): KimiHarness {
    return new KimiHarness(new StubRpc(), {
      homeDir,
      configPath: join(homeDir, 'config.toml'),
      auth: { status: async () => ({ providers: [] }) } as never,
      telemetry: recordingTelemetry([]),
      ensureConfigFile: async () => undefined,
      onClose: () => undefined,
    });
  }

  it('folds usage.record ops across sessions from the local store, without any engine RPC', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);
    const now = Date.now();
    const record = (inputOther: number, output: number, inputCacheRead: number) =>
      usageRecord('kimi-k2', { inputOther, output, inputCacheRead, inputCacheCreation: 0 }, now - 500);

    // v2-style per-agent wire log.
    const v2Session = join(homeDir, 'sessions', 'wd_a_0000', 'session_00000000-0000-0000-0000-000000000001');
    await mkdir(join(v2Session, 'agents', 'main'), { recursive: true });
    await writeFile(
      join(v2Session, 'agents', 'main', 'wire.jsonl'),
      [
        record(10, 5, 100),
        usageRecord(
          'kimi-k2',
          { inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 },
          now - 400,
          'session',
        ),
        // Outside the window — must be excluded.
        usageRecord(
          'kimi-k2',
          { inputOther: 999, output: 999, inputCacheRead: 999, inputCacheCreation: 999 },
          now - 10 * 24 * 3600 * 1000,
        ),
        '{"type":"context.message"}',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Legacy root wire log in a second session.
    const v1Session = join(homeDir, 'sessions', 'wd_b_1111', 'session_00000000-0000-0000-0000-000000000002');
    await mkdir(v1Session, { recursive: true });
    await writeFile(join(v1Session, 'wire.jsonl'), `${record(1, 2, 3)}\n`, 'utf-8');

    const harness = harnessFor(homeDir);
    // The StubRpc base throws NOT_IMPLEMENTED for getUsageAggregate — a
    // passing assertion here pins the local-scan route.
    const aggregate = await harness.getUsageAggregate(now - 3600_000);

    expect(aggregate.sessionsScanned).toBe(2);
    expect(aggregate.byModel).toEqual({
      'kimi-k2': { inputOther: 18, output: 10, inputCacheRead: 103, inputCacheCreation: 0 },
    });
  });

  it('reports an empty aggregate when the sessions store does not exist', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-sdk-harness-'));
    tempDirs.push(homeDir);

    const aggregate = await harnessFor(homeDir).getUsageAggregate(0);

    expect(aggregate.sessionsScanned).toBe(0);
    expect(aggregate.byModel).toEqual({});
  });
});
