import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
const dir = path.resolve('supabase/migrations')
const db = await PGlite.create({ extensions: { btree_gist, pg_trgm } })
await db.exec(readFileSync('supabase/tests/support/supabase-doubles.sql', 'utf8'))
for (const f of readdirSync(dir).filter(x => x.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(path.join(dir, f), 'utf8')) }
  catch (e) { console.error('FAIL', f, '\n', e.message); process.exit(1) }
}
console.log('All migrations applied.')
await db.close()
