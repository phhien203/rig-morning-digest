import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';
import type { NightDigest, ReadNight } from '../src/digest/types.js';

const night = '2026-10-28';
const fixtureDir = fileURLToPath(new URL('../runs/', import.meta.url));
const record = (overrides: Record<string, unknown> = {}) => ({
  at: '2026-10-28T23:00:00+01:00',
  job: 'job',
  status: 'ok',
  owner: 'rook',
  ...overrides,
});

// This assignment checks the public synchronous signature against the contract.
const read: ReadNight = readNight;

let runsDir: string;
beforeEach(() => {
  // Keep even temporary fixtures inside this dedicated worktree, never in runs/.
  runsDir = mkdtempSync(join(process.cwd(), '.digest-reader-test-'));
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function writeLines(lines: unknown[], date = night): void {
  writeFileSync(join(runsDir, `${date}.jsonl`), lines.map(line => JSON.stringify(line)).join('\n'));
}

function getDigest(date = night): NightDigest {
  const digest = read(runsDir, date);
  expect(digest).not.toBeNull();
  return digest!;
}

describe('readNight', () => {
  it('aggregates the real fixture into five sorted jobs, leaving its bytes unchanged', () => {
    const fixturePath = join(fixtureDir, `${night}.jsonl`);
    const before = readFileSync(fixturePath);
    expect(read(fixtureDir, night)).toEqual({
      night,
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        {
          job: 'digest/render', owner: null, runs: 1, retries: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
        },
        {
          job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3,
          lastStatus: 'ok', lastError: 'upstream 503',
          firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
        },
        {
          job: 'lane/sync', owner: 'rook', runs: 8, retries: 1,
          lastStatus: 'ok', lastError: 'lock held',
          firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
        },
        {
          job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0,
          lastStatus: 'fail', lastError: 'quota exceeded',
          firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
        },
        {
          job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0,
          lastStatus: 'ok', lastError: null,
          firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
        },
      ],
    });
    expect(readFileSync(fixturePath)).toEqual(before);
  });

  it.each(['', '\n \t\r\n\n'])('returns an empty digest for an existing blank file (%j)', contents => {
    writeFileSync(join(runsDir, `${night}.jsonl`), contents);
    expect(getDigest()).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('skips malformed and schema-invalid lines while keeping valid surrounding records', () => {
    const invalid: unknown[] = [
      null, [], true, 42, 'text', {},
      { at: record().at, job: 'job', status: 'ok' },
      { job: 'job', status: 'ok', owner: null },
      { at: record().at, status: 'ok', owner: null },
      { at: record().at, job: 'job', owner: null },
      record({ at: null }), record({ at: 42 }), record({ job: null }), record({ job: 7 }),
      record({ owner: 0 }), record({ owner: {} }), record({ status: 'success' }),
      record({ status: null }), record({ status: ['ok'] }),
      record({ error: null }), record({ error: 500 }), record({ error: {} }),
    ];
    const lines = [JSON.stringify(record()), '{broken', ...invalid.map(value => JSON.stringify(value)),
      ' \t', JSON.stringify(record({ job: 'other', owner: null }))];
    writeFileSync(join(runsDir, `${night}.jsonl`), lines.join('\r\n'));
    const digest = getDigest();
    expect(digest.badLines).toBe(invalid.length + 1);
    expect(digest.counts).toEqual({ ok: 2, retry: 0, fail: 0 });
    expect(digest.rows.map(row => row.job)).toEqual(['job', 'other']);
  });

  it.each([
    '', 'yesterday', '2026-10-28', '2026-10-28T12:00:00', '2026-10-28 12:00:00Z',
    '2026-02-29T12:00:00Z', '1900-02-29T12:00:00Z', '2026-04-31T12:00:00Z',
    '2026-00-28T12:00:00Z', '2026-13-28T12:00:00Z', '2026-10-00T12:00:00Z',
    '2026-10-28T24:00:00Z', '2026-10-28T12:60:00Z', '2026-10-28T12:00:60Z',
    '2026-10-28T12:00:00+24:00', '2026-10-28T12:00:00+01:60',
    '2026-10-28T12:00:00+0100', '2026-10-28T12:00:00.Z', '2026-10-28T12:00:00Z trailing',
  ])('counts invalid timestamp %j as a bad line', at => {
    writeLines([record({ at })]);
    expect(getDigest()).toEqual({ night, rows: [], badLines: 1, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it.each([
    '2000-02-29T12:00:00Z', '2024-02-29t12:00:00z', '2026-10-28T12:00:00-05:30',
    '2026-10-28T12:00:00.123456789+05:45', '2026-10-28T12:00:00.000Z',
  ])('retains a valid timestamp verbatim: %s', at => {
    writeLines([record({ at })]);
    expect(getDigest().rows[0]).toMatchObject({ firstAt: at, lastAt: at });
    expect(getDigest().badLines).toBe(0);
  });

  it('uses chronological rather than file or lexical order for times, owner, status and error', () => {
    const firstAt = '2026-10-29T01:30:00+02:00';
    const lastAt = '2026-10-28T23:50:00Z';
    writeLines([
      record({ at: lastAt, status: 'ok', owner: null }),
      record({ at: '2026-10-28T23:45:00Z', status: 'fail', error: 'newest error' }),
      record({ at: firstAt, status: 'retry', error: 'oldest error' }),
      record({ at: '2026-10-28T19:40:00-04:00', status: 'retry', error: 'middle error' }),
    ]);
    expect(getDigest()).toEqual({
      night, badLines: 0, counts: { ok: 1, retry: 2, fail: 1 },
      rows: [{ job: 'job', owner: null, runs: 4, retries: 2, lastStatus: 'ok', lastError: 'newest error', firstAt, lastAt }],
    });
  });

  it('breaks equal-instant ties by file order, including errors and original time strings', () => {
    const firstAt = '2026-10-28T23:00:00.100+01:00';
    const lastAt = '2026-10-28T17:00:00.1000-05:00';
    writeLines([
      record({ at: firstAt, status: 'fail', error: 'old' }),
      record({ at: '2026-10-28T22:00:00.1Z', status: 'retry', error: 'new' }),
      record({ at: lastAt, owner: null }),
    ]);
    expect(getDigest().rows[0]).toEqual({
      job: 'job', owner: null, runs: 3, retries: 1, lastStatus: 'ok', lastError: 'new', firstAt, lastAt,
    });
  });

  it('compares fractional seconds without truncating submillisecond precision', () => {
    const firstAt = '2026-10-28T22:00:00.00001Z';
    const lastAt = '2026-10-28T22:00:00.0001Z';
    writeLines([
      record({ at: lastAt, status: 'fail', owner: 'latest', error: 'last' }),
      record({ at: firstAt, status: 'retry', error: 'first' }),
    ]);
    expect(getDigest().rows[0]).toMatchObject({ firstAt, lastAt, owner: 'latest', lastStatus: 'fail', lastError: 'last' });
  });

  it('retains empty string fields and errors, allows extra fields, and safely sorts arbitrary job names', () => {
    writeLines([
      record({ job: 'z', owner: null }),
      record({ job: '__proto__', error: 'previous' }),
      record({ job: 'A', owner: '', extra: { ignored: true } }),
      record({ job: '__proto__', error: '' }),
      record({ job: '', error: '' }),
      record({ job: 'a' }),
    ]);
    const digest = getDigest();
    expect(digest.rows.map(row => row.job)).toEqual(['', 'A', '__proto__', 'a', 'z']);
    expect(digest.rows[1].owner).toBe('');
    expect(digest.rows[2]).toMatchObject({ runs: 2, lastError: '' });
    expect(digest.badLines).toBe(0);
  });

  it('returns a digest rather than null when every nonblank line is invalid', () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), 'broken\nnull\n');
    expect(getDigest()).toEqual({ night, rows: [], badLines: 2, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('returns null for a missing file or missing runs directory', () => {
    expect(read(runsDir, night)).toBeNull();
    expect(read(join(runsDir, 'missing'), night)).toBeNull();
  });

  it.each([
    '', '../2026-10-28', '/2026-10-28', '2026-10-28.jsonl', '2026-1-01',
    '2026-02-29', '1900-02-29', '2026-04-31', '2026-00-10', '2026-13-10',
    '2026-01-00', '2026-01-32', '2026-10-28\n', '2026-10-28\u0000',
  ])('rejects invalid night %j before accessing the filesystem', invalidNight => {
    const notDirectory = join(runsDir, 'file');
    writeFileSync(notDirectory, 'not a directory');
    expect(read(notDirectory, invalidNight)).toBeNull();
  });

  it.each(['2024-02-29', '2000-02-29', '2026-04-30'])('accepts a real calendar date: %s', date => {
    writeLines([], date);
    expect(getDigest(date).night).toBe(date);
  });

  it('propagates unexpected I/O errors instead of reporting a missing or malformed night', () => {
    mkdirSync(join(runsDir, `${night}.jsonl`));
    expect(() => read(runsDir, night)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
    const notDirectory = join(runsDir, 'file');
    writeFileSync(notDirectory, 'not a directory');
    expect(() => read(notDirectory, night)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });
});
