const { defineConfig } = require('@vscode/test-cli');
module.exports = defineConfig([{
    label: 'unit',
    files: 'out/test/**/*.test.js',
    version: '1.140.0',
    launchArgs: [
        '--disable-gpu',
        '--disable-gpu-sandbox',
        '--disable-dev-shm-usage',
    ],
    mocha: {
        timeout: 20000,
    },
}]);
