import { isAbsolute, join, normalize, resolve } from 'pathe';

import type { BashSyntaxNode, IBashParserService } from '#/app/bashParser/bashParser';
import { BashParserService } from '#/app/bashParser/bashParserService';
import { isWithinDirectory } from '#/tool/path-access';

export interface WorkerShellGuardOptions {
  readonly worktree: string;
  readonly initialCwd: string;
  readonly homeDir?: string;
}

export interface WorkerShellGuardResult {
  readonly allowed: boolean;
  readonly escapes: readonly string[];
}

const BASH_PARSE_OPTIONS = { timeoutMs: 500, maxNodes: 10_000 } as const;

const WRITE_REDIRECT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);

const SAFE_DEV_TARGETS = new Set([
  '/dev/null',
  '/dev/zero',
  '/dev/full',
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
]);

const GIT_MUTATING_COMMANDS = new Set([
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

const GIT_BRANCH_MUTATE_FLAGS = new Set([
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

function isFindExecDestructive(
  cmdName: string,
  cmdArgs: (string | undefined)[],
): boolean {
  if (
    cmdName === 'rm' ||
    cmdName === 'unlink' ||
    cmdName === 'rmdir' ||
    cmdName === 'mv' ||
    cmdName === 'chmod' ||
    cmdName === 'chown' ||
    cmdName === 'truncate' ||
    cmdName === 'ln' ||
    cmdName === 'tee' ||
    cmdName === 'dd'
  ) {
    return true;
  }
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

const PRIVILEGE_WRAPPERS = new Set(['sudo', 'doas']);
const LAUNCH_WRAPPERS = new Set(['command', 'exec', 'nohup', 'builtin', 'nice', 'time', 'setsid']);
const NESTED_SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);

function literalText(node: BashSyntaxNode): string | undefined {
  switch (node.type) {
    case 'word': {
      const raw = node.text;
      if (raw.includes('$') || raw.includes('`')) return undefined;
      const unescaped = raw.replaceAll(/\\(.)/gs, '$1');
      return unescaped.includes('$') || unescaped.includes('`') ? undefined : unescaped;
    }
    case 'number':
      return node.text;
    case 'raw_string': {
      if (node.text.length < 2) return undefined;
      return node.text.slice(1, -1);
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
      return value;
    }
    case 'concatenation': {
      let value = '';
      for (const child of node.children) {
        const piece = literalText(child);
        if (piece === undefined) return undefined;
        value += piece;
      }
      return value;
    }
    default:
      return undefined;
  }
}

function resolvePath(
  target: string,
  cwd: string | undefined,
  homeDir: string | undefined,
): string | undefined {
  if (target.length === 0) return undefined;
  if (/^\{[A-Za-z0-9_.-]*\}$/.test(target)) return undefined;
  if (isAbsolute(target)) {
    return normalize(target);
  }
  if (target === '~') {
    return homeDir !== undefined ? normalize(homeDir) : undefined;
  }
  if (target.startsWith('~/') || target.startsWith('~\\')) {
    return homeDir !== undefined ? normalize(join(homeDir, target.slice(2))) : undefined;
  }
  if (cwd !== undefined) {
    return normalize(resolve(cwd, target));
  }
  return undefined;
}

function normalizeCommandName(raw: string): string {
  let name = raw;
  const separator = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
  if (separator >= 0) name = name.slice(separator + 1);
  name = name.toLowerCase();
  if (name.endsWith('.exe')) name = name.slice(0, -'.exe'.length);
  return name;
}

function checkEscape(
  candidate: string,
  cwd: string | undefined,
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  if (candidate.length === 0) return;
  if (/^\{[A-Za-z0-9_.-]*\}$/.test(candidate)) return;
  if (SAFE_DEV_TARGETS.has(candidate)) return;
  const resolved = resolvePath(candidate, cwd, homeDir);
  if (resolved !== undefined && !isWithinDirectory(resolved, worktree)) {
    escapes.push(resolved);
  }
}

function checkRedirect(
  node: BashSyntaxNode,
  cwd: string | undefined,
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let op: string | undefined;
  let opIndex = -1;
  for (let i = 0; i < node.children.length; i++) {
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
    const dest = literalText(destNode);
    if (dest !== undefined) {
      checkEscape(dest, cwd, worktree, homeDir, escapes);
    }
    return;
  }

  if (op === '>&') {
    const dest = literalText(destNode);
    if (dest !== undefined && !/^[0-9]+$/.test(dest) && dest !== '-') {
      checkEscape(dest, cwd, worktree, homeDir, escapes);
    }
  }
}

interface Invocation {
  name: string;
  args: (string | undefined)[];
}

function unwrapInvocation(
  rawName: string,
  rawArgs: (string | undefined)[],
): Invocation {
  let name = normalizeCommandName(rawName);
  let args = rawArgs;

  for (;;) {
    if (PRIVILEGE_WRAPPERS.has(name)) {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          i++;
          continue;
        }
        if (arg === '--') {
          i++;
          break;
        }
        if (!arg.startsWith('-')) break;
        if (
          arg === '-u' ||
          arg === '--user' ||
          arg === '-g' ||
          arg === '--group' ||
          arg === '-p' ||
          arg === '--prompt'
        ) {
          i += 2;
          continue;
        }
        i++;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
    }

    if (name === 'env') {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          i++;
          continue;
        }
        if (arg === '--') {
          i++;
          break;
        }
        if (arg === '-' || arg === '-i' || arg === '--ignore-environment') {
          i++;
          continue;
        }
        if (arg === '-u' || arg === '--unset' || arg === '-C' || arg === '--chdir') {
          i += 2;
          continue;
        }
        if (arg.startsWith('-')) {
          i++;
          continue;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) {
          i++;
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
    }

    if (LAUNCH_WRAPPERS.has(name)) {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          i++;
          continue;
        }
        if (arg === '--') {
          i++;
          break;
        }
        if (!arg.startsWith('-')) break;
        i++;
      }
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
    }

    if (name === 'timeout') {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          i++;
          continue;
        }
        if (arg === '--') {
          i++;
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
          i++;
          continue;
        }
        break;
      }
      i++;
      const nextName = args[i];
      if (nextName !== undefined) {
        name = normalizeCommandName(nextName);
        args = args.slice(i + 1);
        continue;
      }
    }

    if (name === 'stdbuf') {
      let i = 0;
      while (i < args.length) {
        const arg = args[i];
        if (arg === undefined) {
          i++;
          continue;
        }
        if (arg === '--') {
          i++;
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
          i++;
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
    }

    break;
  }

  return { name, args };
}

function handleCd(
  args: (string | undefined)[],
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

function handleSimpleWriteFiles(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
  optionsWithValues: Set<string> = new Set(),
): void {
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (optionsWithValues.has(arg)) i++;
      continue;
    }
    checkEscape(arg, state.cwd, worktree, homeDir, escapes);
  }
}

function handleTee(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    checkEscape(arg, state.cwd, worktree, homeDir, escapes);
  }
}

function handleCp(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let targetDir: string | undefined;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      i++;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDir = arg.slice('--target-directory='.length);
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-S' || arg === '--suffix') i++;
      continue;
    }
    operands.push(arg);
  }

  if (targetDir !== undefined) {
    checkEscape(targetDir, state.cwd, worktree, homeDir, escapes);
    return;
  }

  if (operands.length >= 2) {
    const dest = operands[operands.length - 1]!;
    checkEscape(dest, state.cwd, worktree, homeDir, escapes);
  }
}

function handleMv(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let targetDir: string | undefined;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      i++;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDir = arg.slice('--target-directory='.length);
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-S' || arg === '--suffix') i++;
      continue;
    }
    operands.push(arg);
  }

  if (targetDir !== undefined) {
    checkEscape(targetDir, state.cwd, worktree, homeDir, escapes);
  }
  for (const operand of operands) {
    checkEscape(operand, state.cwd, worktree, homeDir, escapes);
  }
}

function handleLn(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let targetDir: string | undefined;
  const operands: string[] = [];
  let optionsEnded = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-t' || arg === '--target-directory')) {
      i++;
      if (i < args.length && args[i] !== undefined) targetDir = args[i];
      continue;
    }
    if (!optionsEnded && arg.startsWith('--target-directory=')) {
      targetDir = arg.slice('--target-directory='.length);
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-S' || arg === '--suffix') i++;
      continue;
    }
    operands.push(arg);
  }

  if (targetDir !== undefined) {
    checkEscape(targetDir, state.cwd, worktree, homeDir, escapes);
    return;
  }

  if (operands.length === 1) {
    if (state.cwd !== undefined && !isWithinDirectory(state.cwd, worktree)) {
      escapes.push(state.cwd);
    }
    return;
  }

  if (operands.length >= 2) {
    const dest = operands[operands.length - 1]!;
    checkEscape(dest, state.cwd, worktree, homeDir, escapes);
  }
}

function handleSed(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-e' || arg === '-f' || arg === '--expression' || arg === '--file')) {
      i++;
      continue;
    }
    if (!optionsEnded && (arg === '-i' || arg.startsWith('-i') || arg === '--in-place' || arg.startsWith('--in-place='))) {
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
    checkEscape(file, state.cwd, worktree, homeDir, escapes);
  }
}

function handleGit(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let gitCwd: string | undefined;
  let gitWorkTree: string | undefined;
  let i = 0;

  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '-C') {
      i++;
      if (i < args.length && args[i] !== undefined) {
        gitCwd = resolvePath(args[i]!, state.cwd, homeDir);
      }
      i++;
      continue;
    }
    if (arg.startsWith('-C') && arg.length > 2) {
      gitCwd = resolvePath(arg.slice(2), state.cwd, homeDir);
      i++;
      continue;
    }
    if (arg === '--work-tree') {
      i++;
      if (i < args.length && args[i] !== undefined) {
        gitWorkTree = resolvePath(args[i]!, state.cwd, homeDir);
      }
      i++;
      continue;
    }
    if (arg.startsWith('--work-tree=')) {
      gitWorkTree = resolvePath(arg.slice('--work-tree='.length), state.cwd, homeDir);
      i++;
      continue;
    }
    if (arg === '-c' || arg === '--git-dir') {
      i += 2;
      continue;
    }
    if (!arg.startsWith('-')) break;
    i++;
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
      restArgs.every((a) => a !== undefined && a.startsWith('-') && a !== '-d' && a !== '--delete');
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

  const effectiveGitDir = gitWorkTree ?? gitCwd ?? state.cwd;
  if (effectiveGitDir !== undefined && !isWithinDirectory(effectiveGitDir, worktree)) {
    escapes.push(effectiveGitDir);
    return;
  }

  let pastSeparator = false;
  for (const arg of restArgs) {
    if (arg === undefined) continue;
    if (arg === '--') {
      pastSeparator = true;
      continue;
    }
    if (pastSeparator || arg.includes('/') || arg === '.') {
      checkEscape(arg, effectiveGitDir ?? state.cwd, worktree, homeDir, escapes);
    }
  }
}

function handleDd(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  for (const arg of args) {
    if (arg === undefined) continue;
    if (arg.startsWith('of=')) {
      const target = arg.slice('of='.length);
      checkEscape(target, state.cwd, worktree, homeDir, escapes);
    }
  }
}

function handleRsync(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) {
      if (arg === '-e' || arg === '--exclude' || arg === '--include') i++;
      continue;
    }
    operands.push(arg);
  }
  if (operands.length >= 2) {
    const dest = operands[operands.length - 1]!;
    checkEscape(dest, state.cwd, worktree, homeDir, escapes);
  }
}

function handlePerl(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  const isInPlace = args.some(
    (arg) => arg !== undefined && (arg === '-i' || arg.startsWith('-i') || /^-[A-Za-z]*i/.test(arg)),
  );
  if (!isInPlace) return;
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '-e' || arg === '-E')) {
      i++;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const hasScriptFlag = args.some((arg) => arg !== undefined && (arg === '-e' || arg === '-E'));
  const files = hasScriptFlag ? operands : operands.slice(1);
  for (const file of files) {
    checkEscape(file, state.cwd, worktree, homeDir, escapes);
  }
}

function handleCurl(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-o' || arg === '--output') {
      i++;
      if (i < args.length && args[i] !== undefined && args[i] !== '-') {
        checkEscape(args[i]!, state.cwd, worktree, homeDir, escapes);
      }
      continue;
    }
    if (arg.startsWith('--output=')) {
      const target = arg.slice('--output='.length);
      if (target !== '-') checkEscape(target, state.cwd, worktree, homeDir, escapes);
    }
  }
}

function handleWget(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-O' || arg === '--output-document') {
      i++;
      if (i < args.length && args[i] !== undefined && args[i] !== '-') {
        checkEscape(args[i]!, state.cwd, worktree, homeDir, escapes);
      }
      continue;
    }
    if (arg.startsWith('--output-document=')) {
      const target = arg.slice('--output-document='.length);
      if (target !== '-') checkEscape(target, state.cwd, worktree, homeDir, escapes);
    }
  }
}

function handlePatch(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  if (args.some((a) => a === '--dry-run' || a === '--check' || a === '-C')) return;
  let targetDir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '-d' || arg === '--directory') {
      i++;
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
      i++;
      if (i < args.length && args[i] !== undefined) {
        checkEscape(args[i]!, state.cwd, worktree, homeDir, escapes);
      }
      continue;
    }
    if (arg.startsWith('--output=')) {
      checkEscape(arg.slice('--output='.length), state.cwd, worktree, homeDir, escapes);
      continue;
    }
  }
  const effectiveDir = targetDir !== undefined ? resolvePath(targetDir, state.cwd, homeDir) : state.cwd;
  if (effectiveDir !== undefined && !isWithinDirectory(effectiveDir, worktree)) {
    escapes.push(effectiveDir);
  }
}

function handleChmodChown(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  const operands: string[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && (arg === '--reference' || arg.startsWith('--reference='))) {
      if (arg === '--reference') i++;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-')) continue;
    operands.push(arg);
  }
  const files = operands.slice(1);
  for (const file of files) {
    checkEscape(file, state.cwd, worktree, homeDir, escapes);
  }
}

function handleTar(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  const firstArg = args[0];
  const isLegacyCluster = firstArg !== undefined && !firstArg.startsWith('-') && /^[A-Za-z]+$/.test(firstArg);

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
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === undefined) continue;
      if (arg === '-C' || arg === '--directory') {
        i++;
        if (i < args.length && args[i] !== undefined) targetDir = args[i];
        continue;
      }
      if (arg.startsWith('--directory=')) {
        targetDir = arg.slice('--directory='.length);
        continue;
      }
    }
    const effectiveDir = targetDir !== undefined ? resolvePath(targetDir, state.cwd, homeDir) : state.cwd;
    if (effectiveDir !== undefined && !isWithinDirectory(effectiveDir, worktree)) {
      escapes.push(effectiveDir);
    }
    return;
  }

  if (isCreating) {
    let archiveFile: string | undefined;
    if (isLegacyCluster && firstArg.includes('f') && args.length > 1 && args[1] !== undefined) {
      archiveFile = args[1];
    } else {
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === undefined) continue;
        if (arg === '-f' || arg === '--file') {
          i++;
          if (i < args.length && args[i] !== undefined) archiveFile = args[i];
          continue;
        }
        if (arg.startsWith('-') && !arg.startsWith('--') && arg.endsWith('f')) {
          i++;
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
      checkEscape(archiveFile, state.cwd, worktree, homeDir, escapes);
    }
    if (args.includes('--remove-files')) {
      const operands: string[] = [];
      let optionsEnded = false;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === undefined) continue;
        if (!optionsEnded && arg === '--') {
          optionsEnded = true;
          continue;
        }
        if (!optionsEnded && (arg === '-f' || arg === '--file' || arg === '-C' || arg === '--directory')) {
          i++;
          continue;
        }
        if (!optionsEnded && arg.startsWith('-')) continue;
        operands.push(arg);
      }
      for (const op of operands) {
        checkEscape(op, state.cwd, worktree, homeDir, escapes);
      }
    }
  }
}

function handleFind(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
  ctx: { worktree: string; homeDir: string | undefined; parser: IBashParserService; depth?: number },
): void {
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
      checkEscape(p, state.cwd, worktree, homeDir, escapes);
    }
  }

  if (execIndex >= 0 && execIndex + 1 < args.length) {
    const execArgs: (string | undefined)[] = [];
    for (let i = execIndex + 1; i < args.length; i++) {
      const a = args[i];
      if (a === ';' || a === '+') break;
      execArgs.push(a);
    }
    const execCmd = execArgs[0];
    if (execCmd !== undefined) {
      const { name: normCmd, args: unwrapArgs } = unwrapInvocation(execCmd, execArgs.slice(1));
      if (isFindExecDestructive(normCmd, unwrapArgs)) {
        for (const p of paths) {
          checkEscape(p, state.cwd, worktree, homeDir, escapes);
        }
      }
      dispatchCommand(normCmd, unwrapArgs, state, escapes, { ...ctx, depth: (ctx.depth ?? 0) + 1 });
    }
  }
}

function handleXargs(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  escapes: string[],
  ctx: { worktree: string; homeDir: string | undefined; parser: IBashParserService; depth?: number },
): void {
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg === '--') {
      i++;
      break;
    }
    if (arg === '-I' || arg === '-i') {
      i += 2;
      continue;
    }
    if (arg.startsWith('-I') || arg.startsWith('-i')) {
      i++;
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
    i++;
  }
  const subCmd = i < args.length ? args[i] : undefined;
  if (subCmd === undefined) return;
  dispatchCommand(normalizeCommandName(subCmd), args.slice(i + 1), state, escapes, { ...ctx, depth: (ctx.depth ?? 0) + 1 });
}

function handleNodePythonEval(
  name: string,
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
): void {
  let code: string | undefined;
  for (let i = 0; i < args.length; i++) {
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
      checkEscape(target, state.cwd, worktree, homeDir, escapes);
    }
  }

  const openWithModePattern =
    /(?:open|openSync)\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*[wax\+][^'"]*)['"]/g;
  while ((match = openWithModePattern.exec(code)) !== null) {
    const target = match[1];
    if (target !== undefined && target.length > 0) {
      checkEscape(target, state.cwd, worktree, homeDir, escapes);
    }
  }
}

function handleNestedShell(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
  parser: IBashParserService,
): void {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg !== undefined && arg !== '--' && /^-[A-Za-z]*c/.test(arg)) {
      if (i + 1 < args.length && args[i + 1] !== undefined) {
        const sub = evaluateWorkerBashCommand(
          args[i + 1]!,
          { worktree, initialCwd: state.cwd ?? worktree, homeDir },
          parser,
        );
        if (!sub.allowed) escapes.push(...sub.escapes);
      }
      break;
    }
  }
}

function handleEval(
  args: (string | undefined)[],
  state: { cwd: string | undefined },
  worktree: string,
  homeDir: string | undefined,
  escapes: string[],
  parser: IBashParserService,
): void {
  if (args.length === 0 || args.some((a) => a === undefined)) return;
  const script = args.join(' ');
  const sub = evaluateWorkerBashCommand(
    script,
    { worktree, initialCwd: state.cwd ?? worktree, homeDir },
    parser,
  );
  if (!sub.allowed) escapes.push(...sub.escapes);
}

function dispatchCommand(
  rawName: string,
  rawArgs: (string | undefined)[],
  state: { cwd: string | undefined },
  escapes: string[],
  ctx: { worktree: string; homeDir: string | undefined; parser: IBashParserService; depth?: number },
): void {
  if ((ctx.depth ?? 0) > 4) return;
  const { name, args } = unwrapInvocation(rawName, rawArgs);
  if (name === 'cd' || name === 'pushd') {
    handleCd(args, state, ctx.homeDir);
    return;
  }
  if (name === 'rm' || name === 'unlink' || name === 'rmdir') {
    handleSimpleWriteFiles(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'mkdir') {
    handleSimpleWriteFiles(args, state, ctx.worktree, ctx.homeDir, escapes, new Set(['-m', '--mode']));
    return;
  }
  if (name === 'touch') {
    handleSimpleWriteFiles(args, state, ctx.worktree, ctx.homeDir, escapes, new Set(['-d', '-t', '-r']));
    return;
  }
  if (name === 'truncate') {
    handleSimpleWriteFiles(args, state, ctx.worktree, ctx.homeDir, escapes, new Set(['-s', '-r']));
    return;
  }
  if (name === 'tee') {
    handleTee(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'cp' || name === 'install') {
    handleCp(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'mv') {
    handleMv(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'ln') {
    handleLn(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'sed') {
    handleSed(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'git') {
    handleGit(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'dd') {
    handleDd(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'rsync') {
    handleRsync(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'perl') {
    handlePerl(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'curl') {
    handleCurl(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'wget') {
    handleWget(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'patch') {
    handlePatch(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'chmod' || name === 'chown') {
    handleChmodChown(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'tar') {
    handleTar(args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (name === 'find') {
    handleFind(args, state, ctx.worktree, ctx.homeDir, escapes, ctx);
    return;
  }
  if (name === 'xargs') {
    handleXargs(args, state, escapes, ctx);
    return;
  }
  if (name === 'node' || name === 'python' || name === 'python3') {
    handleNodePythonEval(name, args, state, ctx.worktree, ctx.homeDir, escapes);
    return;
  }
  if (NESTED_SHELLS.has(name)) {
    handleNestedShell(args, state, ctx.worktree, ctx.homeDir, escapes, ctx.parser);
    return;
  }
  if (name === 'eval') {
    handleEval(args, state, ctx.worktree, ctx.homeDir, escapes, ctx.parser);
    return;
  }
}

function walkNode(
  node: BashSyntaxNode,
  state: { cwd: string | undefined },
  escapes: string[],
  ctx: { worktree: string; homeDir: string | undefined; parser: IBashParserService; depth?: number },
): void {
  if (node.type === 'file_redirect') {
    checkRedirect(node, state.cwd, ctx.worktree, ctx.homeDir, escapes);
    for (const child of node.children) {
      if (child.isNamed) walkNode(child, state, escapes, ctx);
    }
    return;
  }

  if (node.type === 'command_substitution' || node.type === 'process_substitution') {
    const subState = { cwd: state.cwd };
    for (const child of node.children) {
      if (child.isNamed) walkNode(child, subState, escapes, ctx);
    }
    return;
  }

  if (node.type === 'program' || node.type === 'compound_statement') {
    for (const child of node.children) {
      walkNode(child, state, escapes, ctx);
    }
    return;
  }

  if (node.type === 'list') {
    for (const child of node.children) {
      if (child.isNamed) {
        walkNode(child, state, escapes, ctx);
      }
    }
    return;
  }

  if (node.type === 'pipeline') {
    const savedCwd = state.cwd;
    for (const child of node.children) {
      if (child.isNamed) {
        const subState = { cwd: savedCwd };
        walkNode(child, subState, escapes, ctx);
      }
    }
    state.cwd = savedCwd;
    return;
  }

  if (node.type === 'subshell') {
    const savedCwd = state.cwd;
    const subState = { cwd: savedCwd };
    for (const child of node.children) {
      if (child.isNamed) {
        walkNode(child, subState, escapes, ctx);
      }
    }
    state.cwd = savedCwd;
    return;
  }

  if (node.type === 'redirected_statement') {
    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        checkRedirect(child, state.cwd, ctx.worktree, ctx.homeDir, escapes);
        for (const c of child.children) {
          if (c.isNamed) walkNode(c, state, escapes, ctx);
        }
      } else if (child.isNamed) {
        walkNode(child, state, escapes, ctx);
      }
    }
    return;
  }

  if (node.type === 'heredoc_redirect' || node.type === 'herestring_redirect') {
    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        checkRedirect(child, state.cwd, ctx.worktree, ctx.homeDir, escapes);
        for (const c of child.children) {
          if (c.isNamed) walkNode(c, state, escapes, ctx);
        }
      } else if (child.isNamed) {
        walkNode(child, state, escapes, ctx);
      }
    }
    return;
  }

  if (node.type === 'negated_command') {
    for (const child of node.children) {
      if (child.isNamed) {
        walkNode(child, state, escapes, ctx);
      }
    }
    return;
  }

  if (node.type === 'if_statement' || node.type === 'while_statement' || node.type === 'for_statement') {
    const savedCwd = state.cwd;
    let anyChanged = false;
    for (const child of node.children) {
      if (child.isNamed) {
        const branchState = { cwd: savedCwd };
        walkNode(child, branchState, escapes, ctx);
        if (branchState.cwd !== savedCwd) anyChanged = true;
      }
    }
    if (anyChanged) state.cwd = undefined;
    return;
  }

  if (node.type === 'command') {
    for (const child of node.children) {
      if (child.type === 'file_redirect') {
        checkRedirect(child, state.cwd, ctx.worktree, ctx.homeDir, escapes);
        for (const c of child.children) {
          if (c.isNamed) walkNode(c, state, escapes, ctx);
        }
      }
      if (child.type === 'command_substitution' || child.type === 'process_substitution') {
        const subState = { cwd: state.cwd };
        for (const subChild of child.children) {
          if (subChild.isNamed) walkNode(subChild, subState, escapes, ctx);
        }
      }
    }

    const nameIndex = node.children.findIndex((c) => c.type === 'command_name');
    if (nameIndex < 0) {
      for (const child of node.children) {
        if (child.type === 'file_redirect') {
          checkRedirect(child, state.cwd, ctx.worktree, ctx.homeDir, escapes);
        } else if (child.isNamed) {
          walkNode(child, state, escapes, ctx);
        }
      }
      return;
    }
    const nameNode = node.children[nameIndex]!;
    const nameWord = nameNode.children.find((c) => c.isNamed) ?? nameNode;
    const rawName = literalText(nameWord);
    if (rawName === undefined || rawName.length === 0) {
      for (const child of node.children) {
        if (child.type === 'file_redirect') {
          checkRedirect(child, state.cwd, ctx.worktree, ctx.homeDir, escapes);
        } else if (child.isNamed) {
          walkNode(child, state, escapes, ctx);
        }
      }
      return;
    }

    const rawArgs: (string | undefined)[] = [];
    for (const child of node.children.slice(nameIndex + 1)) {
      if (
        child.type === 'file_redirect' ||
        child.type === 'heredoc_redirect' ||
        child.type === 'herestring_redirect'
      ) {
        continue;
      }
      if (child.type === 'command_substitution' || child.type === 'process_substitution') {
        const subState = { cwd: state.cwd };
        for (const subChild of child.children) {
          if (subChild.isNamed) walkNode(subChild, subState, escapes, ctx);
        }
        rawArgs.push(undefined);
        continue;
      }
      rawArgs.push(literalText(child));
    }

    dispatchCommand(rawName, rawArgs, state, escapes, ctx);
    return;
  }

  for (const child of node.children) {
    if (child.type === 'file_redirect') {
      checkRedirect(child, state.cwd, ctx.worktree, ctx.homeDir, escapes);
    } else if (child.isNamed) {
      walkNode(child, state, escapes, ctx);
    }
  }
}

export function evaluateWorkerBashCommand(
  command: string,
  options: WorkerShellGuardOptions,
  bashParser?: IBashParserService,
): WorkerShellGuardResult {
  const parser = bashParser ?? new BashParserService();
  const parsed = parser.parse(command, BASH_PARSE_OPTIONS);
  if (!parsed.ok || parsed.hasError) {
    return { allowed: true, escapes: [] };
  }

  const worktree = normalize(options.worktree);
  const initialCwd = normalize(options.initialCwd);
  const homeDir =
    options.homeDir !== undefined && options.homeDir.length > 0
      ? normalize(options.homeDir)
      : undefined;

  const state = { cwd: initialCwd as string | undefined };
  const escapes: string[] = [];
  walkNode(parsed.root, state, escapes, { worktree, homeDir, parser });

  if (escapes.length === 0) {
    return { allowed: true, escapes: [] };
  }
  return { allowed: false, escapes: [...new Set(escapes)] };
}
