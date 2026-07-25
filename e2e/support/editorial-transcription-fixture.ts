import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page, Request } from '@playwright/test';

const fixturePath = path.resolve(
  process.cwd(),
  'e2e/fixtures/editorial/edit-max-v1-32000.json',
);

export interface ObservedEditorialRequest {
  fields: Record<string, string>;
  wav: Buffer;
  authorization: boolean;
}

export interface EditorialRouteFixture {
  readonly requests: ObservedEditorialRequest[];
  install(page: Page): Promise<void>;
}

/**
 * Intercepts the public browser-mode endpoint without adding a production test route. Multipart
 * bytes are parsed exactly so the scenario can assert the frozen fields and canonical WAV shape.
 */
export async function createEditorialRouteFixture(options: {
  endpoint?: string;
  responseMutator?: (response: Record<string, unknown>, requestIndex: number) => void;
  status?: number;
} = {}): Promise<EditorialRouteFixture> {
  const endpoint = options.endpoint ?? 'http://localhost:43123/v1/audio/transcriptions';
  const responseTemplate = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown>;
  const requests: ObservedEditorialRequest[] = [];
  return {
    requests,
    async install(page) {
      await page.route(`${new URL(endpoint).origin}/**`, async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') {
          await route.fulfill({
            status: 204,
            headers: corsHeaders(),
          });
          return;
        }
        if (request.url() !== endpoint || request.method() !== 'POST') {
          await route.abort('blockedbyclient');
          return;
        }
        const parsed = parseEditorialMultipartRequest(request);
        requests.push(parsed);
        const response = structuredClone(responseTemplate);
        options.responseMutator?.(response, requests.length - 1);
        await route.fulfill({
          status: options.status ?? 200,
          contentType: 'application/json',
          headers: corsHeaders(),
          body: JSON.stringify(response),
        });
      });
    },
  };
}

export function parseEditorialMultipartRequest(request: Request): ObservedEditorialRequest {
  const contentType = request.headers()['content-type'] ?? '';
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const boundary = boundaryMatch?.[1] ?? boundaryMatch?.[2];
  const body = request.postDataBuffer();
  if (!boundary || !body) throw new Error('The editorial request did not contain multipart bytes.');
  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  let wav: Buffer | null = null;
  let cursor = 0;
  while (cursor < body.length) {
    const boundaryIndex = body.indexOf(delimiter, cursor);
    if (boundaryIndex < 0) break;
    const headerStart = boundaryIndex + delimiter.length + 2;
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd < 0) break;
    const nextBoundary = body.indexOf(delimiter, headerEnd + 4);
    if (nextBoundary < 0) break;
    const headers = body.subarray(headerStart, headerEnd).toString('utf8');
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (name) {
      const value = body.subarray(headerEnd + 4, Math.max(headerEnd + 4, nextBoundary - 2));
      if (/filename=/.test(headers)) wav = Buffer.from(value);
      else fields[name] = value.toString('utf8');
    }
    cursor = nextBoundary;
  }
  if (!wav) throw new Error('The editorial request omitted its WAV file.');
  return {
    fields,
    wav,
    authorization: request.headers().authorization?.startsWith('Bearer ') === true,
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
  };
}
