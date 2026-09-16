// Always runs as CommonJS regardless of the package "type" field.
'use strict';
const fs = require('fs');
const src  = 'node_modules/lucide/dist/umd/lucide.min.js';
const dest = 'media/lucide.min.js';
fs.copyFileSync(src, dest);
console.log(`Copied ${src} -> ${dest}`);
