import { isAbsolute, join, normalize, resolve } from 'pathe';

import type { BashSyntaxNode, IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';

export interface ResolvedCommandInvocation {
  readonly name: string;
  readonly rawName: string;
  readonly args: readonly (string | undefined)[];
  readonly dropped: boolean;
  readonly cwd: string | undefined;
}

export type ShellWriteTargetKind = 'target' | 'git-dir' | 'git-path';

export interface ShellWriteTarget {
  readonly candidate: string;
  readonly cwd: string | undefined;
  readonly kind?: ShellWriteTargetKind;
}

export interface ShellAnalysisResult {
  readonly unanalyzable: boolean;
  readonly commands: readonly ResolvedCommandInvocation[];
  readonly writeTargets: readonly ShellWriteTarget[];
}

export interface ShellAnalysisOptions {
  readonly initialCwd?: string;
  readonly homeDir?: string;
  readonly unsafeOperandPattern?: RegExp;
  readonly allowConcatenation?: boolean;
  readonly maxDepth?: number;
  readonly unwrapEnv?: boolean;
  readonly unwrapTimeout?: boolean;
  readonly unwrapStdbuf?: boolean;
  readonly unwrapBusybox?: boolean;
  readonly launchWrappers?: ReadonlySet<string>;
  readonly launchWrapperValueOptions?: ReadonlySet<string>;
  readonly dispatchFindExec?: boolean;
  readonly dispatchXargs?: boolean;
}

export const SHELL_PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

export const MAX_NESTED_SHELL_DEPTH = 4;

export const DEFAULT_UNSAFE_OPERAND = /[$`]/;

export const PRIVILEGE_WRAPPERS: ReadonlySet<string> = new Set(['sudo', 'doas']);

export const PRIVILEGE_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt',
  '-C',
  '--close-from',
  '-T',
  '--command-timeout',
  '-U',
  '--other-user',
  '-r',
  '--role',
  '-t',
  '--type',
]);

export const LAUNCH_WRAPPERS: ReadonlySet<string> = new Set([
  'command',
  'exec',
  'nohup',
  'builtin',
  'nice',
  'time',
  'setsid',
]);

export const ENV_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
]);

export const WRAPPER_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '-u',
  '--unset',
  '-C',
  '--chdir',
  '-S',
  '--split-string',
  '-a',
  '-n',
  '--adjustment',
]);

export const NESTED_SHELLS: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'ksh',
  'ash',
]);

export const WRITE_REDIRECT_OPS: ReadonlySet<string> = new Set([
  '>',
  '>>',
  '>|',
  '&>',
  '&>>',
  '<>',
]);

export const GIT_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'checkout',
  'restore',
  'reset',
  'clean',
  'commit',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'pull',
  'push',
  'stash',
  'apply',
  'am',
  'add',
  'rm',
  'mv',
  'switch',
  'branch',
  'tag',
  'worktree',
  'init',
  'fetch',
]);

export const GIT_BRANCH_MUTATE_FLAGS: ReadonlySet<string> = new Set([
  '-d',
  '-D',
  '-m',
  '-M',
  '-c',
  '-C',
  '--delete',
  '--move',
  '--copy',
  '--force',
]);

export const FIND_DESTRUCTIVE_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'unlink',
  'rmdir',
  'mv',
  'chmod',
  'chown',
  'truncate',
  'ln',
  'tee',
  'dd',
]);

export function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

export function extractLiteralText(
  node: BashSyntaxNode,
  unsafePattern: RegExp = DEFAULT_UNSAFE_OPERAND,
  allowConcatenation = true,
): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (unsafePattern.test(raw)) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, '$1');
      return unsafePattern.test(unescaped) ? undefined : unescaped;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      const value = node.text.slice(1, -1);
      return unsafePattern.test(value) ? undefined : value;
    }
    case 'string': {
      let value = '';
      for (const child of node.children) {
        if (child.type === 'string_content') {
          value += child.text;
        } else if (child.isNamed) {
          return undefined;
        }
      }
      return unsafePattern.test(value) ? undefined : value;
    }
    case 'concatenation': {
      if (!allowConcatenation) return undefined;
      let value = '';
      for (const child of node.children) {
        const piece = extractLiteralText(child, unsafePattern, allowConcatenation);
        if (piece === undefined) return undefined;
        value += piece;
      }
      return unsafePattern.test(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}

export function isFindExecDestructive(
  cmdName: string,
  cmdArgs: readonly (string | undefined)[],
): boolean {
  if (FIND_DESTRUCTIVE_COMMANDS.has(cmdName)) return true;
  if (cmdName === 'sed') {
    return cmdArgs.some(
      (arg) =>
        arg !== undefined &&
        (arg === '-i' ||
          arg.startsWith('-i') ||
          arg === '--in-place' ||
          arg.startsWith('--in-place=') ||
          /^-[a-zA-Z]*i/.test(arg)),
    );
  }
  if (cmdName === 'perl') {
    return cmdArgs.some(
      (arg) =>
        arg !== undefined &&
        (arg === '-i' || arg.startsWith('-i') || /^-[A-Za-z]*i/.test(arg)),
    );
  }
  return false;
}

export interface UnwrappedCommandHop {
  readonly name: string;
  readonly args: (string | undefined)[];
  readonly dropped: boolean;
  readonly isProbe?: boolean;
}

export interface UnwrapOptions {
  readonly unwrapEnv?: boolean;
  readonly unwrapTimeout?: boolean;
  readonly unwrapStdbuf?: boolean;
  readonly unwrapBusybox?: boolean;
  readonly launchWrappers?: ReadonlySet<string>;
  readonly launchWrapperValueOptions?: ReadonlySet<string>;
}

export function unwrapInvocation(
  rawName: string,
  rawArgs: readonly (string | undefined)[],
  options: UnwrapOptions = {},
): UnwrappedCommandHop {
  let name = normalizeCommandName(rawName);
  let args = [...rawArgs];
  let dropped = false;

  const launchWrappers = options.launchWrappers ?? LAUNCH_WRAPPERS;
  const launchValueOptions = options.launchWrapperValueOptions ?? WRAPPER_VALUE_OPTIONS;
  const unwrapEnv = options.unwrapEnv !== false;
  const unwrapTimeout = options.unwrapTimeout !== false;
  const unwrapStdbuf = options.unwrapStdbuf !== false;
  const unwrapBusybox = options.unwrapBusybox !== false;

  for (;;) {
    if (PRIVILEGE_WRAPPERS.has(name)) {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          dropped = true;
          i += 1;
          continue;
        }
        if (arg === '--') {
          i += 1;
          break;
        }
        if (!arg.startsWith('-')) break;
        if (!arg.includes('=') && PRIVILEGE_VALUE_OPTIONS.has(arg)) {
          i += 2;
          continue;
        }
        i += 1;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
      if (i < args.length && args[i] === undefined) {
        dropped = true;
      }
      break;
    }

    if (name === 'env' && unwrapEnv) {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          dropped = true;
          i += 1;
          continue;
        }
        if (arg === '--') {
          i += 1;
          break;
        }
        if (arg === '-' || arg === '-i' || arg === '--ignore-environment') {
          i += 1;
          continue;
        }
        if (!arg.includes('=') && ENV_VALUE_OPTIONS.has(arg)) {
          i += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          i += 1;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          i += 1;
          continue;
        }
        break;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
      if (i < args.length && args[i] === undefined) {
        dropped = true;
      }
      break;
    }

    if (launchWrappers.has(name)) {
      if (name === 'command') {
        let isProbe = false;
        for (const arg of args) {
          if (arg === undefined) continue;
          if (arg === '--') break;
          if (arg === '-') continue;
          if (!arg.startsWith('-')) break;
          if (/[vV]/.test(arg)) {
            isProbe = true;
            break;
          }
        }
        if (isProbe) {
          return { name, args, dropped, isProbe: true };
        }
      }
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          dropped = true;
          i += 1;
          continue;
        }
        if (arg === '--') {
          i += 1;
          break;
        }
        if (!arg.startsWith('-')) break;
        if (!arg.includes('=') && launchValueOptions.has(arg)) {
          i += 2;
          continue;
        }
        i += 1;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
      if (i < args.length && args[i] === undefined) {
        dropped = true;
      }
      break;
    }

    if (name === 'timeout' && unwrapTimeout) {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          dropped = true;
          i += 1;
          continue;
        }
        if (arg === '--') {
          i += 1;
          break;
        }
        if (
          arg === '-k' ||
          arg === '--kill-after' ||
          arg === '-s' ||
          arg === '--signal'
        ) {
          i += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          i += 1;
          continue;
        }
        break;
      }
      if (i < args.length) {
        if (args[i] === undefined) dropped = true;
        i += 1;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
      if (i < args.length && args[i] === undefined) {
        dropped = true;
      }
      break;
    }

    if (name === 'stdbuf' && unwrapStdbuf) {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          dropped = true;
          i += 1;
          continue;
        }
        if (arg === '--') {
          i += 1;
          break;
        }
        if (
          arg === '-i' ||
          arg === '-o' ||
          arg === '-e' ||
          arg === '--input' ||
          arg === '--output' ||
          arg === '--error'
        ) {
          i += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          i += 1;
          continue;
        }
        break;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
      if (i < args.length && args[i] === undefined) {
        dropped = true;
      }
      break;
    }

    if (name === 'busybox' && unwrapBusybox) {
      const applet = args[0];
      if (applet === undefined) {
        dropped = true;
        break;
      }
      if (applet.startsWith('-')) {
        break;
      }
      name = normalizeCommandName(applet);
      args = args.slice(1);
      continue;
    }

    break;
  }

  return { name, args, dropped };
}

function resolvePath(
  target: string,
  cwd: string | undefined,
  homeDir: string | undefined,
): string | undefined {
  if (target.length === 0) return undefined;
  if (/^\{[A-Za-z0-9_.-]*\}$/.test(target)) return undefined;
  if (isAbsolute(target)) return normalize(target);
  if (target === '~') return homeDir !== undefined ? normalize(homeDir) : undefined;
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return homeDir !== undefined ? normalize(join(homeDir, target.slice(2))) : undefined;
  }
  if (cwd !== undefined) return normalize(resolve(cwd, target));
  return undefined;
}

function handleCd(
  args: readonly (string | undefined)[],
  state: { cwd: string | undefined },
  homeDir: string | undefined,
): void {
  let target: string | undefined;
  for (const arg of args) {
    if (arg === undefined) {
      state.cwd = undefined;
      return;
    }
    if (arg === '--') continue;
    if (arg.startsWith('-')) continue;
    target = arg;
    break;
  }
  if (target === undefined) {
    state.cwd = homeDir !== undefined ? normalize(homeDir) : undefined;
    return;
  }
  state.cwd = resolvePath(target, state.cwd, homeDir);
}

function addWriteTarget(
  target: string,
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
  kind?: ShellWriteTargetKind,
): void {
  if (target.length === 0) return;
  if (/^\{[A-Za-z0-9_.-]*\}$/.test(target)) return;
  writeTargets.push(
    kind !== undefined ? { candidate: target, cwd, kind } : { candidate: target, cwd },
  );
}

function collectSimpleWriteFiles(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
  optionsWithValues?: ReadonlySet<string>,
): void {
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (optionsWithValues !== undefined && optionsWithValues.has(arg)) i += 1;
      continue;
    }
    addWriteTarget(arg, cwd, writeTargets);
  }
}

function collectTee(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    addWriteTarget(arg, cwd, writeTargets);
  }
}

function collectCp(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  let targetDir: string | undefined;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      i += 1;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDir = arg.slice('--target-directory='.length);
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-S' || arg === '--suffix') i += 1;
      continue;
    }
    operands.push(arg);
  }

  if (targetDir !== undefined) {
    addWriteTarget(targetDir, cwd, writeTargets);
    return;
  }
  if (operands.length >= 2) {
    addWriteTarget(operands[operands.length - 1]!, cwd, writeTargets);
  }
}

function collectMv(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  let targetDir: string | undefined;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      i += 1;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDir = arg.slice('--target-directory='.length);
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-S' || arg === '--suffix') i += 1;
      continue;
    }
    operands.push(arg);
  }

  if (targetDir !== undefined) {
    addWriteTarget(targetDir, cwd, writeTargets);
  }
  for (const operand of operands) {
    addWriteTarget(operand, cwd, writeTargets);
  }
}

function collectLn(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  let targetDir: string | undefined;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      i += 1;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDir = arg.slice('--target-directory='.length);
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-S' || arg === '--suffix') i += 1;
      continue;
    }
    operands.push(arg);
  }

  if (targetDir !== undefined) {
    addWriteTarget(targetDir, cwd, writeTargets);
    return;
  }
  if (operands.length === 1) {
    if (cwd !== undefined) {
      addWriteTarget(cwd, cwd, writeTargets);
    }
    return;
  }
  if (operands.length >= 2) {
    addWriteTarget(operands[operands.length - 1]!, cwd, writeTargets);
  }
}

function collectSed(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  const isInPlace = args.some(
    (arg) =>
      arg !== undefined &&
      (arg === '-i' ||
        arg.startsWith('-i') ||
        arg === '--in-place' ||
        arg.startsWith('--in-place=') ||
        /^-[a-zA-Z]*i/.test(arg)),
  );
  if (!isInPlace) return;

  const hasExplicitScript = args.some(
    (arg) =>
      arg !== undefined &&
      (arg === '-e' ||
        arg.startsWith('-e') ||
        arg === '-f' ||
        arg.startsWith('-f') ||
        arg.startsWith('--expression=') ||
        arg.startsWith('--file=')),
  );

  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (
      !optionsEnded &&
      (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file')
    ) {
      i += 1;
      continue;
    }
    if (
      !optionsEnded &&
      (arg === '-i' ||
        arg.startsWith('-i') ||
        arg === '--in-place' ||
        arg.startsWith('--in-place='))
    ) {
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      continue;
    }
    if (arg.length === 0) continue;
    operands.push(arg);
  }

  const files = hasExplicitScript ? operands : operands.slice(1);
  for (const file of files) {
    if (file.length === 0) continue;
    addWriteTarget(file, cwd, writeTargets);
  }
}

function collectGit(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  homeDir: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  let gitCwd: string | undefined;
  let gitWorkTree: string | undefined;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i += 1;
      continue;
    }
    if (arg === '--') {
      i += 1;
      break;
    }
    if (arg === '-C') {
      i += 1;
      if (i < args.length && args[i] !== undefined) {
        gitCwd = resolvePath(args[i]!, cwd, homeDir);
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      gitCwd = resolvePath(arg.slice(2), cwd, homeDir);
      i += 1;
      continue;
    }
    if (arg === '--work-tree') {
      i += 1;
      if (i < args.length && args[i] !== undefined) {
        gitWorkTree = resolvePath(args[i]!, cwd, homeDir);
      }
      i += 1;
      continue;
    }
    if (arg.startsWith('--work-tree=')) {
      gitWorkTree = resolvePath(arg.slice('--work-tree='.length), cwd, homeDir);
      i += 1;
      continue;
    }
    if (arg === '-c' || arg === '--git-dir') {
      i += 2;
      continue;
    }
    if (!arg.startsWith('-')) break;
    i += 1;
  }

  const subcommand = i < args.length ? args[i] : undefined;
  if (subcommand === undefined) return;
  const restArgs = args.slice(i + 1);

  if (!GIT_MUTATING_COMMANDS.has(subcommand)) return;

  if (subcommand === 'tag') {
    const isListing =
      restArgs.length === 0 ||
      restArgs.includes('-l') ||
      restArgs.includes('--list') ||
      restArgs.every(
        (a) => a !== undefined && a.startsWith('-') && a !== '-d' && a !== '--delete',
      );
    if (isListing) return;
  }

  if (subcommand === 'branch') {
    const hasListFlag = restArgs.includes('-l') || restArgs.includes('--list');
    const isListing =
      restArgs.length === 0 ||
      (hasListFlag && !restArgs.some((a) => a !== undefined && GIT_BRANCH_MUTATE_FLAGS.has(a))) ||
      (!hasListFlag &&
        restArgs.every(
          (a) =>
            a !== undefined &&
            (a.startsWith('-') ||
              a === 'HEAD' ||
              restArgs.includes('--contains') ||
              restArgs.includes('--no-contains') ||
              restArgs.includes('--merged') ||
              restArgs.includes('--no-merged') ||
              restArgs.includes('--points-at')) &&
            !GIT_BRANCH_MUTATE_FLAGS.has(a),
        ));
    if (isListing) return;
  }

  if (subcommand === 'stash') {
    if (restArgs[0] === 'list' || restArgs[0] === 'show') return;
  }
  if (subcommand === 'worktree') {
    if (restArgs[0] === 'list') return;
  }

  const effectiveGitDir = gitWorkTree ?? gitCwd ?? cwd;
  if (effectiveGitDir !== undefined) {
    addWriteTarget(effectiveGitDir, cwd, writeTargets, 'git-dir');
  }

  let pastSeparator = false;
  for (const arg of restArgs) {
    if (arg === undefined) continue;
    if (arg === '--') {
      pastSeparator = true;
      continue;
    }
    if (pastSeparator || arg.includes('/') || arg === '.') {
      addWriteTarget(arg, effectiveGitDir ?? cwd, writeTargets, 'git-path');
    }
  }
}

function collectDd(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  for (const arg of args) {
    if (arg === undefined) continue;
    if (arg.startsWith('of=')) {
      addWriteTarget(arg.slice('of='.length), cwd, writeTargets);
    }
  }
}

function collectRsync(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-e' || arg === '--exclude' || arg === '--include') i += 1;
      continue;
    }
    operands.push(arg);
  }
  if (operands.length >= 2) {
    addWriteTarget(operands[operands.length - 1]!, cwd, writeTargets);
  }
}

function collectPerl(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  const isInPlace = args.some(
    (arg) =>
      arg !== undefined &&
      (arg === '-i' || arg.startsWith('-i') || /^-[A-Za-z]*i/.test(arg)),
  );
  if (!isInPlace) return;
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-e' || arg === '-E')) {
      i += 1;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const hasScriptFlag = args.some(
    (arg) => arg !== undefined && (arg === '-e' || arg === '-E'),
  );
  const files = hasScriptFlag ? operands : operands.slice(1);
  for (const file of files) {
    addWriteTarget(file, cwd, writeTargets);
  }
}

function collectCurl(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-o' || arg === '--output') {
      i += 1;
      if (i < args.length && args[i] !== undefined && args[i] !== '-') {
        addWriteTarget(args[i]!, cwd, writeTargets);
      }
      continue;
    }
    if (arg.startsWith('--output=')) {
      const target = arg.slice('--output='.length);
      if (target !== '-') addWriteTarget(target, cwd, writeTargets);
    }
  }
}

function collectWget(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-O' || arg === '--output-document') {
      i += 1;
      if (i < args.length && args[i] !== undefined && args[i] !== '-') {
        addWriteTarget(args[i]!, cwd, writeTargets);
      }
      continue;
    }
    if (arg.startsWith('--output-document=')) {
      const target = arg.slice('--output-document='.length);
      if (target !== '-') addWriteTarget(target, cwd, writeTargets);
    }
  }
}

function collectPatch(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  homeDir: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  if (args.some((a) => a === '--dry-run' || a === '--check' || a === '-C')) return;
  let targetDir: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-d' || arg === '--directory') {
      i += 1;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (arg.startsWith('-d') && arg.length > 2) {
      targetDir = arg.slice(2);
      continue;
    }
    if (arg.startsWith('--directory=')) {
      targetDir = arg.slice('--directory='.length);
      continue;
    }
    if (arg === '-o' || arg === '--output') {
      i += 1;
      if (i < args.length && args[i] !== undefined) {
        addWriteTarget(args[i]!, cwd, writeTargets);
      }
      continue;
    }
    if (arg.startsWith('--output=')) {
      addWriteTarget(arg.slice('--output='.length), cwd, writeTargets);
      continue;
    }
  }
  const effectiveDir = targetDir !== undefined ? resolvePath(targetDir, cwd, homeDir) : cwd;
  if (effectiveDir !== undefined) {
    addWriteTarget(effectiveDir, cwd, writeTargets);
  }
}

function collectChmodChown(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '--reference' || arg.startsWith('--reference='))) {
      if (arg === '--reference') i += 1;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  for (const file of operands.slice(1)) {
    addWriteTarget(file, cwd, writeTargets);
  }
}

function collectTar(
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  homeDir: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  const firstArg = args[0];
  const isLegacyCluster =
    firstArg !== undefined && !firstArg.startsWith('-') && /^[A-Za-z]+$/.test(firstArg);

  const isExtracting =
    (isLegacyCluster && firstArg.includes('x')) ||
    args.some(
      (arg) =>
        arg !== undefined &&
        (arg === '-x' ||
          arg === '--extract' ||
          arg === '--get' ||
          (arg.startsWith('-') && !arg.startsWith('--') && /^-[A-Za-z]*x/.test(arg))),
    );

  const isCreating =
    (isLegacyCluster && /[cru]/.test(firstArg)) ||
    args.some(
      (arg) =>
        arg !== undefined &&
        (arg === '-c' ||
          arg === '-r' ||
          arg === '-u' ||
          arg === '--create' ||
          arg === '--append' ||
          arg === '--update' ||
          (arg.startsWith('-') && !arg.startsWith('--') && /^-[A-Za-z]*[cru]/.test(arg))),
    );

  if (isExtracting) {
    let targetDir: string | undefined;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === '-C' || arg === '--directory') {
        i += 1;
        if (i < args.length && args[i] !== undefined) targetDir = args[i];
        continue;
      }
      if (arg.startsWith('--directory=')) {
        targetDir = arg.slice('--directory='.length);
        continue;
      }
    }
    const effectiveDir = targetDir !== undefined ? resolvePath(targetDir, cwd, homeDir) : cwd;
    if (effectiveDir !== undefined) {
      addWriteTarget(effectiveDir, cwd, writeTargets);
    }
    return;
  }

  if (isCreating) {
    let archiveFile: string | undefined;
    if (isLegacyCluster && firstArg.includes('f') && args.length > 1 && args[1] !== undefined) {
      archiveFile = args[1];
    } else {
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === undefined) continue;
        if (arg === '-f' || arg === '--file') {
          i += 1;
          if (i < args.length && args[i] !== undefined) archiveFile = args[i];
          continue;
        }
        if (arg.startsWith('-') && !arg.startsWith('--') && arg.endsWith('f')) {
          i += 1;
          if (i < args.length && args[i] !== undefined) archiveFile = args[i];
          continue;
        }
        if (arg.startsWith('-f') && arg.length > 2) {
          archiveFile = arg.slice(2);
          continue;
        }
        if (arg.startsWith('--file=')) {
          archiveFile = arg.slice('--file='.length);
          continue;
        }
      }
    }
    if (archiveFile !== undefined && archiveFile !== '-') {
      addWriteTarget(archiveFile, cwd, writeTargets);
    }
    if (args.includes('--remove-files')) {
      const operands: string[] = [];
      let optionsEnded = false;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === undefined) continue;
        if (!optionsEnded && arg === '--') {
          optionsEnded = true;
          continue;
        }
        if (
          !optionsEnded &&
          (arg === '-f' || arg === '--file' || arg === '-C' || arg === '--directory')
        ) {
          i += 1;
          continue;
        }
        if (!optionsEnded && arg.startsWith('-')) continue;
        operands.push(arg);
      }
      for (const op of operands) {
        addWriteTarget(op, cwd, writeTargets);
      }
    }
  }
}

function collectNodePythonEval(
  name: string,
  args: readonly (string | undefined)[],
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
): void {
  let code: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (
      (name === 'node' && (arg === '-e' || arg === '--eval')) ||
      ((name === 'python' || name === 'python3') && arg === '-c')
    ) {
      if (i + 1 < args.length && args[i + 1] !== undefined) {
        code = args[i + 1];
      }
      break;
    }
  }
  if (code === undefined) return;
  const directWritePattern =
    /(?:writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|rmSync|unlinkSync|rmdirSync|truncateSync|os\.remove|os\.unlink|os\.rmdir|shutil\.rmtree|write_text|write_bytes)\s*\(\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = directWritePattern.exec(code)) !== null) {
    const target = match[1];
    if (target !== undefined && target.length > 0) {
      addWriteTarget(target, cwd, writeTargets);
    }
  }

  const openWithModePattern =
    /(?:open|openSync)\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*[wax+][^'"]*)['"]/g;
  while ((match = openWithModePattern.exec(code)) !== null) {
    const target = match[1];
    if (target !== undefined && target.length > 0) {
      addWriteTarget(target, cwd, writeTargets);
    }
  }
}

function collectRedirect(
  node: BashSyntaxNode,
  cwd: string | undefined,
  writeTargets: ShellWriteTarget[],
  unsafePattern: RegExp,
  allowConcatenation: boolean,
): void {
  let op: string | undefined;
  let opIndex = -1;
  for (let i = 0; i < node.children.length; i += 1) {
    const text = node.children[i]!.text;
    if (
      WRITE_REDIRECT_OPS.has(text) ||
      text === '>&' ||
      text === '<' ||
      text === '<&' ||
      text === '>&-' ||
      text === '<&-'
    ) {
      op = text;
      opIndex = i;
      break;
    }
  }
  if (op === undefined) return;
  const destNode = node.children.slice(opIndex + 1).find((child) => child.isNamed);
  if (destNode === undefined) return;

  if (WRITE_REDIRECT_OPS.has(op)) {
    const dest = extractLiteralText(destNode, unsafePattern, allowConcatenation);
    if (dest !== undefined) {
      addWriteTarget(dest, cwd, writeTargets);
    }
    return;
  }

  if (op === '>&') {
    const dest = extractLiteralText(destNode, unsafePattern, allowConcatenation);
    if (dest !== undefined && !/^[0-9]+$/.test(dest) && dest !== '-') {
      addWriteTarget(dest, cwd, writeTargets);
    }
  }
}

interface TraversalContext {
  readonly parser: IBashParserService;
  readonly homeDir: string | undefined;
  readonly unsafePattern: RegExp;
  readonly allowConcatenation: boolean;
  readonly maxDepth: number | undefined;
  readonly unwrapEnv: boolean;
  readonly unwrapTimeout: boolean;
  readonly unwrapStdbuf: boolean;
  readonly unwrapBusybox: boolean;
  readonly launchWrappers: ReadonlySet<string>;
  readonly launchWrapperValueOptions: ReadonlySet<string>;
  readonly dispatchFindExec: boolean;
  readonly dispatchXargs: boolean;
  readonly commands: ResolvedCommandInvocation[];
  readonly writeTargets: ShellWriteTarget[];
  unanalyzable: boolean;
}

function dispatchCommand(
  rawName: string,
  rawArgs: readonly (string | undefined)[],
  dropped: boolean,
  state: { cwd: string | undefined },
  depth: number,
  context: TraversalContext,
): void {
  if (context.maxDepth !== undefined && depth > context.maxDepth) {
    context.unanalyzable = true;
    return;
  }

  const normalizedRaw = normalizeCommandName(rawName);
  const unwrapped = unwrapInvocation(rawName, rawArgs, {
    unwrapEnv: context.unwrapEnv,
    unwrapTimeout: context.unwrapTimeout,
    unwrapStdbuf: context.unwrapStdbuf,
    unwrapBusybox: context.unwrapBusybox,
    launchWrappers: context.launchWrappers,
    launchWrapperValueOptions: context.launchWrapperValueOptions,
  });
  const finalDropped =
    dropped ||
    unwrapped.dropped ||
    unwrapped.args.some((a) => a === undefined);

  if (
    unwrapped.name === normalizedRaw &&
    finalDropped &&
    (PRIVILEGE_WRAPPERS.has(normalizedRaw) ||
      context.launchWrappers.has(normalizedRaw) ||
      (context.unwrapEnv && normalizedRaw === 'env') ||
      (context.unwrapTimeout && normalizedRaw === 'timeout') ||
      (context.unwrapStdbuf && normalizedRaw === 'stdbuf'))
  ) {
    context.unanalyzable = true;
  }

  context.commands.push({
    name: unwrapped.name,
    rawName,
    args: unwrapped.args,
    dropped: finalDropped,
    cwd: state.cwd,
  });

  const name = unwrapped.name;
  const args = unwrapped.args;

  if (name === 'cd' || name === 'pushd') {
    handleCd(args, state, context.homeDir);
    return;
  }
  if (name === 'rm' || name === 'unlink' || name === 'rmdir') {
    collectSimpleWriteFiles(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'mkdir') {
    collectSimpleWriteFiles(args, state.cwd, context.writeTargets, new Set(['-m', '--mode']));
    return;
  }
  if (name === 'touch') {
    collectSimpleWriteFiles(args, state.cwd, context.writeTargets, new Set(['-d', '-t', '-r']));
    return;
  }
  if (name === 'truncate') {
    collectSimpleWriteFiles(args, state.cwd, context.writeTargets, new Set(['-s', '-r']));
    return;
  }
  if (name === 'tee') {
    collectTee(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'cp' || name === 'install') {
    collectCp(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'mv') {
    collectMv(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'ln') {
    collectLn(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'sed') {
    collectSed(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'git') {
    collectGit(args, state.cwd, context.homeDir, context.writeTargets);
    return;
  }
  if (name === 'dd') {
    collectDd(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'rsync') {
    collectRsync(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'perl') {
    collectPerl(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'curl') {
    collectCurl(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'wget') {
    collectWget(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'patch') {
    collectPatch(args, state.cwd, context.homeDir, context.writeTargets);
    return;
  }
  if (name === 'chmod' || name === 'chown') {
    collectChmodChown(args, state.cwd, context.writeTargets);
    return;
  }
  if (name === 'tar') {
    collectTar(args, state.cwd, context.homeDir, context.writeTargets);
    return;
  }
  if (name === 'find') {
    const hasDelete = args.includes('-delete');
    const execIndex = args.findIndex((arg) => arg === '-exec' || arg === '-execdir');

    const paths: string[] = [];
    for (const arg of args) {
      if (arg === undefined) continue;
      if (arg.startsWith('-') || arg === '!' || arg === '(' || arg === ')') break;
      paths.push(arg);
    }
    if (paths.length === 0) paths.push('.');

    if (hasDelete) {
      for (const p of paths) {
        addWriteTarget(p, state.cwd, context.writeTargets);
      }
    }

    if (execIndex >= 0 && execIndex + 1 < args.length) {
      const execArgs: (string | undefined)[] = [];
      for (let i = execIndex + 1; i < args.length; i += 1) {
        const a = args[i];
        if (a === ';' || a === '+') break;
        execArgs.push(a);
      }
      const execCmd = execArgs[0];
      if (execCmd !== undefined) {
        const unwrappedExec = unwrapInvocation(execCmd, execArgs.slice(1), {
          unwrapEnv: context.unwrapEnv,
          unwrapTimeout: context.unwrapTimeout,
          unwrapStdbuf: context.unwrapStdbuf,
          unwrapBusybox: context.unwrapBusybox,
          launchWrappers: context.launchWrappers,
          launchWrapperValueOptions: context.launchWrapperValueOptions,
        });
        if (isFindExecDestructive(unwrappedExec.name, unwrappedExec.args)) {
          for (const p of paths) {
            addWriteTarget(p, state.cwd, context.writeTargets);
          }
        }
        if (context.dispatchFindExec) {
          dispatchCommand(
            execCmd,
            execArgs.slice(1),
            execArgs.some((a) => a === undefined),
            state,
            depth + 1,
            context,
          );
        }
      }
    }
    return;
  }
  if (name === 'xargs') {
    if (!context.dispatchXargs) return;
    let i = 0;
    while (i < args.length) {
      const arg = args[i];
      if (arg === undefined) {
        i += 1;
        continue;
      }
      if (arg === '--') {
        i += 1;
        break;
      }
      if (arg === '-I' || arg === '-i') {
        i += 2;
        continue;
      }
      if (arg.startsWith('-I') || arg.startsWith('-i')) {
        i += 1;
        continue;
      }
      if (
        arg === '-n' ||
        arg === '-P' ||
        arg === '-s' ||
        arg === '-d' ||
        arg === '-E' ||
        arg === '-L'
      ) {
        i += 2;
        continue;
      }
      if (!arg.startsWith('-')) break;
      i += 1;
    }
    const subCmd = i < args.length ? args[i] : undefined;
    if (subCmd !== undefined) {
      dispatchCommand(
        subCmd,
        args.slice(i + 1),
        args.slice(i).some((a) => a === undefined),
        state,
        depth + 1,
        context,
      );
    }
    return;
  }
  if (name === 'node' || name === 'python' || name === 'python3') {
    collectNodePythonEval(name, args, state.cwd, context.writeTargets);
    return;
  }
  if (NESTED_SHELLS.has(name)) {
    let payloadIndex = -1;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === '--') break;
      if (/^-[a-zA-Z]+$/.test(arg)) {
        if (arg.includes('c')) payloadIndex = i + 1;
      } else {
        break;
      }
    }
    if (payloadIndex >= 0) {
      const payload = args[payloadIndex];
      if (payload === undefined) {
        context.unanalyzable = true;
      } else if (context.maxDepth !== undefined && depth + 1 > context.maxDepth) {
        context.unanalyzable = true;
      } else {
        const subState = { cwd: state.cwd };
        walkScript(payload, subState, depth + 1, context);
      }
      return;
    }
    if (finalDropped) {
      context.unanalyzable = true;
    }
    return;
  }
  if (name === 'eval') {
    if (args.length === 0) {
      if (finalDropped) context.unanalyzable = true;
      return;
    }
    if (finalDropped || (context.maxDepth !== undefined && depth + 1 > context.maxDepth)) {
      context.unanalyzable = true;
      return;
    }
    const script = args.join(' ');
    const subState = { cwd: state.cwd };
    walkScript(script, subState, depth + 1, context);
    return;
  }
}

function walkScript(
  source: string,
  state: { cwd: string | undefined },
  depth: number,
  context: TraversalContext,
): void {
  const parsed = context.parser.parse(source, SHELL_PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) {
    context.unanalyzable = true;
    return;
  }
  walkNode(parsed.root, state, depth, context);
}

function walkNode(
  node: BashSyntaxNode,
  state: { cwd: string | undefined },
  depth: number,
  context: TraversalContext,
): void {
  if (node.type === 'file_redirect') {
    collectRedirect(node, state.cwd, context.writeTargets, context.unsafePattern, context.allowConcatenation);
    for (const child of node.children) {
      if (child.isNamed) walkNode(child, state, depth, context);
    }
    return;
  }

  if (node.type === 'command_substitution' || node.type === 'process_substitution') {
    const subState = { cwd: state.cwd };
    for (const child of node.children) {
      if (child.isNamed) walkNode(child, subState, depth, context);
    }
    return;
  }

  if (node.type === 'program' || node.type === 'compound_statement' || node.type === 'list') {
    for (const child of node.children) {
      if (child.isNamed) {
        walkNode(child, state, depth, context);
      }
    }
    return;
  }

  if (node.type === 'subshell') {
    const savedCwd = state.cwd;
    const subState = { cwd: savedCwd };
    for (const child of node.children) {
      if (child.isNamed) {
        walkNode(child, subState, depth, context);
      }
    }
    state.cwd = savedCwd;
    return;
  }

  if (node.type === 'pipeline') {
    const savedCwd = state.cwd;
    for (const child of node.children) {
      if (child.isNamed) {
        const subState = { cwd: savedCwd };
        walkNode(child, subState, depth, context);
      }
    }
    state.cwd = savedCwd;
    return;
  }

  if (
    node.type === 'redirected_statement' ||
    node.type === 'heredoc_redirect' ||
    node.type === 'herestring_redirect'
  ) {
    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        collectRedirect(child, state.cwd, context.writeTargets, context.unsafePattern, context.allowConcatenation);
        for (const c of child.children) {
          if (c.isNamed) walkNode(c, state, depth, context);
        }
      } else if (child.isNamed) {
        walkNode(child, state, depth, context);
      }
    }
    return;
  }

  if (node.type === 'negated_command') {
    for (const child of node.children) {
      if (child.isNamed) {
        walkNode(child, state, depth, context);
      }
    }
    return;
  }

  if (
    node.type === 'if_statement' ||
    node.type === 'while_statement' ||
    node.type === 'for_statement'
  ) {
    const savedCwd = state.cwd;
    let anyChanged = false;
    for (const child of node.children) {
      if (child.isNamed) {
        const branchState = { cwd: savedCwd };
        walkNode(child, branchState, depth, context);
        if (branchState.cwd !== savedCwd) anyChanged = true;
      }
    }
    if (anyChanged) state.cwd = undefined;
    return;
  }

  if (node.type === 'command') {
    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        collectRedirect(child, state.cwd, context.writeTargets, context.unsafePattern, context.allowConcatenation);
        for (const c of child.children) {
          if (c.isNamed) walkNode(c, state, depth, context);
        }
      }
    }

    const nameIndex = node.children.findIndex((c) => c.type === 'command_name');
    if (nameIndex < 0) {
      if (
        node.children.some(
          (c) =>
            c.isNamed &&
            c.type !== 'variable_assignment' &&
            c.type !== 'file_redirect',
        )
      ) {
        context.unanalyzable = true;
      }
      for (const child of node.children) {
        if (child.isNamed && child.type !== 'file_redirect') {
          walkNode(child, state, depth, context);
        }
      }
      return;
    }

    const nameNode = node.children[nameIndex]!;
    const nameWord = nameNode.children.find((c) => c.isNamed) ?? nameNode;
    const rawName = extractLiteralText(nameWord, context.unsafePattern, context.allowConcatenation);
    if (rawName === undefined || rawName.length === 0) {
      context.unanalyzable = true;
      for (const child of node.children) {
        if (child.isNamed && child.type !== 'file_redirect') {
          walkNode(child, state, depth, context);
        }
      }
      return;
    }

    for (const child of node.children.slice(0, nameIndex)) {
      if (child.isNamed && child.type !== 'file_redirect') {
        walkNode(child, state, depth, context);
      }
    }

    let dropped = false;
    const rawArgs: (string | undefined)[] = [];
    for (const child of node.children.slice(nameIndex + 1)) {
      if (
        child.type === 'file_redirect' ||
        child.type === 'heredoc_redirect' ||
        child.type === 'herestring_redirect' ||
        child.type === 'variable_assignment'
      ) {
        continue;
      }
      if (
        child.type === 'command_substitution' ||
        child.type === 'process_substitution'
      ) {
        const subState = { cwd: state.cwd };
        for (const subChild of child.children) {
          if (subChild.isNamed) walkNode(subChild, subState, depth, context);
        }
        rawArgs.push(undefined);
        dropped = true;
        continue;
      }
      const val = extractLiteralText(child, context.unsafePattern, context.allowConcatenation);
      if (val === undefined) dropped = true;
      rawArgs.push(val);
    }

    dispatchCommand(rawName, rawArgs, dropped, state, depth, context);
    return;
  }

  for (const child of node.children) {
    if (child.type === 'file_redirect') {
      collectRedirect(child, state.cwd, context.writeTargets, context.unsafePattern, context.allowConcatenation);
    } else if (child.isNamed) {
      walkNode(child, state, depth, context);
    }
  }
}

export function analyzeShellCommand(
  source: string,
  bashParser?: IBashParserService,
  options?: ShellAnalysisOptions,
): ShellAnalysisResult {
  const parser = bashParser ?? new BashParserService();
  const parsed = parser.parse(source, SHELL_PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) {
    return {
      unanalyzable: true,
      commands: [],
      writeTargets: [],
    };
  }

  const initialCwd =
    options?.initialCwd !== undefined && options.initialCwd.length > 0
      ? normalize(options.initialCwd)
      : undefined;
  const homeDir =
    options?.homeDir !== undefined && options.homeDir.length > 0
      ? normalize(options.homeDir)
      : undefined;
  const unsafePattern = options?.unsafeOperandPattern ?? DEFAULT_UNSAFE_OPERAND;
  const allowConcatenation = options?.allowConcatenation !== false;
  const maxDepth = options?.maxDepth;
  const unwrapEnv = options?.unwrapEnv !== false;
  const unwrapTimeout = options?.unwrapTimeout !== false;
  const unwrapStdbuf = options?.unwrapStdbuf !== false;
  const unwrapBusybox = options?.unwrapBusybox !== false;
  const launchWrappers = options?.launchWrappers ?? LAUNCH_WRAPPERS;
  const launchWrapperValueOptions = options?.launchWrapperValueOptions ?? WRAPPER_VALUE_OPTIONS;
  const dispatchFindExec = options?.dispatchFindExec !== false;
  const dispatchXargs = options?.dispatchXargs !== false;

  const state = { cwd: initialCwd };
  const context: TraversalContext = {
    parser,
    homeDir,
    unsafePattern,
    allowConcatenation,
    maxDepth,
    unwrapEnv,
    unwrapTimeout,
    unwrapStdbuf,
    unwrapBusybox,
    launchWrappers,
    launchWrapperValueOptions,
    dispatchFindExec,
    dispatchXargs,
    commands: [],
    writeTargets: [],
    unanalyzable: false,
  };

  walkNode(parsed.root, state, 0, context);

  return {
    unanalyzable: context.unanalyzable,
    commands: context.commands,
    writeTargets: context.writeTargets,
  };
}
