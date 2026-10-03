const nodeExternals = require('webpack-node-externals');

module.exports = (options) => ({
  ...options,
  externals: [
    nodeExternals({ allowlist: [/^@worklite\/(?:db|team-runtime)(?:\/|$)/] }),
    { 'better-sqlite3': 'commonjs better-sqlite3', bindings: 'commonjs bindings' },
  ],
});
