const { defineConfig } = require('@vscode/test-cli');\nmodule.exports = defineConfig([{ label: 'unit', files: 'out/test/**/*.test.js' }]);
