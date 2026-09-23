import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';
import copy from 'rollup-plugin-copy';

const { dependencies = {} } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
);
const dependencyNames = Object.keys(dependencies);

function isExternal(id) {
  const moduleName = id.replace(/^node:/, '');
  return (
    builtinModules.includes(moduleName) ||
    dependencyNames.some(
      (dependency) => id === dependency || id.startsWith(`${dependency}/`),
    )
  );
}

export default {
  input: 'src/start-server.ts',
  external: isExternal,
  output: {
    dir: 'build',
    format: 'es',
  },
  plugins: [
    typescript({
      exclude: ['**/*.test.ts', 'start-test.js', 'cookbook', 'docs', 'tests'],
    }),
    terser(),
    json(),
    copy({
      targets: [{ src: 'src/public/*', dest: 'build/public' }],
    }),
  ],
};
