import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionEventHandler } from '#/tui/controllers/session-event-handler';
import { getBuiltInPalette } from '#/tui/theme';

function makeHost() {
  const generateSessionTitle = vi.fn(async () => undefined);
  const host = {
    state: {
      appState: {
        sessionId: 's1',
        streamingPhase: 'idle',
        isCompacting: false,
        model: 'kimi-model',
        permissionMode: 'auto',
        stepRetry: null,
      },
      queuedMessages: [],
      queuedMessageDispatchPending: false,
      theme: { palette: getBuiltInPalette('dark') },
      toolOutputExpanded: false,
      todoPanel: { getTodos: vi.fn(() => []) },
      transcriptContainer: { addChild: vi.fn() },
      ui: { requestRender: vi.fn() },
    },
    session: { id: 's1' },
    aborted: false,
    sessionEventUnsubscribe: undefined,
    streamingUI: {
      setTurnId: vi.fn(),
      setStep: vi.fn(),
      flushNow: vi.fn(),
      resetToolUi: vi.fn(),
      finalizeTurn: vi.fn(),
      setTodoList: vi.fn(),
      finalizeLiveTextBuffers: vi.fn(),
      completeToolResult: vi.fn(),
    },
    harness: { generateSessionTitle },
    requireSession: vi.fn(),
    setAppState: vi.fn((patch: Record<string, unknown>) =>
      Object.assign(host.state.appState, patch),
    ),
    patchLivePane: vi.fn(),
    resetLivePane: vi.fn(),
    showError: vi.fn(),
    showStatus: vi.fn(),
    showNotice: vi.fn(),
    track: vi.fn(),
    recordSessionActivity: vi.fn(),
    noteStepUsage: vi.fn(),
    noteCompactionFinished: vi.fn(),
    mountEditorReplacement: vi.fn(),
    restoreEditor: vi.fn(),
    restoreInputText: vi.fn(),
    appendTranscriptEntry: vi.fn(),
    sendNormalUserInput: vi.fn(),
    sendQueuedMessage: vi.fn(),
    shiftQueuedMessage: vi.fn(),
    btwPanelController: { routeEvent: vi.fn(() => false) },
    tasksBrowserController: {},
  };
  return { host: host as any, generateSessionTitle };
}

const turnEndedEvent = (reason: string) => ({
  type: 'turn.ended',
  sessionId: 's1',
  agentId: 'main',
  turnId: 1,
  reason,
});

describe('SessionEventHandler AI title auto-generation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests a title from the first-turn excerpt after a completed turn', () => {
    const { host, generateSessionTitle } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(turnEndedEvent('completed') as any, vi.fn());
    expect(generateSessionTitle).toHaveBeenCalledWith({ id: 's1', source: 'first_turn' });
  });

  it('does not request a title when the turn was cancelled', () => {
    const { host, generateSessionTitle } = makeHost();
    const handler = new SessionEventHandler(host);
    handler.handleEvent(turnEndedEvent('cancelled') as any, vi.fn());
    expect(generateSessionTitle).not.toHaveBeenCalled();
  });

  it('silently swallows engine failures', async () => {
    const { host, generateSessionTitle } = makeHost();
    generateSessionTitle.mockRejectedValue(new Error('server unreachable'));
    const handler = new SessionEventHandler(host);
    handler.handleEvent(turnEndedEvent('completed') as any, vi.fn());
    await vi.runAllTimersAsync();
    expect(generateSessionTitle).toHaveBeenCalledWith({ id: 's1', source: 'first_turn' });
  });
});
