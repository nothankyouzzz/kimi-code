import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveLocalUpgradePipeline } from '#/cli/update/local-pipeline';

describe('resolveLocalUpgradePipeline', () => {
  it('returns the KIMI_LOCAL_UPGRADE_SCRIPT override when it exists', () => {
    // process.execPath is a file that always exists.
    expect(resolveLocalUpgradePipeline({ KIMI_LOCAL_UPGRADE_SCRIPT: process.execPath })).toBe(
      process.execPath,
    );
  });

  it('returns null when the override path does not exist', () => {
    expect(
      resolveLocalUpgradePipeline({ KIMI_LOCAL_UPGRADE_SCRIPT: '/nonexistent/kimi-upgrade-test-pipeline' }),
    ).toBeNull();
  });

  it('falls back to ~/.kimi-code/upgrade-with-patches.sh without the override', () => {
    const defaultPath = join(homedir(), '.kimi-code', 'upgrade-with-patches.sh');
    expect(resolveLocalUpgradePipeline({})).toBe(existsSync(defaultPath) ? defaultPath : null);
  });
});
