import { IBashParserService } from '#/app/bashParser/bashParser';
import { IConfigService } from '#/app/config/config';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { isDangerousCommandGuardEnabled } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type {
  PermissionPolicy,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import {
  analyzeShellCommand,
  WRAPPER_VALUE_OPTIONS,
} from '#/app/shellAnalysis/shellAnalysis';

const UNSAFE_OPERAND = /[$`*?[\]~]/;

const POLICY_LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
]);

const SIMPLE_DANGEROUS_COMMANDS: ReadonlySet<string> = new Set([
  'shutdown',
  'halt',
  'poweroff',
  'reboot',
  'bcdedit',
  'diskpart',
  'format',
  'restart-computer',
  'stop-computer',
  'mkfs',
  'wipefs',
]);

const SYSTEMCTL_DANGEROUS_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'poweroff',
  'reboot',
  'halt',
  'kexec',
]);

const SYSTEMCTL_VALUE_OPTIONS: ReadonlySet<string> = new Set(['-H', '--host', '-M', '--machine']);

const DD_SAFE_DEVICE_TARGETS: ReadonlySet<string> = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/random',
  '/dev/urandom',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
]);

const RM_SAFE_TEMP_ROOTS: readonly string[] = ['/tmp', '/temp'];

function isSafeTempRmOperand(operand: string): boolean {
  for (const segment of operand.split('/')) {
    if (segment === '..') return false;
  }
  return RM_SAFE_TEMP_ROOTS.some((root) => operand === root || operand.startsWith(`${root}/`));
}

type DangerousVerdict =
  | { readonly kind: 'dangerous'; readonly command: string }
  | { readonly kind: 'unanalyzable' };

export class DangerousCommandAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'dangerous-command-ask';

  constructor(
    @IBashParserService private readonly bashParser: IBashParserService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IConfigService private readonly config: IConfigService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (!isDangerousCommandGuardEnabled(this.config)) return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (context.toolCall.name !== 'Bash') return undefined;
    const command = bashCommandText(context.args);
    if (command === undefined) {
      if (this.modeService.mode === 'yolo') return undefined;
      return { kind: 'ask', reason: { unanalyzable_command: true } };
    }

    const analysis = analyzeShellCommand(command, this.bashParser, {
      unsafeOperandPattern: UNSAFE_OPERAND,
      allowConcatenation: false,
      maxDepth: 4,
      unwrapTimeout: false,
      unwrapStdbuf: false,
      unwrapBusybox: true,
      launchWrappers: POLICY_LAUNCH_WRAPPERS,
      launchWrapperValueOptions: WRAPPER_VALUE_OPTIONS,
      dispatchFindExec: false,
      dispatchXargs: false,
    });
    if (analysis.unanalyzable) {
      if (this.modeService.mode === 'yolo') return undefined;
      return { kind: 'ask', reason: { unanalyzable_command: true } };
    }

    for (const invocation of analysis.commands) {
      const verdict = analyzeInvocation(invocation.name, invocation.args, invocation.dropped);
      if (verdict !== undefined) {
        if (verdict.kind === 'dangerous') {
          return { kind: 'ask', reason: { dangerous_command: verdict.command } };
        }
        if (this.modeService.mode === 'yolo') return undefined;
        return { kind: 'ask', reason: { unanalyzable_command: true } };
      }
    }

    return undefined;
  }
}

function bashCommandText(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const command = (args as { readonly command?: unknown }).command;
  return typeof command === 'string' ? command : undefined;
}

function analyzeInvocation(
  name: string,
  args: readonly (string | undefined)[],
  dropped: boolean,
): DangerousVerdict | undefined {
  if (SIMPLE_DANGEROUS_COMMANDS.has(name) || name.startsWith('mkfs.')) {
    return { kind: 'dangerous', command: name };
  }
  if (name === 'init' || name === 'telinit') {
    if (args.some((arg) => arg === '0' || arg === '6')) {
      return { kind: 'dangerous', command: name };
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  if (name === 'systemctl') {
    const subcommand = dropLeadingOptions(args, SYSTEMCTL_VALUE_OPTIONS)[0];
    if (subcommand !== undefined && SYSTEMCTL_DANGEROUS_SUBCOMMANDS.has(subcommand)) {
      return { kind: 'dangerous', command: `systemctl ${subcommand}` };
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  if (name === 'dd') {
    for (const arg of args) {
      if (arg === undefined || !arg.startsWith('of=')) continue;
      const target = arg.slice('of='.length);
      if (target.startsWith('/dev/') && !DD_SAFE_DEVICE_TARGETS.has(target)) {
        return { kind: 'dangerous', command: 'dd' };
      }
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  if (name === 'rm') {
    let recursive = false;
    let force = false;
    const operands: string[] = [];
    let optionsEnded = false;
    for (const arg of args) {
      if (arg === undefined) continue;
      if (!optionsEnded && arg === '--') {
        optionsEnded = true;
        continue;
      }
      if (optionsEnded) {
        operands.push(arg);
        continue;
      }
      if (arg === '--recursive') {
        recursive = true;
      } else if (arg === '--force') {
        force = true;
      } else if (/^-[a-zA-Z]+$/.test(arg)) {
        if (/[rR]/.test(arg)) recursive = true;
        if (arg.includes('f')) force = true;
      } else {
        operands.push(arg);
      }
    }
    if (recursive && force) {
      if (!dropped && operands.length > 0 && operands.every(isSafeTempRmOperand)) {
        return undefined;
      }
      return { kind: 'dangerous', command: 'rm -rf' };
    }
    return dropped ? { kind: 'unanalyzable' } : undefined;
  }
  return undefined;
}

function dropLeadingOptions(
  args: readonly (string | undefined)[],
  valueOptions: ReadonlySet<string>,
): string[] {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--') {
      const rest: string[] = [];
      for (let j = i + 1; j < args.length; j += 1) {
        if (args[j] !== undefined) rest.push(args[j]!);
      }
      return rest;
    }
    if (arg === '-' || !arg.startsWith('-')) {
      const rest: string[] = [];
      for (let j = i; j < args.length; j += 1) {
        if (args[j] !== undefined) rest.push(args[j]!);
      }
      return rest;
    }
    if (!arg.includes('=') && valueOptions.has(arg)) i += 1;
  }
  return [];
}
