import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
const firstAt = '2026-10-28T01:00:00+05:30';
const lastAt = '2026-10-28T02:00:00+05:30';

// Only inspect table cells and visible text: no view-specific data attributes or
// assumptions about wrappers, column positions (apart from job first), or CSS.
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number(entity.slice(1)));
    return named[entity] ?? _;
  }).replace(/\s+/g, ' ').trim();
}

function tableRows(html: string) {
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi)].map(([markup]) => ({
    markup,
    cells: [...markup.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => text(cell[1])),
  }));
}

function record(job: string, status: 'ok' | 'retry' | 'fail', at = firstAt, owner: string | null = 'rook', error?: string) {
  return JSON.stringify({ at, job, status, owner, ...(error === undefined ? {} : { error }) });
}

const expected: NightDigest = {
  night,
  rows: [
    { job: 'alpha', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok', lastError: 'try again', firstAt, lastAt },
    { job: 'beta', owner: null, runs: 2, retries: 0, lastStatus: 'fail', lastError: 'broken', firstAt, lastAt },
    { job: 'zeta', owner: 'rook', runs: 1, retries: 0, lastStatus: 'ok', lastError: null, firstAt, lastAt: firstAt },
  ],
  badLines: 0,
  counts: { ok: 3, retry: 3, fail: 1 },
};

// Deliberately neither job-sorted nor chronological. Counts are log-record
// counts, which differ from the final-state counts (2 ok, 0 retry, 1 fail).
const records = [
  record('zeta', 'ok'),
  record('beta', 'fail', lastAt, null, 'broken'),
  record('alpha', 'ok', lastAt),
  record('alpha', 'retry', '2026-10-28T01:30:00+05:30', 'rook', 'try again'),
  record('beta', 'ok', firstAt, 'former-owner'),
  record('alpha', 'retry'),
  record('alpha', 'retry', '2026-10-28T01:15:00+05:30'),
];

describe('digest routes', () => {
  let runsDir: string;
  beforeEach(async () => {
    runsDir = await mkdtemp(join(tmpdir(), 'rig-digest-routes-'));
  });
  afterEach(async () => {
    await rm(runsDir, { recursive: true, force: true });
  });

  function app() {
    return createApp({ adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir });
  }

  async function log(lines: string[], date = night) {
    await writeFile(join(runsDir, `${date}.jsonl`), lines.join('\n'));
  }

  it('serves identical sorted jobs and aggregate values as HTML and NightDigest JSON', async () => {
    await log(records);
    const instance = app();
    const page = await instance.request(`/digest/${night}`);
    const api = await instance.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(api.headers.get('content-type')).toMatch(/application\/json/);
    const digest = await api.json() as NightDigest;
    expect(digest).toEqual(expected);
    const html = await page.text();
    const rows = tableRows(html).filter((row) => digest.rows.some((job) => job.job === row.cells[0]));
    expect(rows.map((row) => row.cells[0])).toEqual(digest.rows.map((row) => row.job));
    for (const [index, job] of digest.rows.entries()) {
      const cells = rows[index].cells;
      for (const value of [job.owner ?? '—', String(job.runs), String(job.retries), job.lastStatus, job.lastError ?? '—', job.firstAt, job.lastAt]) {
        expect(cells, `${job.job}: ${value}`).toContain(value);
      }
    }
    expect(html).not.toMatch(/<script\b/i);
  });

  it('visibly marks both three retries with eventual success and a failed job', async () => {
    await log(records);
    const response = await app().request(`/digest/${night}`);
    expect(response.status).toBe(200);
    const rows = tableRows(await response.text());
    for (const job of ['alpha', 'beta']) {
      const row = rows.find((row) => row.cells[0] === job);
      expect(row, job).toBeDefined();
      // The shared layout already defines .warn; accept other explicit warning
      // classes or visible warning indicators as well.
      expect(row!.markup).toMatch(/class\s*=\s*["'][^"']*\b(?:warn|warning|danger|fail)\b|⚠|\bwarning\b/i);
    }
  });

  it.each(['/digest/', '/api/digest/'])('%s returns 404 for missing and invalid nights', async (prefix) => {
    await log(records);
    for (const date of ['2026-10-27', '2026-02-30', '2026-13-01', 'not-a-night', '2026-1-01', '..%2F2026-10-28']) {
      const response = await app().request(`${prefix}${date}`);
      expect(response.status, date).toBe(404);
    }
  });

  it('renders an existing empty night as nothing ran, not a missing night', async () => {
    await log([]);
    const instance = app();
    const page = await instance.request(`/digest/${night}`);
    const api = await instance.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(text(await page.text())).toMatch(/nothing ran/i);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('counts malformed and schema-invalid lines without losing valid jobs; blank lines are ignored', async () => {
    await log([...records, '{not json', JSON.stringify({ job: 'invalid', status: 'ok' }), '', '   ']);
    const instance = app();
    const page = await instance.request(`/digest/${night}`);
    const api = await instance.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    expect(await api.json()).toEqual({ ...expected, badLines: 2 });
    const html = await page.text();
    expect(text(html)).toMatch(/(?:2\s+(?:bad|invalid|malformed|skipped)\s+lines?|(?:bad|invalid|malformed|skipped)\s+lines?\s*:?\s*2)/i);
    expect(tableRows(html).filter((row) => expected.rows.some((job) => job.job === row.cells[0])).map((row) => row.cells[0])).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('escapes malicious job, owner and error fields in HTML while preserving JSON values', async () => {
    const job = '<script>alert("job")</script>';
    const owner = '<img src=x onerror="alert(1)">';
    const error = '<svg onload="alert(2)">& "broken"</svg>';
    await log([record(job, 'fail', firstAt, owner, error)]);
    const instance = app();
    const page = await instance.request(`/digest/${night}`);
    const api = await instance.request(`/api/digest/${night}`);
    expect(page.status).toBe(200);
    expect(api.status).toBe(200);
    const html = await page.text();
    expect(html).not.toMatch(/<(?:script|img|svg)\b/i);
    const row = tableRows(html).find((row) => row.cells[0] === job);
    expect(row).toBeDefined();
    expect(row!.cells).toEqual(expect.arrayContaining([job, owner, error]));
    const digest = await api.json() as NightDigest;
    expect(digest.rows).toEqual([{ job, owner, runs: 1, retries: 0, lastStatus: 'fail', lastError: error, firstAt, lastAt: firstAt }]);
  });

  it('links each on-disk night from the board and shows record counts, not final-job counts', async () => {
    await log(records);
    await log([], '2026-10-29');
    const instance = app();
    const board = await instance.request('/');
    expect(board.status).toBe(200);
    const html = await board.text();
    for (const date of [night, '2026-10-29']) {
      expect(html).toMatch(new RegExp(`href=["']/digest/${date}["']`));
      expect((await instance.request(`/digest/${date}`)).status).toBe(200);
      const entry = [...html.matchAll(/<(li|tr)\b[^>]*>([\s\S]*?)<\/\1>/gi)].find((match) => match[2].includes(`/digest/${date}`));
      expect(entry, `board entry for ${date}`).toBeDefined();
      const visible = text(entry![2]);
      const counts = date === night ? expected.counts : { ok: 0, retry: 0, fail: 0 };
      for (const [status, count] of Object.entries(counts)) {
        expect(visible).toMatch(new RegExp(`(?:\\b${status}\\s*[:=]?\\s*${count}\\b|\\b${count}\\s+${status}\\b)`, 'i'));
      }
    }
  });
});
