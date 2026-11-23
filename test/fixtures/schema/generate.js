'use strict';
/* Regenerates the schema fixtures that PF-006 compares fresh installs against.
   Usage: node test/fixtures/schema/generate.js <src-dir> [out-dir]
   <src-dir> is a checkout of `src/` (for the PF-006 baseline: `git archive main src` before the change).
   It starts the workspace and accounts databases exactly as the app does at startup (createAuth, createWorkspace,
   then workspace.connectionStore, which createEcosystem calls) and writes one JSON file per database. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function dumpSchema(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
      .map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
    const columns = {};
    for (const { name } of objects.filter(row => row.type === 'table'))
      columns[name] = db.prepare(`PRAGMA table_info(${JSON.stringify(name)})`).all()
        .map(col => ({ name: col.name, type: col.type, notnull: col.notnull, dflt_value: col.dflt_value, pk: col.pk }));
    return { objects, columns };
  } finally { db.close(); }
}

if (require.main === module) {
  const src = path.resolve(process.argv[2] || 'src');
  const out = path.resolve(process.argv[3] || __dirname);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'perflw-schema-'));
  try {
    const auth = require(path.join(src, 'auth.js')).createAuth(root);
    const workspace = require(path.join(src, 'workspace.js')).createWorkspace(root);
    workspace.connectionStore({ available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' });
    workspace.close(); auth.close();
    for (const name of ['workspace', 'accounts'])
      fs.writeFileSync(path.join(out, `${name}-v1.json`), JSON.stringify(dumpSchema(path.join(root, `${name}.sqlite`)), null, 2) + '\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

module.exports = { dumpSchema };
