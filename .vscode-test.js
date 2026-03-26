const { defineConfig } = require('@vscode/test-cli');
module.exports = defineConfig([{ label: 'unit', files: 'out/test/**/*.test.js' }]);
