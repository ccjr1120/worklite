import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localSkillId, parseSkillFrontmatter, scanLocalSkillRoot } from './local-skill-source';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'worklite-local-skills-'));
  roots.push(root);
  return root;
}

async function writeSkill(root: string, directory: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, directory, path.split('/').slice(0, -1).join('/')), { recursive: true });
    await writeFile(join(root, directory, path), content);
  }
}

const dinoSkill = `---
name: dino-account
version: 1.2.0
description: "Dino 账号（daily）：Web 邮箱登录"
metadata:
  bins: ["dino-cli"]
  cliHelp: "dino-cli account --help"
---

# dino-account

Use \`dino-cli account current\`.
`;

describe('parseSkillFrontmatter', () => {
  it('reads name, description, version and nested metadata such as bins', () => {
    expect(parseSkillFrontmatter(dinoSkill)).toEqual({
      name: 'dino-account',
      version: '1.2.0',
      description: 'Dino 账号（daily）：Web 邮箱登录',
      metadata: { bins: ['dino-cli'], cliHelp: 'dino-cli account --help' },
    });
  });

  it('supports nested metadata maps and block lists', () => {
    const parsed = parseSkillFrontmatter(`---
name: doc
metadata:
  requires:
    bins:
      - lark-cli
    skills: ["lark-shared", "lark-doc"]
---
Body
`);
    expect(parsed).toEqual({
      name: 'doc',
      metadata: { requires: { bins: ['lark-cli'], skills: ['lark-shared', 'lark-doc'] } },
    });
  });

  it('reads literal and folded block scalar descriptions', () => {
    const literal = parseSkillFrontmatter(`---
name: meegle
version: 1.0.0
description: |
  飞书项目（Meego/Meegle）操作工具。
  支持查询、创建和更新工作项。
metadata:
  bins:
    - lark-cli
---
Body
`);
    expect(literal).toEqual({
      name: 'meegle',
      version: '1.0.0',
      description: '飞书项目（Meego/Meegle）操作工具。\n支持查询、创建和更新工作项。',
      metadata: { bins: ['lark-cli'] },
    });

    const folded = parseSkillFrontmatter(`---
name: meegle-conventions
description: >-
  First line of the description
  continues on the next line.
---
Body
`);
    expect(folded).toEqual({ name: 'meegle-conventions', description: 'First line of the description continues on the next line.' });
  });

  it('returns an empty object when the file has no frontmatter', () => {
    expect(parseSkillFrontmatter('# Plain Skill\n')).toEqual({});
  });
});

describe('scanLocalSkillRoot', () => {
  it('scans first-level packages and reads SKILL.md, scripts and references', async () => {
    const root = await temporaryRoot();
    await writeSkill(root, 'dino-account', {
      'SKILL.md': dinoSkill,
      'references/commands.md': 'account login -e <email>\n',
      'scripts/login.sh': '#!/bin/sh\ndino-cli account login -e "$1"\n',
    });

    const result = await scanLocalSkillRoot(root);

    expect(result.available).toBe(true);
    expect(result.skipped).toEqual([]);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject({
      directory: 'dino-account',
      name: 'dino-account',
      description: 'Dino 账号（daily）：Web 邮箱登录',
      version: '1.2.0',
      metadata: { bins: ['dino-cli'], cliHelp: 'dino-cli account --help' },
      instructions: dinoSkill,
    });
    expect(result.packages[0]?.files.map((file) => file.path)).toEqual([
      'SKILL.md',
      'references/commands.md',
      'scripts/login.sh',
    ]);
  });

  it('accepts a valid skill when the package root has extra files', async () => {
    const root = await temporaryRoot();
    await writeSkill(root, 'with-extra-files', {
      'SKILL.md': dinoSkill,
      'LICENSE': 'MIT',
      'README.md': '# Additional package notes',
    });

    const result = await scanLocalSkillRoot(root);

    expect(result.skipped).toEqual([]);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]?.instructions).toBe(dinoSkill);
  });

  it('reports a directory without SKILL.md instead of ignoring it', async () => {
    const root = await temporaryRoot();
    await writeSkill(root, 'not-a-skill', { 'README.md': 'no skill here' });

    const result = await scanLocalSkillRoot(root);

    expect(result.packages).toEqual([]);
    expect(result.skipped).toEqual([{ directory: 'not-a-skill', reason: 'The Skill package has no root SKILL.md.' }]);
  });

  it('rejects unsupported top-level package paths with a clear reason', async () => {
    const root = await temporaryRoot();
    await writeSkill(root, 'with-assets', {
      'SKILL.md': dinoSkill,
      'assets/logo.txt': 'binary-ish',
    });

    const result = await scanLocalSkillRoot(root);

    expect(result.packages).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('Unsupported Skill package path "assets"');
  });

  it('refuses a symbolic-link package without following it', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeSkill(outside, 'escaping-skill', { 'SKILL.md': dinoSkill });
    await symlink(join(outside, 'escaping-skill'), join(root, 'escaping-skill'));

    const result = await scanLocalSkillRoot(root);

    expect(result.packages).toEqual([]);
    expect(result.skipped).toEqual([{ directory: 'escaping-skill', reason: 'Symbolic links are not supported as Skill packages.' }]);
  });

  it('refuses a symbolic-link file inside a package', async () => {
    const root = await temporaryRoot();
    const outside = await temporaryRoot();
    await writeFile(join(outside, 'secret.md'), 'secret');
    await writeSkill(root, 'linked-file', { 'SKILL.md': dinoSkill });
    await mkdir(join(root, 'linked-file', 'references'), { recursive: true });
    await symlink(join(outside, 'secret.md'), join(root, 'linked-file', 'references', 'secret.md'));

    const result = await scanLocalSkillRoot(root);

    expect(result.packages).toEqual([]);
    expect(result.skipped[0]?.reason).toContain('must not be a symbolic link');
  });

  it('degrades with an explicit reason when the root does not exist', async () => {
    const root = join(await temporaryRoot(), 'missing');

    const result = await scanLocalSkillRoot(root);

    expect(result.available).toBe(false);
    expect(result.packages).toEqual([]);
    expect(result.unavailableReason).toContain('does not exist');
  });
});

describe('localSkillId', () => {
  it('is stable for the same workspace and directory', () => {
    expect(localSkillId('workspace_personal', 'dino-account')).toBe(localSkillId('workspace_personal', 'dino-account'));
    expect(localSkillId('workspace_personal', 'dino-account')).not.toBe(localSkillId('workspace_personal', 'dino-open'));
  });
});
