import { PGlite } from '@electric-sql/pglite'
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
const ROOT='/Users/essalhiyoussef/Desktop/atlasloca.com', MIG=path.join(ROOT,'supabase/migrations')
const db = await PGlite.create({ extensions: { btree_gist, pg_trgm } })
await db.exec(readFileSync(path.join(ROOT,'supabase/tests/support/supabase-doubles.sql'),'utf8'))
for (const f of readdirSync(MIG).filter(f=>f.endsWith('.sql')).sort()) {
  try { await db.exec(readFileSync(path.join(MIG,f),'utf8')) }
  catch (e) { console.error('✗', f, '\n   ', e.message); if (e.hint) console.error('    hint:', e.hint); if (e.detail) console.error('    detail:', e.detail); process.exit(1) }
}
console.log('ALL MIGRATIONS APPLIED')
await db.close()
