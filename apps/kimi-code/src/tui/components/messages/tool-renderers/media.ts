/**
 * ReadMediaFile renderer.
 *
 * The ReadMediaFile tool `output` is the JSON-serialized array of
 * content parts the tool returned — which includes the full base64 of
 * the image/video. Dumping that string into the transcript blasts a
 * multi-screen blob of base64. This renderer parses the envelope and
 * surfaces just the human-readable bits (kind, path, mime, size) via
 * a header chip + a tiny expanded body. It never emits the base64.
 *
 * On error, or when the output isn't the expected media envelope, we
 * fall back to the truncated renderer so the user still sees the raw
 * message.
 *
 * Persisted sessions add a wrinkle: agent-core's BlobStore offloads large
 * `data:` URIs to `<sessionDir>/agents/<agentId>/blobs/<sha256>` and rewrites
 * the URL to `blobref:<mime>;<sha256>` in wire.jsonl. Live events still carry
 * the inline data URL, but replayed records carry the blobref — so the inline
 * preview resolves blobrefs back from the session's blob store (see
 * `setMediaBlobSessionDir`).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { Image, Text, getCapabilities, type Component, type ImageTheme } from '@moonshot-ai/pi-tui';

import { currentTheme } from '#/tui/theme';

import type { ChipProvider } from './chip';
import { renderTruncated } from './truncated';
import type { ResultRenderer } from './types';

export interface ReadMediaSummary {
  kind: 'image' | 'video';
  path?: string;
  mimeType?: string;
  bytes?: number;
  url?: string;
  base64?: string;
  blobHash?: string;
}

const PATH_TAG_RE = /^<(image|video)\s+path="([^"]+)">$/;
const DATA_URL_RE = /^data:([^;]+);base64,(.*)$/s;
const BLOBREF_URL_RE = /^blobref:([^;]+);([0-9a-f]+)$/;

function bytesFromBase64(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

export function parseReadMediaOutput(output: string): ReadMediaSummary | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  let kind: 'image' | 'video' | undefined;
  let path: string | undefined;
  let mimeType: string | undefined;
  let bytes: number | undefined;
  let url: string | undefined;
  let base64: string | undefined;
  let blobHash: string | undefined;
  let foundMedia = false;

  for (const raw of parsed) {
    if (typeof raw !== 'object' || raw === null) continue;
    const part = raw as Record<string, unknown>;
    const type = part['type'];

    if (type === 'text' && typeof part['text'] === 'string') {
      const tag = PATH_TAG_RE.exec(part['text']);
      if (tag) {
        kind = tag[1] as 'image' | 'video';
        path = tag[2];
      }
      continue;
    }

    if (type === 'image_url' || type === 'video_url') {
      foundMedia = true;
      kind = type === 'image_url' ? 'image' : 'video';
      const holder = part[type === 'image_url' ? 'imageUrl' : 'videoUrl'];
      if (typeof holder === 'object' && holder !== null) {
        const h = holder as Record<string, unknown>;
        const u = h['url'];
        if (typeof u === 'string') {
          const data = DATA_URL_RE.exec(u);
          if (data && data[1] !== undefined && data[2] !== undefined) {
            mimeType = data[1];
            bytes = bytesFromBase64(data[2]);
            base64 = data[2];
            continue;
          }
          const blobref = BLOBREF_URL_RE.exec(u);
          if (blobref && blobref[1] !== undefined && blobref[2] !== undefined) {
            mimeType = blobref[1];
            blobHash = blobref[2];
          } else {
            url = u;
          }
        }
      }
    }
  }

  if (!foundMedia || kind === undefined) return null;

  const summary: ReadMediaSummary = { kind };
  if (path !== undefined) summary.path = path;
  if (mimeType !== undefined) summary.mimeType = mimeType;
  if (bytes !== undefined) summary.bytes = bytes;
  if (url !== undefined) summary.url = url;
  if (base64 !== undefined) summary.base64 = base64;
  if (blobHash !== undefined) summary.blobHash = blobHash;
  return summary;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function metaSegments(summary: ReadMediaSummary): string[] {
  const segs: string[] = [];
  if (summary.mimeType !== undefined) segs.push(summary.mimeType);
  if (summary.bytes !== undefined) segs.push(formatBytes(summary.bytes));
  return segs;
}

export const readMediaChip: ChipProvider = (_toolCall, result) => {
  if (result.is_error) return '';
  const summary = parseReadMediaOutput(result.output);
  if (summary === null) return '';
  const meta = metaSegments(summary);
  if (meta.length === 0) {
    return summary.url !== undefined ? `${summary.kind} · uploaded` : summary.kind;
  }
  return `${summary.kind} (${meta.join(', ')})`;
};

const MAX_IMAGE_ROWS = 12;
const MAX_IMAGE_WIDTH = 40;

// Replayed records carry `blobref:` URLs instead of inline base64 (see the
// header comment). The blob files live under the session directory, which the
// TUI knows only after a session is bound, so KimiTUI injects it here. The
// cache maps blob hash -> base64 (or undefined for a known miss); it resets
// when the session changes.
let mediaBlobSessionDir: string | undefined;
const blobBase64Cache = new Map<string, string | undefined>();
const MAX_BLOB_CACHE_ENTRIES = 64;

export function setMediaBlobSessionDir(dir: string | undefined): void {
  if (mediaBlobSessionDir === dir) return;
  mediaBlobSessionDir = dir;
  blobBase64Cache.clear();
}

function resolveBlobBase64(hash: string): string | undefined {
  if (mediaBlobSessionDir === undefined) return undefined;
  const cached = blobBase64Cache.get(hash);
  if (cached !== undefined || blobBase64Cache.has(hash)) return cached;

  let base64: string | undefined;
  const agentsDir = join(mediaBlobSessionDir, 'agents');
  try {
    for (const agentDir of readdirSync(agentsDir)) {
      const blobPath = join(agentsDir, agentDir, 'blobs', hash);
      if (existsSync(blobPath)) {
        base64 = readFileSync(blobPath).toString('base64');
        break;
      }
    }
  } catch {
    base64 = undefined;
  }

  if (blobBase64Cache.size >= MAX_BLOB_CACHE_ENTRIES) {
    const oldest = blobBase64Cache.keys().next().value;
    if (oldest !== undefined) blobBase64Cache.delete(oldest);
  }
  blobBase64Cache.set(hash, base64);
  return base64;
}

function renderInlineImage(base64: string, mimeType: string, filename?: string): Component {
  const theme: ImageTheme = {
    fallbackColor: (s: string) => currentTheme.fg('textDim', s),
  };
  return new Image(base64, mimeType, theme, {
    maxHeightCells: MAX_IMAGE_ROWS,
    maxWidthCells: MAX_IMAGE_WIDTH,
    filename,
  });
}

export const readMediaSummary: ResultRenderer = (toolCall, result, ctx) => {
  if (result.is_error) return renderTruncated(toolCall, result, ctx);
  const summary = parseReadMediaOutput(result.output);
  if (summary === null) return renderTruncated(toolCall, result, ctx);

  const dim = (text: string): string => currentTheme.dim(text);
  const caps = getCapabilities();
  const supportsInline = caps.images === 'kitty' || caps.images === 'iterm2';
  const inlineBase64 =
    summary.base64 ??
    (summary.blobHash !== undefined ? resolveBlobBase64(summary.blobHash) : undefined);
  // The image renders in the collapsed body too: capped at MAX_IMAGE_ROWS it
  // IS the compact preview, and gating it behind ctrl+o would make the
  // feature invisible in the default view.
  if (supportsInline && summary.kind === 'image' && inlineBase64 !== undefined) {
    const out: Component[] = [];
    if (ctx.expanded && summary.path !== undefined) {
      out.push(new Text(`  ${dim(summary.path)}`, 0, 0));
    }
    out.push(renderInlineImage(inlineBase64, summary.mimeType ?? 'image/png', summary.path));
    return out;
  }

  if (!ctx.expanded) return [];
  const out: Component[] = [];
  if (summary.path !== undefined) {
    out.push(new Text(`  ${dim(summary.path)}`, 0, 0));
  }
  const meta = metaSegments(summary);
  const tail: string[] = [summary.kind];
  if (meta.length > 0) tail.push(meta.join(', '));
  if (summary.url !== undefined) tail.push(summary.url);
  out.push(new Text(`  ${dim(tail.join(' · '))}`, 0, 0));
  return out;
};
