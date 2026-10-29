import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, NightDigest, ReadNight } from './types.js';

type Instant = { seconds: number; fraction: string };
type LogRecord = {
  at: string;
  job: string;
  status: DigestRow['lastStatus'];
  owner: DigestRow['owner'];
  error?: string;
  instant: Instant;
};

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function parseInstant(at: string): Instant | null {
  const match = /^(\d{4}-\d{2}-\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(at);
  if (!match || !isCalendarDate(match[1])) return null;
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const zone = match[6].toUpperCase();
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const seconds = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${zone}`) / 1000;
  if (!Number.isFinite(seconds)) return null;
  // Keep subsecond precision beyond JavaScript's milliseconds. With trailing
  // zeros removed, fractional digits can be compared lexically (including '').
  return { seconds, fraction: (match[5] ?? '').replace(/0+$/, '') };
}

function parseRecord(line: string): LogRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.at !== 'string' ||
    typeof record.job !== 'string' ||
    (record.owner !== null && typeof record.owner !== 'string') ||
    (record.status !== 'ok' && record.status !== 'retry' && record.status !== 'fail') ||
    (record.error !== undefined && typeof record.error !== 'string')
  ) return null;
  const instant = parseInstant(record.at);
  if (!instant) return null;
  return {
    at: record.at,
    job: record.job,
    owner: record.owner,
    status: record.status,
    error: record.error,
    instant,
  };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!isCalendarDate(night)) return null;
  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const digest: NightDigest = { night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const records: LogRecord[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!record) {
      digest.badLines += 1;
      continue;
    }
    records.push(record);
    digest.counts[record.status] += 1;
  }

  // Stable sorting makes later file lines win when instants are equal.
  records.sort((a, b) => a.instant.seconds - b.instant.seconds || compareText(a.instant.fraction, b.instant.fraction));
  const rows = new Map<string, DigestRow>();
  for (const record of records) {
    const row = rows.get(record.job) ?? {
      job: record.job,
      owner: record.owner,
      runs: 0,
      retries: 0,
      lastStatus: record.status,
      lastError: null,
      firstAt: record.at,
      lastAt: record.at,
    };
    row.runs += 1;
    if (record.status === 'retry') row.retries += 1;
    row.owner = record.owner;
    row.lastStatus = record.status;
    if (record.error !== undefined) row.lastError = record.error;
    row.lastAt = record.at;
    rows.set(record.job, row);
  }
  digest.rows = [...rows.values()].sort((a, b) => compareText(a.job, b.job));
  return digest;
};
