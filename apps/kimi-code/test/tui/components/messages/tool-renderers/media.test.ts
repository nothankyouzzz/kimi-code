import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  Image,
  type Component,
  resetCapabilitiesCache,
  setCapabilities,
} from '@moonshot-ai/pi-tui';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  parseReadMediaOutput,
  readMediaChip,
  readMediaSummary,
  setMediaBlobSessionDir,
} from '#/tui/components/messages/tool-renderers/media';
import { darkColors } from '#/tui/theme/colors';
import type { ToolCallBlockData, ToolResultBlockData } from '#/tui/types';

function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '');
}

function joinRender(components: Component[], width = 100): string {
  return components.flatMap((c) => c.render(width)).join('\n');
}

function call(name: string, args: Record<string, unknown> = {}): ToolCallBlockData {
  return { id: 'tc', name, args };
}

function result(output: string, isError = false): ToolResultBlockData {
  return { tool_call_id: 'tc', output, is_error: isError };
}

beforeEach(() => {
  setCapabilities({ images: null, trueColor: false, hyperlinks: false });
  setMediaBlobSessionDir(undefined);
});

afterAll(() => {
  resetCapabilitiesCache();
});

const ctx = { expanded: false, colors: darkColors };
const expandedCtx = { expanded: true, colors: darkColors };

// 1x1 transparent png base64 (≈70 bytes once decoded)
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

function imageOutput(path: string, b64 = PNG_B64, mime = 'image/png'): string {
  return JSON.stringify([
    { type: 'text', text: `<image path="${path}">` },
    { type: 'image_url', imageUrl: { url: `data:${mime};base64,${b64}` } },
    { type: 'text', text: '</image>' },
  ]);
}

function videoOutput(path: string, mime = 'video/mp4'): string {
  return JSON.stringify([
    { type: 'text', text: `<video path="${path}">` },
    { type: 'video_url', videoUrl: { url: `data:${mime};base64,YWJj` } },
    { type: 'text', text: '</video>' },
  ]);
}

const BLOB_HASH = 'abc123';

function blobrefImageOutput(path: string, hash = BLOB_HASH, mime = 'image/png'): string {
  return JSON.stringify([
    { type: 'text', text: `<image path="${path}">` },
    { type: 'image_url', imageUrl: { url: `blobref:${mime};${hash}` } },
    { type: 'text', text: '</image>' },
  ]);
}

// Persisted sessions offload large data URIs to <sessionDir>/agents/<id>/blobs/<hash>.
function writeBlob(sessionDir: string, hash: string, payload: Buffer, agentId = 'main'): void {
  const blobsDir = join(sessionDir, 'agents', agentId, 'blobs');
  mkdirSync(blobsDir, { recursive: true });
  writeFileSync(join(blobsDir, hash), payload);
}

describe('parseReadMediaOutput', () => {
  it('extracts kind, path, mime type, and bytes from an image data URL', () => {
    const m = parseReadMediaOutput(imageOutput('/tmp/a.png'));
    expect(m).not.toBeNull();
    expect(m?.kind).toBe('image');
    expect(m?.path).toBe('/tmp/a.png');
    expect(m?.mimeType).toBe('image/png');
    expect(m?.bytes).toBeGreaterThan(0);
  });

  it('extracts video kind and mime', () => {
    const m = parseReadMediaOutput(videoOutput('/tmp/a.mp4'));
    expect(m?.kind).toBe('video');
    expect(m?.mimeType).toBe('video/mp4');
  });

  it('captures non-data video URL when uploader was used', () => {
    const out = JSON.stringify([
      { type: 'text', text: `<video path="/tmp/a.mp4">` },
      { type: 'video_url', videoUrl: { url: 'https://cdn.example/v/abc' } },
      { type: 'text', text: '</video>' },
    ]);
    const m = parseReadMediaOutput(out);
    expect(m?.kind).toBe('video');
    expect(m?.url).toBe('https://cdn.example/v/abc');
    expect(m?.bytes).toBeUndefined();
  });

  it('extracts mime type and blob hash from a blobref URL', () => {
    const m = parseReadMediaOutput(blobrefImageOutput('/tmp/a.png'));
    expect(m?.kind).toBe('image');
    expect(m?.mimeType).toBe('image/png');
    expect(m?.blobHash).toBe(BLOB_HASH);
    expect(m?.url).toBeUndefined();
    expect(m?.base64).toBeUndefined();
  });

  it('keeps ms:// and other external URLs in url, not blobHash', () => {
    const out = JSON.stringify([
      { type: 'text', text: `<video path="/tmp/a.mp4">` },
      { type: 'video_url', videoUrl: { url: 'ms://file-123' } },
      { type: 'text', text: '</video>' },
    ]);
    const m = parseReadMediaOutput(out);
    expect(m?.url).toBe('ms://file-123');
    expect(m?.blobHash).toBeUndefined();
  });

  it('returns null for non-JSON output', () => {
    expect(parseReadMediaOutput('not json')).toBeNull();
  });

  it('returns null when no media part is present', () => {
    expect(parseReadMediaOutput(JSON.stringify([{ type: 'text', text: 'hi' }]))).toBeNull();
  });
});

describe('readMediaChip', () => {
  it('returns a compact summary for an image', () => {
    const text = strip(readMediaChip(call('ReadMediaFile'), result(imageOutput('/tmp/a.png'))));
    expect(text).toMatch(/image/);
    expect(text).toContain('image/png');
    expect(text).toMatch(/B|KB|MB/);
  });

  it('returns empty string on error so the truncated body shows the error', () => {
    expect(readMediaChip(call('ReadMediaFile'), result('boom', true))).toBe('');
  });

  it('returns empty string when output is unparseable', () => {
    expect(readMediaChip(call('ReadMediaFile'), result('garbage'))).toBe('');
  });

  it('summarizes a blobref image by mime type instead of "uploaded"', () => {
    const text = strip(
      readMediaChip(call('ReadMediaFile'), result(blobrefImageOutput('/tmp/a.png'))),
    );
    expect(text).toContain('image');
    expect(text).toContain('image/png');
    expect(text).not.toContain('uploaded');
  });
});

describe('readMediaSummary renderer', () => {
  it('renders an empty body when collapsed (chip carries the info)', () => {
    const out = joinRender(
      readMediaSummary(call('ReadMediaFile'), result(imageOutput('/tmp/a.png')), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('renders path + meta line when expanded — never the base64 blob', () => {
    const out = strip(
      joinRender(
        readMediaSummary(call('ReadMediaFile'), result(imageOutput('/tmp/a.png')), expandedCtx),
      ),
    );
    expect(out).toContain('/tmp/a.png');
    expect(out).toContain('image/png');
    // Crucially: the base64 must never reach the screen.
    expect(out).not.toContain(PNG_B64);
    expect(out).not.toContain(PNG_DATA_URL);
  });

  it('falls back to truncated renderer for errors', () => {
    const out = strip(
      joinRender(
        readMediaSummary(
          call('ReadMediaFile', { path: '/tmp/x.png' }),
          result('File not found', true),
          ctx,
        ),
      ),
    );
    expect(out).toContain('File not found');
  });

  it('falls back to truncated renderer when the output is not the media envelope', () => {
    // Collapsed: the fallback renderer's outcome row is the first output line.
    const collapsed = strip(
      joinRender(
        readMediaSummary(call('ReadMediaFile'), result('"some plain string output"'), ctx),
      ),
    );
    expect(collapsed).toBe('  "some plain string output"');
    const out = strip(
      joinRender(
        readMediaSummary(call('ReadMediaFile'), result('"some plain string output"'), {
          ...ctx,
          expanded: true,
        }),
      ),
    );
    expect(out).toContain('some plain string output');
  });

  it('renders an inline image preview when expanded on terminals that support inline images', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(imageOutput('/tmp/a.png')),
      expandedCtx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(true);
  });

  it('renders the inline image in the collapsed body too (the capped image is the preview)', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(imageOutput('/tmp/a.png')),
      ctx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(true);
  });

  it('keeps the collapsed body empty without inline image support', () => {
    const out = joinRender(
      readMediaSummary(call('ReadMediaFile'), result(imageOutput('/tmp/a.png')), ctx),
    );
    expect(out.trim()).toBe('');
  });

  it('does not inline-render video results', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(videoOutput('/tmp/a.mp4')),
      expandedCtx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(false);
  });

  it('inline-renders a blobref image by reading the session blob store', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const sessionDir = mkdtempSync(join(tmpdir(), 'media-blob-'));
    writeBlob(sessionDir, BLOB_HASH, Buffer.from(PNG_B64, 'base64'));
    setMediaBlobSessionDir(sessionDir);

    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(blobrefImageOutput('/tmp/a.png')),
      expandedCtx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(true);
  });

  it('finds blobs written under a subagent directory', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const sessionDir = mkdtempSync(join(tmpdir(), 'media-blob-'));
    writeBlob(sessionDir, BLOB_HASH, Buffer.from(PNG_B64, 'base64'), 'agent-1');
    setMediaBlobSessionDir(sessionDir);

    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(blobrefImageOutput('/tmp/a.png')),
      expandedCtx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(true);
  });

  it('falls back to the text summary when the blob file is missing', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const sessionDir = mkdtempSync(join(tmpdir(), 'media-blob-'));
    setMediaBlobSessionDir(sessionDir);

    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(blobrefImageOutput('/tmp/a.png')),
      expandedCtx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(false);
    const out = strip(joinRender(components));
    expect(out).toContain('/tmp/a.png');
    expect(out).toContain('image/png');
  });

  it('does not resolve blobrefs without a bound session dir', () => {
    setCapabilities({ images: 'iterm2', trueColor: true, hyperlinks: false });
    const components = readMediaSummary(
      call('ReadMediaFile'),
      result(blobrefImageOutput('/tmp/a.png')),
      expandedCtx,
    );
    expect(components.some((c) => c instanceof Image)).toBe(false);
  });
});
