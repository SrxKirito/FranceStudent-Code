const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const target = path.join(root, 'www/pptxgen');
fs.mkdirSync(target, { recursive: true });
for (const [source, name] of [
  ['node_modules/pptxgenjs/dist/pptxgen.bundle.js', 'pptxgen.bundle.js'],
  ['node_modules/pptxgenjs/LICENSE', 'LICENSE'],
  ['node_modules/jszip/LICENSE.markdown', 'JSZip-LICENSE.markdown']
]) fs.copyFileSync(path.join(root, source), path.join(target, name));
console.log('Générateur PowerPoint et licences copiés dans www/pptxgen.');
