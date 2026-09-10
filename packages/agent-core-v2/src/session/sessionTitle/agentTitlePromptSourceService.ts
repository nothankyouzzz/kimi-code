import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { LifecycleScope } from '#/app/scopes';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { reduceContextTranscript } from '#/agent/contextMemory/contextTranscript';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IAgentPromptService } from '#/agent/prompt/prompt';
import {
  promptMetadataTextFromContentParts,
  promptMetadataTextFromText,
} from '#/agent/prompt/promptMetadataText';
import type { ContentPart } from '#human/llm/message';
import type { WireRecord } from '#/wire/record';
import { IWireService } from '#/wire/wire';

import {
  IAgentTitlePromptSource,
  type TitleDigestExcerpt,
  type TitleDigestTurn,
  type TitleTurnExcerpt,
} from './agentTitlePromptSource';

export class AgentTitlePromptSourceService implements IAgentTitlePromptSource {
  declare readonly _serviceBrand: undefined;

  private journalMessagesPromise: Promise<readonly ContextMessage[]> | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentPromptService private readonly prompt: IAgentPromptService,
    @IWireService private readonly wire: IWireService,
  ) {}

  async firstUserPrompts(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    const fromMemory = collectFirstUserPrompts(this.combinedMessages(), limit);
    if (fromMemory.length > 0) return fromMemory;
    return collectFirstUserPrompts(await this.journalMessages(), limit);
  }

  async firstTurnExcerpt(): Promise<TitleTurnExcerpt> {
    const memory = buildFirstTurnExcerpt(this.combinedMessages());
    if (turnExcerptScore(memory) === 2) return memory;
    const fromJournal = buildFirstTurnExcerpt(await this.journalMessages());
    return turnExcerptScore(fromJournal) > turnExcerptScore(memory) ? fromJournal : memory;
  }

  async digestExcerpt(): Promise<TitleDigestExcerpt> {
    const memory = buildDigestExcerpt(this.combinedMessages());
    const fromJournal = buildDigestExcerpt(await this.journalMessages());
    return digestExcerptScore(fromJournal) > digestExcerptScore(memory) ? fromJournal : memory;
  }

  private combinedMessages(): ContextMessage[] {
    const queue = this.prompt.list();
    const all = [...this.context.get()];
    if (queue.active !== undefined) all.push(queue.active.message);
    for (const item of queue.pending) all.push(item.message);
    return all;
  }

  private journalMessages(): Promise<readonly ContextMessage[]> {
    if (this.journalMessagesPromise === undefined) {
      this.journalMessagesPromise = loadJournalMessages(this.wire);
    }
    return this.journalMessagesPromise;
  }
}

async function loadJournalMessages(wire: IWireService): Promise<readonly ContextMessage[]> {
  try {
    const records: WireRecord[] = [];
    for await (const record of wire.readJournal()) records.push(record);
    return reduceContextTranscript(records).entries;
  } catch {
    return [];
  }
}

function collectFirstUserPrompts(
  messages: readonly ContextMessage[],
  limit: number,
): string[] {
  const result: string[] = [];
  const seenMessageIds = new Set<string>();

  const add = (message: ContextMessage): void => {
    if (result.length >= limit || !isNaturalLanguagePrompt(message)) return;
    if (message.id !== undefined) {
      if (seenMessageIds.has(message.id)) return;
      seenMessageIds.add(message.id);
    }
    const text = promptMetadataTextFromUserMessage(message);
    if (text !== undefined) result.push(text);
  };

  for (const message of messages) add(message);
  return result;
}

function buildFirstTurnExcerpt(messages: readonly ContextMessage[]): TitleTurnExcerpt {
  const firstUserIndex = messages.findIndex(isNaturalLanguagePrompt);
  if (firstUserIndex < 0) return {};
  const user = promptMetadataTextFromUserMessage(messages[firstUserIndex]!);
  const span: ContextMessage[] = [];
  for (const message of messages.slice(firstUserIndex + 1)) {
    if (isNaturalLanguagePrompt(message)) break;
    span.push(message);
  }
  return { user, assistant: finalAssistantText(span) };
}

function buildDigestExcerpt(messages: readonly ContextMessage[]): TitleDigestExcerpt {
  const seenMessageIds = new Set<string>();
  const userIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (!isNaturalLanguagePrompt(message)) continue;
    if (message.id !== undefined) {
      if (seenMessageIds.has(message.id)) continue;
      seenMessageIds.add(message.id);
    }
    userIndexes.push(index);
  }
  const turns: TitleDigestTurn[] = [];
  for (let i = 0; i < userIndexes.length; i++) {
    const userIndex = userIndexes[i]!;
    const user = promptMetadataTextFromUserMessage(messages[userIndex]!);
    if (user === undefined) continue;
    const spanEnd = i + 1 < userIndexes.length ? userIndexes[i + 1]! : messages.length;
    const assistant = finalAssistantText(messages.slice(userIndex + 1, spanEnd));
    turns.push({ user, assistant });
  }
  return { turns };
}

function turnExcerptScore(excerpt: TitleTurnExcerpt): number {
  return (excerpt.user === undefined ? 0 : 1) + (excerpt.assistant === undefined ? 0 : 1);
}

function digestExcerptScore(excerpt: TitleDigestExcerpt): number {
  return excerpt.turns.reduce(
    (score, turn) => score + (turn.assistant === undefined ? 1 : 2),
    0,
  );
}

function isNaturalLanguagePrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  return origin === undefined || origin.kind === 'user';
}

function promptMetadataTextFromUserMessage(message: ContextMessage): string | undefined {
  const bundled = message.origin?.kind === 'user' ? (message.origin.skillActivations?.length ?? 0) : 0;
  return promptMetadataTextFromContentParts(
    bundled === 0 ? message.content : message.content.slice(bundled),
  );
}

function finalAssistantText(messages: readonly ContextMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const text = assistantTextFromContentParts(message.content);
    if (text !== undefined) return text;
  }
  return undefined;
}

function assistantTextFromContentParts(parts: readonly ContentPart[]): string | undefined {
  const texts: string[] = [];
  for (const part of parts) {
    if (part.type === 'text' && part.text.trim().length > 0) texts.push(part.text);
  }
  if (texts.length === 0) return undefined;
  return promptMetadataTextFromText(texts.join('\n'));
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTitlePromptSource,
  AgentTitlePromptSourceService,
  ScopeActivation.OnDemand,
  'sessionTitle',
);
