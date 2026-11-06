#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

// This implementation belongs to qcoder. It reuses the existing read-only index API.
const envelope = JSON.parse(Buffer.from(process.env.WORKLITE_TOOL_INPUT_BASE64 || '', 'base64').toString('utf8'));
const args = envelope.input;
if (!args || typeof args.query !== 'string' || !args.query.trim() || args.query.trim().length > 200) throw new Error('query must be nonempty text of at most 200 characters.');
if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) throw new Error('limit must be an integer from 1 to 50.');
if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh must be a boolean.');
const query = args.query.trim();
const url = new URL('/api/local-projects/search', process.env.WORKLITE_API_URL || 'http://127.0.0.1:23391');
url.searchParams.set('query', query);
if (args.limit !== undefined) url.searchParams.set('limit', String(args.limit));
if (args.refresh !== undefined) url.searchParams.set('refresh', String(args.refresh));
const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) throw new Error(`Local project index returned HTTP ${response.status}.`);
const result = await response.json();
if (!Array.isArray(result.results) || !Array.isArray(result.approximate)) throw new Error('Invalid local project index response.');
const check = async (absolutePath) => {
  if (typeof absolutePath !== 'string' || !isAbsolute(absolutePath)) throw new Error('Index candidate must contain an absolutePath.');
  try { return { absolutePath, directoryStatus: (await stat(absolutePath)).isDirectory() ? 'exists' : 'not_directory' }; }
  catch (error) { return { absolutePath, directoryStatus: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unknown', errorCode: error.code || 'UNKNOWN' }; }
};
const verify = async (item) => ({ ...item, ...await check(item.absolutePath) });
const [results, approximate, requestedDirectory] = await Promise.all([
  Promise.all(result.results.map(verify)), Promise.all(result.approximate.map(verify)),
  isAbsolute(query) ? check(query) : Promise.resolve(null),
]);
console.log(JSON.stringify({ ...result, results, approximate, requestedDirectory, lookupStatus: results.length ? 'matched' : 'not_indexed', note: [result.note, 'No index match does not prove nonexistence. Use only directoryStatus=exists. Approximate candidates are suggestions; report ambiguity and partial/stale/timedOut limitations.'].filter(Boolean).join(' ') }));
