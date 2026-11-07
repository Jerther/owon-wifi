// Bundles each page of this folder into one gzipped HTML file for the firmware to embed.
// A page's <script type="module" src> entry is inlined with OWL and every module it imports;
// a module's sibling .xml (OWL templates) and .css files with the same base name come along.
// Usage: node build.mjs <output dir>

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const WEB_DIR = path.dirname(new URL(import.meta.url).pathname);
const OWL_FILE = path.join(WEB_DIR, 'lib', 'owl.iife.min.js');
const ENTRY_PATTERN = /<script type="module" src="([^"]+)"><\/script>/;
const IMPORT_PATTERN = /^import\s[\s\S]*?\sfrom\s+'([^']+)';\s*$/gm;
const EXPORT_PATTERN = /^export (?=(async )?(function|const|let|class)\b)/gm;

function resolveImport(fromFile, specifier) {
  const base = specifier.startsWith('/') ? WEB_DIR : path.dirname(fromFile);
  return path.join(base, specifier);
}

function collectModules(file, ordered = [], visited = new Set()) {
  if (!visited.has(file)) {
    visited.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      collectModules(resolveImport(file, match[1]), ordered, visited);
    }
    ordered.push(file);
  }
  return ordered;
}

function moduleBody(file) {
  const source = fs.readFileSync(file, 'utf8');
  if (/^export\s*(\{|default)/m.test(source)) {
    throw new Error(`${file}: only "export function/const/let/class" is supported`);
  }
  return source.replace(IMPORT_PATTERN, '').replace(EXPORT_PATTERN, '');
}

function siblingFiles(modules, extension) {
  return modules
    .map((file) => file.replace(/\.js$/, extension))
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file, 'utf8'));
}

function escapeScript(code) {
  return code.replace(/<\/script/gi, '<\\/script');
}

function bundleScript(entryFile) {
  const modules = collectModules(entryFile);
  const templates = `<templates>${siblingFiles(modules, '.xml').join('\n')}</templates>`;
  const bodies = modules.map(moduleBody).join('\n');
  const app = `(() => {\nconst TEMPLATES = ${JSON.stringify(templates)};\n${bodies}\n})();`;
  return {
    script: escapeScript(`${fs.readFileSync(OWL_FILE, 'utf8')}\n${app}`),
    css: siblingFiles(modules, '.css').join('\n'),
  };
}

function buildPage(htmlFile) {
  let html = fs.readFileSync(htmlFile, 'utf8');
  const entry = html.match(ENTRY_PATTERN);
  if (entry) {
    const { script, css } = bundleScript(resolveImport(htmlFile, entry[1]));
    html = html.replace(ENTRY_PATTERN, () => `<script>\n${script}\n</script>`);
    html = html.replace('</head>', () => `<style>\n${css}\n</style>\n</head>`);
  }
  return html;
}

function main() {
  const outputDir = process.argv[2];
  fs.mkdirSync(outputDir, { recursive: true });
  for (const name of fs.readdirSync(WEB_DIR).filter((file) => file.endsWith('.html'))) {
    const html = buildPage(path.join(WEB_DIR, name));
    fs.writeFileSync(path.join(outputDir, `${name}.gz`), zlib.gzipSync(html, { level: 9 }));
  }
}

main();
