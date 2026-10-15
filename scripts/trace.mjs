#!/usr/bin/env node
// Trazabilidad spec → test (CLAUDE.md §0.4).
// Lee los IDs de criterios de docs/spec.md (**XXX-NN …**) y los busca en los nombres de test ('[XXX-NN] …').
// Escribe docs/traceability.md y termina con código 1 si hay criterios sin test o tests con IDs inexistentes.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const spec = readFileSync(join(root, 'docs/spec.md'), 'utf8');
const criteria = [...spec.matchAll(/^\*\*([A-Z]+-\d{2})\s+([^*]+)\*\*/gm)].map(([, id, title]) => ({ id, title: title.trim() }));

const testFiles = [];
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.test\.tsx?$/.test(entry)) testFiles.push(path);
  }
};
walk(join(root, 'services'));
walk(join(root, 'frontend'));

const coverage = new Map(criteria.map((c) => [c.id, []]));
const unknown = [];
for (const file of testFiles) {
  const source = readFileSync(file, 'utf8');
  for (const [, id, name] of source.matchAll(/(?:it|test)(?:\.each\([^)]*\))?\(\s*['"`]\[([A-Z]+-\d{2})\]\s*([^'"`]*)/g)) {
    const entry = { file: relative(root, file), name: name.trim() };
    if (coverage.has(id)) coverage.get(id).push(entry);
    else unknown.push({ id, ...entry });
  }
}

const missing = criteria.filter((c) => coverage.get(c.id).length === 0);
const lines = [
  '# Trazabilidad spec → tests',
  '',
  'Generado por `node scripts/trace.mjs`. No editar a mano.',
  '',
  `Criterios: ${criteria.length} · cubiertos: ${criteria.length - missing.length} · sin test: ${missing.length}`,
  '',
  '| Criterio | Descripción | Tests | Archivos |',
  '|----------|-------------|------:|----------|',
  ...criteria.map((c) => {
    const tests = coverage.get(c.id);
    const files = [...new Set(tests.map((t) => `\`${t.file}\``))].join('<br>');
    return `| ${c.id} | ${c.title} | ${tests.length || '**0**'} | ${files || '—'} |`;
  }),
];
if (unknown.length) {
  lines.push('', '## Tests con IDs que no existen en la spec', '', ...unknown.map((u) => `- ${u.id} — ${u.name} (\`${u.file}\`)`));
}
writeFileSync(join(root, 'docs/traceability.md'), `${lines.join('\n')}\n`);

console.log(`Criterios: ${criteria.length}, cubiertos: ${criteria.length - missing.length}`);
for (const c of missing) console.log(`  SIN TEST: ${c.id} ${c.title}`);
for (const u of unknown) console.log(`  ID INEXISTENTE: ${u.id} en ${u.file}`);
process.exit(missing.length || unknown.length ? 1 : 0);
