import { describe, expect, it, vi } from 'vitest';

import { handleTitleCommand } from '#/tui/commands/session';
import type { SlashCommandHost } from '#/tui/commands/dispatch';

function hostWith(overrides: {
  generateSessionTitle?: ReturnType<typeof vi.fn>;
  renameSession?: ReturnType<typeof vi.fn>;
  hasSession?: boolean;
} = {}): SlashCommandHost {
  const generateSessionTitle = overrides.generateSessionTitle ?? vi.fn(async () => 'Generated');
  const renameSession = overrides.renameSession ?? vi.fn(async () => undefined);
  return {
    session: overrides.hasSession === false ? undefined : { id: 's1' },
    state: { appState: { sessionTitle: null, sessionId: 's1' } },
    harness: { generateSessionTitle, renameSession },
    ensureSession: vi.fn(async () => ({ id: 's1' })),
    showStatus: vi.fn(),
    showError: vi.fn(),
  } as unknown as SlashCommandHost;
}

describe('/title generate', () => {
  it('regenerates from the whole-conversation digest excerpt', async () => {
    const host = hostWith();

    await handleTitleCommand(host, ' generate  ');

    expect(host.harness.generateSessionTitle).toHaveBeenCalledWith({
      id: 's1',
      force: true,
      source: 'digest',
    });
    expect(host.showStatus).toHaveBeenCalledWith('Session title set to: Generated');
  });

  it('surfaces the engine error when generation is unavailable', async () => {
    const host = hostWith({ generateSessionTitle: vi.fn(async () => undefined) });

    await handleTitleCommand(host, 'generate');

    expect(host.showError).toHaveBeenCalledWith(expect.stringContaining('title generation unavailable'));
    expect(host.showStatus).not.toHaveBeenCalledWith(expect.stringContaining('set to'));
  });

  it('rejects generation without an active session', async () => {
    const host = hostWith({ hasSession: false });

    await handleTitleCommand(host, 'generate');

    expect(host.harness.generateSessionTitle).not.toHaveBeenCalled();
    expect(host.showError).toHaveBeenCalled();
  });
});

describe('/title <text>', () => {
  it('still renames instead of generating for a non-keyword argument', async () => {
    const host = hostWith();

    await handleTitleCommand(host, 'My session');

    expect(host.harness.renameSession).toHaveBeenCalledWith({ id: 's1', title: 'My session' });
    expect(host.harness.generateSessionTitle).not.toHaveBeenCalled();
  });
});
