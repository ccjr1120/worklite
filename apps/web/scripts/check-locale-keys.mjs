import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const localesRoot = path.join(root, 'src/i18n/locales');
// WorkLite ships one fixed Chinese resource set, so zh-CN is the reference the other
// locale directories, if any are ever added, are compared against.
const referenceLocale = 'zh-CN';

function flatten(value, prefix = '') {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, nested]) => flatten(nested, prefix ? `${prefix}.${key}` : key));
  }

  return [prefix];
}

function compareKeys(left, right) {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return {
    missing: left.filter((key) => !rightSet.has(key)),
    extra: right.filter((key) => !leftSet.has(key)),
  };
}

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'];

function pluralCategories(locale) {
  return new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
}

// A key like `count_one` exists only in locales whose plural rules use the `one`
// category. Chinese resolves every count to `other`, so requiring `_one` there
// would add a string i18next never selects.
function expectedKeysForLocale(referenceKeys, locale) {
  const categories = pluralCategories(locale);
  return referenceKeys.filter((key) => {
    const suffix = PLURAL_SUFFIXES.find((candidate) => key.endsWith(`_${candidate}`));
    return suffix === undefined || categories.has(suffix);
  });
}

const localeDirs = (await readdir(localesRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (!localeDirs.includes(referenceLocale)) {
  console.error(`Missing reference locale directory: ${referenceLocale}`);
  process.exit(1);
}

const namespaces = (await readdir(path.join(localesRoot, referenceLocale)))
  .filter((file) => file.endsWith('.json'))
  .map((file) => file.replace(/\.json$/, ''))
  .sort();

let failed = false;

for (const locale of localeDirs) {
  const files = (await readdir(path.join(localesRoot, locale))).filter((file) => file.endsWith('.json'));
  const localeNamespaces = files.map((file) => file.replace(/\.json$/, '')).sort();
  const namespaceDiff = compareKeys(namespaces, localeNamespaces);

  if (namespaceDiff.missing.length || namespaceDiff.extra.length) {
    failed = true;
    console.error(`Locale ${locale} namespace mismatch.`);
    if (namespaceDiff.missing.length) {
      console.error(`  Missing: ${namespaceDiff.missing.join(', ')}`);
    }
    if (namespaceDiff.extra.length) {
      console.error(`  Extra: ${namespaceDiff.extra.join(', ')}`);
    }
  }
}

for (const namespace of namespaces) {
  const reference = JSON.parse(await readFile(path.join(localesRoot, referenceLocale, `${namespace}.json`), 'utf8'));
  const referenceKeys = flatten(reference);

  for (const locale of localeDirs) {
    if (locale === referenceLocale) {
      continue;
    }

    const filePath = path.join(localesRoot, locale, `${namespace}.json`);
    let catalog;

    try {
      catalog = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      failed = true;
      console.error(`Unable to read ${filePath}: ${error instanceof Error ? error.message : error}`);
      continue;
    }

    const { missing, extra } = compareKeys(expectedKeysForLocale(referenceKeys, locale), flatten(catalog));
    if (missing.length || extra.length) {
      failed = true;
      console.error(`${locale}/${namespace}.json key mismatch.`);
      if (missing.length) {
        console.error(`  Missing: ${missing.join(', ')}`);
      }
      if (extra.length) {
        console.error(`  Extra: ${extra.join(', ')}`);
      }
    }
  }
}

if (failed) {
  process.exit(1);
}

console.log(`Locale key structures match for ${localeDirs.join(', ')}.`);
