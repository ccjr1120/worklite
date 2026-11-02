#!/usr/bin/env node
import { existsSync, lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(homedir(), '.local', 'bin');
const link = join(directory, 'worklite');
const target = join(dirname(fileURLToPath(import.meta.url)), 'worklite.mjs');
mkdirSync(directory, { recursive: true });
if (existsSync(link) || (() => { try { return lstatSync(link).isSymbolicLink(); } catch { return false; } })()) {
  if (!lstatSync(link).isSymbolicLink() || resolve(directory, readlinkSync(link)) !== target) {
    throw new Error(`${link} already exists and points elsewhere. Remove it manually before installing.`);
  }
} else symlinkSync(target, link);
console.log(`Installed worklite at ${link}`);
if (!(process.env.PATH ?? '').split(delimiter).includes(directory)) {
  console.log(`Add ${directory} to your PATH, for example: export PATH="$HOME/.local/bin:$PATH"`);
}
