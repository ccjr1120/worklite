#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

const manifestUrl = new URL('../apps/web/package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
const previousVersion = manifest.version;
const [major, minor, patch] = previousVersion.split('.').map(Number);
manifest.version = `${major}.${minor}.${patch + 1}`;
writeFileSync(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`WorkLite deployment version: ${previousVersion} -> ${manifest.version}`);
