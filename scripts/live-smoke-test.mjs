/**
 * Live smoke test against the real Supabase project.
 *
 * Exercises what the PGlite harness structurally cannot: PostgREST's query
 * builder (the `.or()` search, view pagination, ordering, count), Supabase
 * Storage upload and signed URL retrieval, and the GoTrue sign-up -> trigger ->
 * provisioning path end to end.
 *
 * Temporary file. Creates data prefixed "Smoke Test" and removes it at the end.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { createClient } from '@supabase/supabase-js'

/*
 * Signing a test user in is the one step in this suite that can fail for a
 * reason that has nothing to do with the product. `scripts/live-auth.mjs` retries
 * a request that never got an HTTP answer — twice, briefly — and refuses to
 * retry an answer Auth actually gave. It also returns the authenticated client
 * rather than assigning one, which is why every call site below writes its
 * module-level client FROM THE RESULT: a failed sign-in can no longer leave a
 * session-less client in shared state for two hundred later checks to assert
 * against. See supabase/tests/live-auth.test.ts.
 */
import { signInTestUser } from './live-auth.mjs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .filter((line) => line.includes('=') && !line.trim().startsWith('#'))
    .map((line) => {
      const index = line.indexOf('=')
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()]
    }),
)

const URL = env.VITE_SUPABASE_URL
const KEY = env.VITE_SUPABASE_ANON_KEY
const STAMP = Date.now().toString(36)

const results = []
let failures = 0

async function check(name, fn) {
  try {
    const detail = await fn()
    results.push({ ok: '✓', name, detail: detail ?? '' })
  } catch (error) {
    failures += 1
    results.push({ ok: '✗', name, detail: String(error?.message ?? error).slice(0, 120) })
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function sql(query, attempt = 0) {
  try {
    const out = execFileSync('npx', ['supabase', 'db', 'query', '--linked', query], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return JSON.parse(out.slice(out.indexOf('{')))
  } catch (error) {
    /*
     * The CLI provisions a temporary login role per invocation, and two
     * invocations close together occasionally collide on it — or the connection
     * itself drops. That is a tooling race, not an answer from the database, so
     * it is retried rather than reported as a product failure in a suite of 300+
     * checks. Anything else is rethrown WITH ITS TEXT, because a truncated
     * "Command failed: npx supabase db query" tells nobody anything: that is how
     * one of these transients cost a re-run to diagnose.
     */
    const text = String(error?.stdout ?? '') + String(error?.stderr ?? '')
    /*
     * Every way the CLI has failed to give us a database connection, as opposed
     * to the database giving us an answer. It provisions a temporary login role
     * per invocation over HTTP, and in a suite of 330+ checks that endpoint will
     * occasionally 502 or collide with itself — which is a tooling failure, not
     * a product one, and reporting it as a product failure is how a green suite
     * stops meaning anything.
     */
    const transient =
      /LegacyDbConfig\w*Error|login role status 5\d\d|password authentication failed|connection reset|context deadline exceeded|EOF|dial tcp|i\/o timeout|unexpected status 5\d\d/i.test(
        text,
      )
    if (attempt < 3 && transient) {
      return sql(query, attempt + 1)
    }
    throw new Error(
      `${text.trim().slice(0, 400) || String(error?.message ?? error)} — while running: ${query.trim().slice(0, 120)}`,
    )
  }
}

function client() {
  return createClient(URL, KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

/**
 * Loads a module from `src` the way the application would.
 *
 * The contract document is TSX and cannot be imported by a plain Node script.
 * Running it through Vite means the PDF this test uploads is produced by the
 * same component the browser renders, rather than by a stand-in that would
 * prove nothing about the real document.
 */
let viteServer = null
async function loadAppModule(path) {
  if (!viteServer) {
    const { createServer } = await import('vite')
    viteServer = await createServer({
      configFile: false,
      logLevel: 'error',
      server: { middlewareMode: true },
      resolve: { alias: { '@': new global.URL('../src', import.meta.url).pathname } },
    })
  }
  return viteServer.ssrLoadModule(path)
}

// A genuine 1x1 PNG and a minimal PDF — real bytes, not placeholders.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  'utf8',
)

const agencyA = { email: `smoke-a-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
const agencyB = { email: `smoke-b-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }

/**
 * Creates a confirmed user the way a completed sign-up leaves one.
 *
 * GoTrue's /signup endpoint sends a confirmation email, and this project's
 * hourly email quota is exhausted, so the HTTP endpoint cannot be exercised
 * right now. Inserting into auth.users fires exactly the same
 * on_auth_user_created trigger, so provisioning, RLS and sign-in are still
 * tested for real — only GoTrue's own signup handler is skipped.
 */
function seedConfirmedUser({ email, password }, metadata) {
  const out = sql(`
    with new_user as (
      insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
        -- GoTrue scans these into Go strings and fails with "Database error
        -- querying schema" if they are NULL. A real sign-up writes empty strings.
        confirmation_token, recovery_token, email_change, email_change_token_new,
        email_change_token_current, phone_change, phone_change_token, reauthentication_token
      ) values (
        '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
        'authenticated', 'authenticated', '${email}',
        extensions.crypt('${password}', extensions.gen_salt('bf')),
        now(), '{"provider":"email","providers":["email"]}'::jsonb,
        '${JSON.stringify(metadata).replace(/'/g, "''")}'::jsonb, now(), now(),
        '', '', '', '', '', '', '', ''
      ) returning id, email
    ), identity as (
      insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      select id::text, id,
             jsonb_build_object('sub', id::text, 'email', email, 'email_verified', true),
             'email', now(), now(), now()
      from new_user returning user_id
    )
    select user_id from identity;
  `)
  const row = (out.result ?? out.rows ?? [])[0]
  if (!row) throw new Error('failed to seed user')
  return row.user_id
}

let clientA, clientB
let orgA, orgB, vehicleA, vehicleB, imageRow, documentRow
let photoPath, thumbPath, docPath

console.log(`Running live smoke test against ${URL}\n`)

// ---------------------------------------------------------------- auth
await check('anon is refused on every tenant table', async () => {
  const anon = client()
  for (const table of ['organizations', 'vehicles', 'vehicle_images', 'vehicle_documents']) {
    const { error } = await anon.from(table).select('*').limit(1)
    assert(error, `${table} returned data to anon`)
    assert(error.code === '42501', `${table} gave ${error.code}, expected 42501`)
  }
  return 'all 42501'
})

await check('anon cannot execute any RPC', async () => {
  const anon = client()
  for (const rpc of [
    'fleet_status_counts',
    'organization_overview',
    'create_organization',
    // The reporting layer aggregates every sensitive domain at once, which
    // makes it the most valuable thing on the Data API to an unauthorised
    // caller.
    'report_business_summary',
    'report_position_summary',
    'report_fleet_performance',
    'report_customer_balances',
    'report_financing_position',
    'report_gps_coverage',
  ]) {
    const { error } = await anon.rpc(rpc, {})
    assert(error, `${rpc} was callable by anon`)
  }
  return 'all refused'
})

await check('account creation fires the provisioning trigger', async () => {
  const id = seedConfirmedUser(agencyA, {
    full_name: 'Smoke Owner A',
    organization_name: `Smoke Test Alpha ${STAMP}`,
    country_code: 'PT',
    default_currency: 'EUR',
    time_zone: 'Europe/Lisbon',
  })
  assert(id, 'no user id returned')
  return `user ${id.slice(0, 8)}…`
})

await check('agency was provisioned by the auth trigger before confirmation', async () => {
  const out = sql(
    `select o.name, m.role, m.status, o.default_currency, o.time_zone
     from public.organizations o
     join public.organization_members m on m.organization_id = o.id
     join auth.users u on u.id = m.user_id
     where u.email = '${agencyA.email}'`,
  )
  const row = (out.result ?? out.rows ?? [])[0]
  assert(row, 'no organization provisioned')
  assert(row.role === 'owner' && row.status === 'active', `role was ${row.role}/${row.status}`)
  assert(row.default_currency === 'EUR', `currency was ${row.default_currency}`)
  assert(row.time_zone === 'Europe/Lisbon', `time zone was ${row.time_zone}`)
  return `${row.name} · owner · EUR`
})

await check('sign-in returns a session after confirmation', async () => {
  // Assigned from the result, never before it: see the import comment.
  const signedIn = await signInTestUser(client, agencyA)
  clientA = signedIn.client
  assert(signedIn.session.access_token, 'no access token')
  return signedIn.attempts === 1
    ? 'session established'
    : `session established on attempt ${signedIn.attempts}`
})

await check('the signed-in user sees exactly one agency', async () => {
  const { data, error } = await clientA.from('organizations').select('*')
  assert(!error, error?.message)
  assert(data.length === 1, `saw ${data.length} organizations`)
  orgA = data[0]
  return orgA.name
})

// Second agency, for the cross-tenant checks.
await check('a second agency provisions independently', async () => {
  seedConfirmedUser(agencyB, {
    full_name: 'Smoke Owner B',
    organization_name: `Smoke Test Beta ${STAMP}`,
    default_currency: 'USD',
    time_zone: 'America/New_York',
  })

  clientB = (await signInTestUser(client, agencyB)).client

  const { data } = await clientB.from('organizations').select('*')
  assert(data.length === 1, `B saw ${data.length} organizations`)
  orgB = data[0]
  assert(orgB.id !== orgA.id, 'both agencies resolved to the same organization')
  return orgB.name
})

// ---------------------------------------------------------------- vehicles CRUD
await check('create a vehicle', async () => {
  const { data, error } = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Renault',
      model: 'Clio',
      model_year: 2023,
      registration_plate: `SMOKE-${STAMP}`,
      vin: 'VF15RJL0X12345678',
      color: 'White',
      currency: 'EUR',
      daily_rate_minor: 35_000,
      odometer: 42_150,
      status: 'available',
      insurance_expires_on: '2027-04-30',
      inspection_expires_on: '2026-08-20',
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  vehicleA = data
  return `${data.make} ${data.model} · ${data.registration_plate}`
})

await check('duplicate plate is refused within the agency', async () => {
  const { error } = await clientA.from('vehicles').insert({
    organization_id: orgA.id,
    make: 'Dacia',
    model: 'Duster',
    registration_plate: `  smoke-${STAMP}  `,
    currency: 'EUR',
  })
  assert(error, 'the duplicate plate was accepted')
  assert(error.code === '23505', `got ${error.code}`)
  return 'refused (23505)'
})

await check('storing a derived status is refused', async () => {
  const { error } = await clientA
    .from('vehicles')
    .update({ status: 'rented' })
    .eq('id', vehicleA.id)
  assert(error, "'rented' was stored on the vehicle row")
  return `refused (${error.code})`
})

await check('update a vehicle', async () => {
  const { data, error } = await clientA
    .from('vehicles')
    .update({ odometer: 43_000, notes: 'Smoke test note' })
    .eq('id', vehicleA.id)
    .select('*')
    .single()
  assert(!error, error?.message)
  assert(data.odometer === 43_000, 'odometer not updated')
  return 'odometer 43,000'
})

// ---------------------------------------------------------------- PostgREST surface
await check('read the vehicle_fleet view with derived availability', async () => {
  const { data, error } = await clientA
    .from('vehicle_fleet')
    .select('*')
    .eq('vehicle_id', vehicleA.id)
    .maybeSingle()
  assert(!error, error?.message)
  assert(data, 'view returned nothing')
  assert(data.effective_status === 'available', `status was ${data.effective_status}`)
  assert(data.is_available_now === true, 'not bookable now')
  return `effective_status=${data.effective_status}`
})

await check('the .or() search filter works over the view', async () => {
  // The exact query the fleet list builds.
  const term = `%${STAMP}%`
  const { data, error, count } = await clientA
    .from('vehicle_fleet')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgA.id)
    .is('archived_at', null)
    .or(
      [
        `make.ilike.%Renault%`,
        `model.ilike.%zzz%`,
        `registration_plate.ilike.${term}`,
        `vin.ilike.%zzz%`,
      ].join(','),
    )
    .order('created_at', { ascending: false, nullsFirst: false })
    .order('vehicle_id', { ascending: true })
    .range(0, 24)
  assert(!error, error?.message)
  assert(count === 1, `count was ${count}`)
  assert(data[0]?.vehicle_id === vehicleA.id, 'wrong row returned')
  return `count=${count}, ordering + range OK`
})

await check('the compliance date filter works', async () => {
  const { data, error } = await clientA
    .from('vehicle_fleet')
    .select('vehicle_id')
    .eq('organization_id', orgA.id)
    .or(
      [
        'insurance_expires_on.lt.2030-01-01',
        'inspection_expires_on.lt.2030-01-01',
        'registration_expires_on.lt.2030-01-01',
      ].join(','),
    )
  assert(!error, error?.message)
  assert(data.length === 1, `matched ${data.length}`)
  return 'date .or() filter OK'
})

await check('fleet_status_counts RPC', async () => {
  const { data, error } = await clientA.rpc('fleet_status_counts', {
    p_organization_id: orgA.id,
  })
  assert(!error, error?.message)
  const row = data[0]
  assert(row.total === 1 && row.available === 1, `total=${row.total} available=${row.available}`)
  return `total=${row.total} available=${row.available}`
})

await check('vehicle_usage RPC reports a deletable vehicle', async () => {
  const { data, error } = await clientA.rpc('vehicle_usage', { p_vehicle_id: vehicleA.id })
  assert(!error, error?.message)
  assert(data[0].can_delete === true, 'can_delete was false')
  return 'can_delete=true'
})

await check('vehicles_available_between RPC', async () => {
  const from = new Date(Date.now() + 86_400_000).toISOString()
  const to = new Date(Date.now() + 2 * 86_400_000).toISOString()
  const { data, error } = await clientA.rpc('vehicles_available_between', {
    p_organization_id: orgA.id,
    p_from: from,
    p_to: to,
  })
  assert(!error, error?.message)
  assert(data.includes(vehicleA.id), 'vehicle not offered')
  return `${data.length} vehicle(s) bookable`
})

await check('organization_overview RPC', async () => {
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
  const { data, error } = await clientA.rpc('organization_overview', {
    p_organization_id: orgA.id,
    p_from: from,
    p_to: to,
  })
  assert(!error, error?.message)
  const row = data[0]
  assert(row.fleet_total === 1, `fleet_total=${row.fleet_total}`)
  assert(row.revenue_minor === 0, `revenue=${row.revenue_minor}`)
  return `fleet=${row.fleet_total}, revenue=${row.revenue_minor}, currency=${row.currency}`
})

// ---------------------------------------------------------------- storage: photos
await check('upload a vehicle photo and its thumbnail', async () => {
  photoPath = `${orgA.id}/${vehicleA.id}/smoke-${STAMP}.png`
  thumbPath = `${orgA.id}/${vehicleA.id}/thumb-${STAMP}.png`

  const upload = await clientA.storage
    .from('vehicle-photos')
    .upload(photoPath, PNG, { contentType: 'image/png', upsert: false })
  assert(!upload.error, upload.error?.message)

  const thumb = await clientA.storage
    .from('vehicle-photos')
    .upload(thumbPath, PNG, { contentType: 'image/png', upsert: false })
  assert(!thumb.error, thumb.error?.message)

  return `${PNG.length} bytes × 2`
})

await check('the photo bucket refuses a disallowed MIME type', async () => {
  const { error } = await clientA.storage
    .from('vehicle-photos')
    .upload(`${orgA.id}/${vehicleA.id}/evil-${STAMP}.svg`, Buffer.from('<svg/>'), {
      contentType: 'image/svg+xml',
    })
  assert(error, 'SVG was accepted')
  return 'SVG refused'
})

await check('record the photo metadata and auto-assign primary', async () => {
  const { data, error } = await clientA
    .from('vehicle_images')
    .insert({
      organization_id: orgA.id,
      vehicle_id: vehicleA.id,
      storage_path: photoPath,
      thumbnail_path: thumbPath,
      content_type: 'image/png',
      byte_size: PNG.length,
      width: 1,
      height: 1,
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  assert(data.is_primary === true, 'first photo was not made primary')
  imageRow = data
  return 'is_primary=true'
})

await check('signed URL serves the photo bytes', async () => {
  const { data, error } = await clientA.storage
    .from('vehicle-photos')
    .createSignedUrl(photoPath, 60)
  assert(!error, error?.message)
  assert(data.signedUrl, 'no signed URL')

  const response = await fetch(data.signedUrl)
  assert(response.ok, `fetch returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert(bytes.length === PNG.length, `got ${bytes.length} bytes, expected ${PNG.length}`)
  assert(bytes[0] === 0x89 && bytes[1] === 0x50, 'bytes are not a PNG')
  return `${bytes.length} bytes fetched`
})

await check('batch signing works for a list page', async () => {
  const { data, error } = await clientA.storage
    .from('vehicle-photos')
    .createSignedUrls([photoPath, thumbPath], 60)
  assert(!error, error?.message)
  assert(data.length === 2 && data.every((entry) => entry.signedUrl), 'not all URLs signed')
  return '2 URLs in one request'
})

await check('an unsigned object URL is not publicly readable', async () => {
  const response = await fetch(`${URL}/storage/v1/object/vehicle-photos/${photoPath}`)
  assert(!response.ok, `public fetch succeeded with ${response.status}`)
  return `refused (${response.status})`
})

// ---------------------------------------------------------------- storage: documents
await check('create a document record and attach a PDF', async () => {
  const created = await clientA
    .from('vehicle_documents')
    .insert({
      organization_id: orgA.id,
      vehicle_id: vehicleA.id,
      document_type: 'insurance',
      document_number: `POL-${STAMP}`,
      expires_on: '2027-04-30',
    })
    .select('*')
    .single()
  assert(!created.error, created.error?.message)
  documentRow = created.data

  docPath = `${orgA.id}/${vehicleA.id}/doc-${STAMP}.pdf`
  const upload = await clientA.storage
    .from('vehicle-documents')
    .upload(docPath, PDF, { contentType: 'application/pdf' })
  assert(!upload.error, upload.error?.message)

  const linked = await clientA
    .from('vehicle_documents')
    .update({ file_path: docPath })
    .eq('id', documentRow.id)
    .select('file_path')
    .single()
  assert(!linked.error, linked.error?.message)
  assert(linked.data.file_path === docPath, 'file_path not linked')

  const signed = await clientA.storage.from('vehicle-documents').createSignedUrl(docPath, 60)
  assert(!signed.error, signed.error?.message)
  const response = await fetch(signed.data.signedUrl)
  assert(response.ok, `document fetch returned ${response.status}`)
  return `${PDF.length} byte PDF, signed URL OK`
})

// ---------------------------------------------------------------- tenant isolation, live
await check('agency B cannot see agency A’s vehicle', async () => {
  const { data, error } = await clientB.from('vehicles').select('*').eq('id', vehicleA.id)
  assert(!error, error?.message)
  assert(data.length === 0, 'B could read A’s vehicle')
  return 'no rows'
})

await check('agency B cannot see it through the view either', async () => {
  const { data } = await clientB.from('vehicle_fleet').select('*').eq('vehicle_id', vehicleA.id)
  assert(data.length === 0, 'B could read A’s vehicle via the view')
  return 'no rows'
})

await check('agency B cannot modify agency A’s vehicle', async () => {
  const { data } = await clientB
    .from('vehicles')
    .update({ odometer: 999_999 })
    .eq('id', vehicleA.id)
    .select('*')
  assert(!data || data.length === 0, 'B modified A’s vehicle')

  const { data: after } = await clientA
    .from('vehicles')
    .select('odometer')
    .eq('id', vehicleA.id)
    .single()
  assert(after.odometer === 43_000, `odometer changed to ${after.odometer}`)
  return 'unchanged'
})

await check('agency B cannot insert into agency A', async () => {
  const { error } = await clientB.from('vehicles').insert({
    organization_id: orgA.id,
    make: 'Injected',
    model: 'Row',
    registration_plate: `HACK-${STAMP}`,
    currency: 'EUR',
  })
  assert(error, 'B inserted into A')
  assert(error.code === '42501', `got ${error.code}`)
  return 'refused (42501)'
})

await check('agency B cannot sign a URL for agency A’s photo', async () => {
  const { data, error } = await clientB.storage
    .from('vehicle-photos')
    .createSignedUrl(photoPath, 60)
  assert(error || !data?.signedUrl, 'B obtained a signed URL for A’s photo')
  return 'refused'
})

await check('agency B cannot upload under agency A’s prefix', async () => {
  const { error } = await clientB.storage
    .from('vehicle-photos')
    .upload(`${orgA.id}/${vehicleA.id}/steal-${STAMP}.png`, PNG, { contentType: 'image/png' })
  assert(error, 'B wrote into A’s prefix')
  return 'refused'
})

await check('agency B is refused agency A’s analytics', async () => {
  const now = new Date()
  const { error } = await clientB.rpc('organization_overview', {
    p_organization_id: orgA.id,
    p_from: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(),
    p_to: new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString(),
  })
  assert(error, 'B read A’s analytics')
  return 'refused'
})

await check('a foreign vehicle id is indistinguishable from a missing one', async () => {
  const foreign = await clientB.rpc('vehicle_usage', { p_vehicle_id: vehicleA.id })
  const missing = await clientB.rpc('vehicle_usage', {
    p_vehicle_id: '00000000-0000-0000-0000-000000000000',
  })
  assert(foreign.error && missing.error, 'one of the calls succeeded')
  assert(
    foreign.error.message === missing.error.message,
    `messages differ: "${foreign.error.message}" vs "${missing.error.message}"`,
  )
  return 'identical errors'
})

// ---------------------------------------------------------------- archive & delete
await check('archive and restore a vehicle', async () => {
  const archived = await clientA
    .from('vehicles')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', vehicleA.id)
    .select('archived_at')
    .single()
  assert(!archived.error, archived.error?.message)
  assert(archived.data.archived_at, 'not archived')

  const counts = await clientA.rpc('fleet_status_counts', { p_organization_id: orgA.id })
  assert(counts.data[0].total === 0, `live total was ${counts.data[0].total}`)
  assert(counts.data[0].archived === 1, `archived was ${counts.data[0].archived}`)

  const restored = await clientA
    .from('vehicles')
    .update({ archived_at: null })
    .eq('id', vehicleA.id)
    .select('archived_at')
    .single()
  assert(!restored.error, restored.error?.message)
  assert(restored.data.archived_at === null, 'not restored')
  return 'archived → counts moved → restored'
})

await check('deleting a vehicle cascades its photos and documents', async () => {
  // Files first, so nothing is orphaned in the bucket.
  await clientA.storage.from('vehicle-photos').remove([photoPath, thumbPath])
  await clientA.storage.from('vehicle-documents').remove([docPath])

  const { error } = await clientA.from('vehicles').delete().eq('id', vehicleA.id)
  assert(!error, error?.message)

  const images = await clientA.from('vehicle_images').select('id').eq('id', imageRow.id)
  const documents = await clientA.from('vehicle_documents').select('id').eq('id', documentRow.id)
  assert(images.data.length === 0, 'image row survived')
  assert(documents.data.length === 0, 'document row survived')
  return 'vehicle, image and document rows removed'
})

// ---------------------------------------------------------------- customers
let customerA, customerB, docA, licenceA, custVehicle, custRental, staffClient
let liveContract
let customerDocPath

await check('create a customer', async () => {
  const { data, error } = await clientA
    .from('customers')
    .insert({
      organization_id: orgA.id,
      first_name: 'Amina',
      last_name: `Benali ${STAMP}`,
      email: `amina-${STAMP}@atlasloca.com`,
      phone: '+212 600 112233',
      nationality_country_code: 'MA',
      country_code: 'MA',
      city: 'Casablanca',
      date_of_birth: '1990-04-12',
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  customerA = data
  return data.display_name
})

await check('read the customer through the directory view', async () => {
  const { data, error } = await clientA
    .from('customer_directory')
    .select('*')
    .eq('customer_id', customerA.id)
    .maybeSingle()
  assert(!error, error?.message)
  assert(data, 'view returned nothing')
  assert(data.has_driver_license === false, 'licence reported before one exists')
  assert(data.rental_count === 0, `rental_count was ${data.rental_count}`)
  return 'directory row OK'
})

await check('update a customer', async () => {
  const { data, error } = await clientA
    .from('customers')
    .update({ city: 'Rabat', notes: 'Prefers automatic vehicles' })
    .eq('id', customerA.id)
    .select('city, notes')
    .single()
  assert(!error, error?.message)
  assert(data.city === 'Rabat', 'city not updated')
  return 'city + notes updated'
})

await check('record an identity document', async () => {
  const { data, error } = await clientA
    .from('customer_documents')
    .insert({
      organization_id: orgA.id,
      customer_id: customerA.id,
      document_type: 'passport',
      document_number: `AB ${STAMP} 456`,
      issuing_country: 'MA',
      expires_on: '2030-04-12',
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  assert(
    data.document_number_normalized === `AB${STAMP.toUpperCase()}456`,
    `normalised to ${data.document_number_normalized}`,
  )
  docA = data
  return `normalised: ${data.document_number_normalized}`
})

await check('the same passport is refused however it is typed', async () => {
  const { data: other } = await clientA
    .from('customers')
    .insert({ organization_id: orgA.id, first_name: 'Second', last_name: `Person ${STAMP}` })
    .select('id')
    .single()

  const { error } = await clientA.from('customer_documents').insert({
    organization_id: orgA.id,
    customer_id: other.id,
    document_type: 'passport',
    document_number: `ab-${STAMP}-456`,
    issuing_country: 'MA',
  })
  assert(error, 'the duplicate passport was accepted')
  assert(error.code === '23505', `got ${error.code}`)

  await clientA.from('customers').delete().eq('id', other.id)
  return 'refused (23505)'
})

await check('record a driving licence with classes', async () => {
  const { data, error } = await clientA
    .from('customer_documents')
    .insert({
      organization_id: orgA.id,
      customer_id: customerA.id,
      document_type: 'driver_license',
      document_number: `DL${STAMP}`,
      issuing_country: 'MA',
      issued_on: '2015-01-01',
      expires_on: '2030-09-30',
      license_classes: ['B', 'C1'],
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  licenceA = data
  return 'classes B, C1'
})

await check('vehicle classes are refused on a passport', async () => {
  const { error } = await clientA.from('customer_documents').insert({
    organization_id: orgA.id,
    customer_id: customerA.id,
    document_type: 'passport',
    document_number: `CLS${STAMP}`,
    license_classes: ['B'],
  })
  assert(error, 'classes were accepted on a passport')
  return `refused (${error.code})`
})

await check('the directory reports licence validity without the number', async () => {
  const { data, error } = await clientA
    .from('customer_directory')
    .select('*')
    .eq('customer_id', customerA.id)
    .single()
  assert(!error, error?.message)
  assert(data.has_driver_license === true, 'licence not detected')
  assert(data.driver_license_expires_on === '2030-09-30', 'expiry missing')

  const serialised = JSON.stringify(data)
  /*
   * Match the whole distinctive identifier, never a fragment of one. A bare
   * '456' is three characters that also turn up by chance inside the UUIDs and
   * timestamps this row is full of — measured at about one run in twenty — so
   * it failed the suite without a number ever having leaked. Both documents
   * are checked as typed AND as the database normalises them, because either
   * form appearing here would be the disclosure this check exists to catch.
   */
  const leakable = {
    'licence number': `DL${STAMP}`,
    'normalised licence number': `DL${STAMP.toUpperCase()}`,
    'passport number': `AB ${STAMP} 456`,
    'normalised passport number': `AB${STAMP.toUpperCase()}456`,
  }
  for (const [what, value] of Object.entries(leakable)) {
    assert(!serialised.includes(value), `the ${what} leaked into the list read model`)
  }
  return 'validity present, numbers absent'
})

await check('duplicate detection flags the same passport strongly', async () => {
  const { data, error } = await clientA.rpc('find_customer_duplicates', {
    p_organization_id: orgA.id,
    p_email: null,
    p_phone: null,
    p_documents: [
      { document_type: 'passport', document_number: `ab${STAMP}456`, issuing_country: 'MA' },
    ],
  })
  assert(!error, error?.message)
  assert(data.length === 1, `got ${data.length} hints`)
  assert(data[0].customer_id === customerA.id, 'wrong customer matched')
  assert(data[0].match_strength === 'strong', `strength was ${data[0].match_strength}`)
  return 'strong match on normalised passport'
})

await check('shared contact details are only a weak hint', async () => {
  const { data, error } = await clientA.rpc('find_customer_duplicates', {
    p_organization_id: orgA.id,
    p_email: `amina-${STAMP}@atlasloca.com`,
    p_phone: '+212600112233',
    p_documents: [],
  })
  assert(!error, error?.message)
  assert(data.length >= 1, 'no hint for a shared phone')
  assert(
    data.every((hint) => hint.match_strength === 'weak'),
    'contact match reported as strong',
  )
  return 'weak (never blocks)'
})

await check('search finds a customer by name, phone and document number', async () => {
  const byName = await clientA
    .from('customer_directory')
    .select('customer_id', { count: 'exact' })
    .eq('organization_id', orgA.id)
    .is('archived_at', null)
    .or(`display_name.ilike.%Benali ${STAMP}%,email.ilike.%zzz%,phone.ilike.%zzz%`)
    .range(0, 24)
  assert(!byName.error, byName.error?.message)
  assert(byName.count === 1, `name search returned ${byName.count}`)

  const byPhone = await clientA
    .from('customer_directory')
    .select('customer_id')
    .eq('organization_id', orgA.id)
    .or('phone.ilike.%600 112233%')
  assert(!byPhone.error, byPhone.error?.message)
  assert(byPhone.data.length === 1, 'phone search failed')

  // Document search runs against the normalised column, as the service does.
  const byDocument = await clientA
    .from('customer_documents')
    .select('customer_id')
    .eq('organization_id', orgA.id)
    .ilike('document_number_normalized', `%${STAMP.toUpperCase()}456%`)
  assert(!byDocument.error, byDocument.error?.message)
  assert(byDocument.data[0]?.customer_id === customerA.id, 'document search failed')

  return 'name + phone + document'
})

await check('pagination and ordering work over the directory', async () => {
  const { data, error, count } = await clientA
    .from('customer_directory')
    .select('*', { count: 'exact' })
    .eq('organization_id', orgA.id)
    .is('archived_at', null)
    .order('display_name', { ascending: true, nullsFirst: false })
    .order('customer_id', { ascending: true })
    .range(0, 0)
  assert(!error, error?.message)
  assert(data.length === 1, `page size honoured? got ${data.length}`)
  assert(typeof count === 'number', 'no exact count')
  return `count=${count}, page size 1`
})

await check('upload an identification scan and fetch it back', async () => {
  customerDocPath = `${orgA.id}/${customerA.id}/passport-${STAMP}.pdf`

  const upload = await clientA.storage
    .from('customer-documents')
    .upload(customerDocPath, PDF, { contentType: 'application/pdf', upsert: false })
  assert(!upload.error, upload.error?.message)

  const linked = await clientA
    .from('customer_documents')
    .update({
      file_path: customerDocPath,
      file_name: 'passport.pdf',
      file_mime_type: 'application/pdf',
      file_size_bytes: PDF.length,
      uploaded_at: new Date().toISOString(),
    })
    .eq('id', docA.id)
    .select('file_path, file_name')
    .single()
  assert(!linked.error, linked.error?.message)
  assert(linked.data.file_path === customerDocPath, 'file_path not linked')

  const signed = await clientA.storage
    .from('customer-documents')
    .createSignedUrl(customerDocPath, 60)
  assert(!signed.error, signed.error?.message)

  const response = await fetch(signed.data.signedUrl)
  assert(response.ok, `fetch returned ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert(bytes.length === PDF.length, `got ${bytes.length} bytes`)
  return `${bytes.length} byte scan fetched`
})

await check('the customer bucket refuses a disallowed type', async () => {
  const { error } = await clientA.storage
    .from('customer-documents')
    .upload(`${orgA.id}/${customerA.id}/evil-${STAMP}.svg`, Buffer.from('<svg/>'), {
      contentType: 'image/svg+xml',
    })
  assert(error, 'SVG was accepted')
  return 'SVG refused'
})

await check('an identification scan is not publicly readable', async () => {
  const response = await fetch(`${URL}/storage/v1/object/customer-documents/${customerDocPath}`)
  assert(!response.ok, `public fetch succeeded with ${response.status}`)
  return `refused (${response.status})`
})

await check('rental history and per-currency finance are reported', async () => {
  const vehicle = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Kia',
      model: 'Rio',
      registration_plate: `CUST-${STAMP}`,
      currency: 'EUR',
    })
    .select('id')
    .single()
  assert(!vehicle.error, vehicle.error?.message)
  custVehicle = vehicle.data

  const rental = await clientA
    .from('rentals')
    .insert({
      organization_id: orgA.id,
      vehicle_id: custVehicle.id,
      customer_id: customerA.id,
      starts_at: '2029-01-01T09:00:00Z',
      ends_at: '2029-01-05T09:00:00Z',
      currency: 'EUR',
      status: 'completed',
      total_minor: 50000,
      completed_at: '2029-01-05T09:00:00Z',
    })
    .select('id')
    .single()
  assert(!rental.error, rental.error?.message)
  custRental = rental.data

  const summary = await clientA.rpc('customer_rental_summary', { p_customer_id: customerA.id })
  assert(!summary.error, summary.error?.message)
  assert(summary.data[0].rental_count === 1, `rental_count ${summary.data[0].rental_count}`)

  const finance = await clientA.rpc('customer_financial_summary', { p_customer_id: customerA.id })
  assert(!finance.error, finance.error?.message)
  assert(finance.data.length === 1, `${finance.data.length} currency rows`)
  assert(finance.data[0].currency === 'EUR', 'wrong currency')
  assert(
    finance.data[0].outstanding_minor === 50000,
    `outstanding ${finance.data[0].outstanding_minor}`,
  )

  const directory = await clientA
    .from('customer_directory')
    .select('outstanding_currency_count, outstanding_minor, outstanding_currency')
    .eq('customer_id', customerA.id)
    .single()
  assert(directory.data.outstanding_currency_count === 1, 'currency count wrong')
  assert(directory.data.outstanding_minor === 50000, 'outstanding not reported')

  return '1 rental, EUR 500.00 outstanding'
})

await check('a second currency suppresses the single total', async () => {
  const vehicle = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Kia',
      model: 'Ceed',
      registration_plate: `CUST2-${STAMP}`,
      currency: 'USD',
    })
    .select('id')
    .single()

  await clientA.from('rentals').insert({
    organization_id: orgA.id,
    vehicle_id: vehicle.data.id,
    customer_id: customerA.id,
    starts_at: '2029-03-01T09:00:00Z',
    ends_at: '2029-03-05T09:00:00Z',
    currency: 'USD',
    status: 'completed',
    total_minor: 30000,
    completed_at: '2029-03-05T09:00:00Z',
  })

  const directory = await clientA
    .from('customer_directory')
    .select('outstanding_currency_count, outstanding_minor')
    .eq('customer_id', customerA.id)
    .single()

  // Two currencies, so no single figure — never EUR + USD added together.
  assert(directory.data.outstanding_currency_count === 2, 'currency count wrong')
  assert(directory.data.outstanding_minor === null, 'a mixed-currency total was reported')

  await clientA
    .from('vehicles')
    .delete()
    .eq('id', vehicle.data.id)
    .then(() => undefined)
  return 'mixed currencies reported honestly'
})

await check('customer_usage refuses deletion of a customer with history', async () => {
  const { data, error } = await clientA.rpc('customer_usage', { p_customer_id: customerA.id })
  assert(!error, error?.message)
  assert(data[0].rentals_count >= 1, 'rentals not counted')
  assert(data[0].can_delete === false, 'can_delete was true despite history')

  const remove = await clientA.from('customers').delete().eq('id', customerA.id).select('id')
  assert(remove.error || (remove.data ?? []).length === 0, 'the customer was deleted')
  return 'delete refused, archive is the path'
})

await check('archive and restore a customer', async () => {
  const archived = await clientA
    .from('customers')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', customerA.id)
    .select('archived_at')
    .single()
  assert(!archived.error, archived.error?.message)
  assert(archived.data.archived_at, 'not archived')

  // Archived customers stay attached to their contracts.
  const stillOnContract = await clientA
    .from('rentals')
    .select('id, customer_id')
    .eq('customer_id', customerA.id)
  assert(stillOnContract.data.length >= 1, 'contract lost its customer')

  const hidden = await clientA
    .from('customer_directory')
    .select('customer_id')
    .eq('organization_id', orgA.id)
    .is('archived_at', null)
    .eq('customer_id', customerA.id)
  assert(hidden.data.length === 0, 'archived customer still in the default list')

  const restored = await clientA
    .from('customers')
    .update({ archived_at: null })
    .eq('id', customerA.id)
    .select('archived_at')
    .single()
  assert(restored.data.archived_at === null, 'not restored')
  return 'archived → hidden from list, kept on contract → restored'
})

await check('role enforcement holds through the API, not just the interface', async () => {
  const staff = { email: `smoke-staff-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
  const staffId = seedConfirmedUser(staff, { full_name: 'Smoke Staff' })

  sql(
    `insert into public.organization_members (organization_id, user_id, role)
     values ('${orgA.id}', '${staffId}', 'staff')`,
  )

  staffClient = (await signInTestUser(client, staff)).client

  // Staff may record identification…
  const created = await staffClient.from('customer_documents').insert({
    organization_id: orgA.id,
    customer_id: customerA.id,
    document_type: 'other',
    document_number: `STAFF-${STAMP}`,
  })
  assert(!created.error, `staff could not record a document: ${created.error?.message}`)

  // …but not delete it.
  await staffClient.from('customer_documents').delete().eq('document_number', `STAFF-${STAMP}`)
  const survived = await clientA
    .from('customer_documents')
    .select('id')
    .eq('document_number', `STAFF-${STAMP}`)
  assert(survived.data.length === 1, 'staff deleted a document')

  // …and not permanently delete a customer.
  const disposable = await clientA
    .from('customers')
    .insert({ organization_id: orgA.id, first_name: 'Role', last_name: `Probe ${STAMP}` })
    .select('id')
    .single()
  await staffClient.from('customers').delete().eq('id', disposable.data.id)
  const stillThere = await clientA.from('customers').select('id').eq('id', disposable.data.id)
  assert(stillThere.data.length === 1, 'staff permanently deleted a customer')

  // The owner can, because nothing financial refers to it.
  await clientA.from('customers').delete().eq('id', disposable.data.id)
  return 'staff: create yes, delete no'
})

await check('agency B cannot see agency A’s customer', async () => {
  const direct = await clientB.from('customers').select('*').eq('id', customerA.id)
  assert(direct.data.length === 0, 'B read A’s customer')

  const view = await clientB.from('customer_directory').select('*').eq('customer_id', customerA.id)
  assert(view.data.length === 0, 'B read A’s customer through the view')
  return 'no rows'
})

await check('agency B cannot search agency A’s customers', async () => {
  const { data } = await clientB
    .from('customer_directory')
    .select('customer_id')
    .or(`display_name.ilike.%Benali ${STAMP}%`)
  assert(data.length === 0, 'B found A’s customer by name')
  return 'no rows'
})

await check('agency B cannot read agency A’s identification', async () => {
  const { data } = await clientB.from('customer_documents').select('*').eq('id', docA.id)
  assert(data.length === 0, 'B read A’s document row')
  return 'no rows'
})

await check('agency B gets no duplicate hints about agency A', async () => {
  const { data, error } = await clientB.rpc('find_customer_duplicates', {
    p_organization_id: orgB.id,
    p_email: `amina-${STAMP}@atlasloca.com`,
    p_phone: '+212600112233',
    p_documents: [
      { document_type: 'passport', document_number: `ab${STAMP}456`, issuing_country: 'MA' },
    ],
  })
  assert(!error, error?.message)
  assert(data.length === 0, `B received ${data.length} hints about A`)
  return 'no cross-tenant hints'
})

await check('agency B is refused duplicate detection against agency A', async () => {
  const { error } = await clientB.rpc('find_customer_duplicates', {
    p_organization_id: orgA.id,
    p_email: null,
    p_phone: null,
    p_documents: [],
  })
  assert(error, 'B ran duplicate detection against A')
  return 'refused'
})

await check('agency B cannot mint a signed URL for agency A’s scan', async () => {
  const { data, error } = await clientB.storage
    .from('customer-documents')
    .createSignedUrl(customerDocPath, 60)
  assert(error || !data?.signedUrl, 'B obtained a signed URL for A’s passport scan')
  return 'refused'
})

await check('agency B cannot upload under agency A’s customer prefix', async () => {
  const { error } = await clientB.storage
    .from('customer-documents')
    .upload(`${orgA.id}/${customerA.id}/steal-${STAMP}.pdf`, PDF, {
      contentType: 'application/pdf',
    })
  assert(error, 'B wrote into A’s prefix')
  return 'refused'
})

await check('agency B cannot modify or archive agency A’s customer', async () => {
  await clientB.from('customers').update({ first_name: 'Hacked' }).eq('id', customerA.id)
  await clientB
    .from('customers')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', customerA.id)

  const { data } = await clientA
    .from('customers')
    .select('first_name, archived_at')
    .eq('id', customerA.id)
    .single()
  assert(data.first_name === 'Amina', `first_name became ${data.first_name}`)
  assert(data.archived_at === null, 'B archived A’s customer')
  return 'unchanged'
})

await check('a foreign customer id is indistinguishable from a missing one', async () => {
  const foreign = await clientB.rpc('customer_usage', { p_customer_id: customerA.id })
  const missing = await clientB.rpc('customer_usage', {
    p_customer_id: '00000000-0000-0000-0000-000000000000',
  })
  assert(foreign.error && missing.error, 'one of the calls succeeded')
  assert(
    foreign.error.message === missing.error.message,
    `messages differ: "${foreign.error.message}" vs "${missing.error.message}"`,
  )
  return 'identical errors'
})

await check('customer teardown removes contracts, documents and scans', async () => {
  await clientA.storage.from('customer-documents').remove([customerDocPath])
  await clientA.from('rentals').delete().eq('customer_id', customerA.id)
  await clientA.from('customers').delete().eq('id', customerA.id)
  await clientA.from('vehicles').delete().eq('id', custVehicle.id)

  const documents = await clientA.from('customer_documents').select('id').eq('id', docA.id)
  assert(documents.data.length === 0, 'document row survived its customer')
  assert(licenceA.id, 'licence was recorded')
  assert(custRental.id, 'rental was recorded')
  return 'customer, documents and scan removed'
})

// ------------------------------------------------- rentals, contracts, money
let rentVehicle, rentVehicle2, renter, rentDriver, liveRental, contractPdfPath

const iso = (days, hour = 9) => {
  const date = new Date(Date.UTC(2029, 5, 1 + days, hour, 0, 0))
  return date.toISOString()
}

await check('rental fixtures are created', async () => {
  const first = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Peugeot',
      model: '208',
      registration_plate: `RNT1-${STAMP}`,
      currency: 'EUR',
      daily_rate_minor: 5000,
      odometer: 20000,
    })
    .select('id')
    .single()
  assert(!first.error, first.error?.message)
  rentVehicle = first.data

  const second = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Dacia',
      model: 'Sandero',
      registration_plate: `RNT2-${STAMP}`,
      currency: 'EUR',
      daily_rate_minor: 4000,
      odometer: 15000,
    })
    .select('id')
    .single()
  assert(!second.error, second.error?.message)
  rentVehicle2 = second.data

  const person = await clientA
    .from('customers')
    .insert({ organization_id: orgA.id, first_name: 'Rania', last_name: `Idrissi ${STAMP}` })
    .select('id')
    .single()
  assert(!person.error, person.error?.message)
  renter = person.data

  const driver = await clientA
    .from('customers')
    .insert({ organization_id: orgA.id, first_name: 'Karim', last_name: `Alaoui ${STAMP}` })
    .select('id')
    .single()
  assert(!driver.error, driver.error?.message)
  rentDriver = driver.data

  return '2 vehicles, 2 customers'
})

async function draftRental(vehicleId, startsAt, endsAt, extra = {}) {
  const { data, error } = await clientA
    .from('rentals')
    .insert({
      organization_id: orgA.id,
      vehicle_id: vehicleId,
      customer_id: renter.id,
      starts_at: startsAt,
      ends_at: endsAt,
      currency: 'EUR',
      daily_rate_minor: 5000,
      billable_days: 3,
      tax_rate_bps: 2000,
      tax_label: 'VAT',
      deposit_minor: 30000,
      ...extra,
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  return data
}

await check('a contract reference is minted with the agency prefix and year', async () => {
  const rental = await draftRental(rentVehicle.id, iso(0), iso(3))
  liveRental = rental
  assert(/^[A-Z0-9]+-\d{4}-\d{5}$/.test(rental.reference), `reference was ${rental.reference}`)
  assert(rental.status === 'draft', `status was ${rental.status}`)
  return rental.reference
})

await check('concurrent contract creation never mints the same reference twice', async () => {
  // Six parallel inserts over separate PostgREST connections. The counter is
  // taken with UPDATE … RETURNING, which serialises them on the settings row.
  const created = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      clientA
        .from('rentals')
        .insert({
          organization_id: orgA.id,
          vehicle_id: rentVehicle2.id,
          customer_id: renter.id,
          starts_at: iso(40 + index * 5),
          ends_at: iso(42 + index * 5),
          currency: 'EUR',
        })
        .select('id, reference')
        .single(),
    ),
  )

  for (const row of created) assert(!row.error, row.error?.message)
  const references = created.map((row) => row.data.reference)
  assert(new Set(references).size === 6, `duplicate references: ${references.join(', ')}`)

  await clientA
    .from('rentals')
    .delete()
    .in(
      'id',
      created.map((row) => row.data.id),
    )

  return `6 parallel inserts, 6 distinct references`
})

await check('line items drive every charge column on the contract', async () => {
  const lines = await clientA.from('rental_line_items').insert([
    {
      organization_id: orgA.id,
      rental_id: liveRental.id,
      kind: 'base_rental',
      description: '3 days of hire',
      quantity: 3,
      unit_amount_minor: 5000,
      amount_minor: 15000,
      currency: 'EUR',
      sort_order: 0,
    },
    {
      organization_id: orgA.id,
      rental_id: liveRental.id,
      kind: 'child_seat',
      description: 'Child seat',
      amount_minor: 3000,
      currency: 'EUR',
      sort_order: 1,
    },
    {
      organization_id: orgA.id,
      rental_id: liveRental.id,
      kind: 'discount',
      description: 'Returning customer',
      amount_minor: -1800,
      currency: 'EUR',
      sort_order: 2,
    },
  ])
  assert(!lines.error, lines.error?.message)

  const { data } = await clientA
    .from('rentals')
    .select('subtotal_minor, extras_minor, discount_minor, tax_minor, total_minor')
    .eq('id', liveRental.id)
    .single()

  assert(data.subtotal_minor === 15000, `subtotal ${data.subtotal_minor}`)
  assert(data.extras_minor === 3000, `extras ${data.extras_minor}`)
  assert(data.discount_minor === 1800, `discount ${data.discount_minor}`)
  assert(data.tax_minor === 3240, `tax ${data.tax_minor}`)
  assert(data.total_minor === 19440, `total ${data.total_minor}`)
  return 'subtotal 150.00, tax 32.40, total 194.40'
})

await check('a total written directly is ignored', async () => {
  await clientA.from('rentals').update({ total_minor: 999999 }).eq('id', liveRental.id)
  const { data } = await clientA
    .from('rentals')
    .select('total_minor')
    .eq('id', liveRental.id)
    .single()
  assert(data.total_minor === 19440, `total became ${data.total_minor}`)
  return 'restored to 194.40'
})

await check('a draft cannot be confirmed with nobody named as the driver', async () => {
  const { error } = await clientA.rpc('rental_confirm', { p_rental_id: liveRental.id })
  assert(error, 'it was confirmed without a driver')
  assert(/primary driver/i.test(error.message), error.message)
  return 'refused'
})

await check('confirming a reservation holds the vehicle', async () => {
  const driver = await clientA.from('rental_drivers').insert({
    organization_id: orgA.id,
    rental_id: liveRental.id,
    customer_id: rentDriver.id,
    driver_role: 'primary',
  })
  assert(!driver.error, driver.error?.message)

  const { data, error } = await clientA.rpc('rental_confirm', { p_rental_id: liveRental.id })
  assert(!error, error?.message)
  // A function returning one composite row comes back as an object, not a list.
  assert(data.status === 'reserved', `status ${data.status}`)

  const free = await clientA.rpc('vehicles_available_between', {
    p_organization_id: orgA.id,
    p_from: iso(1),
    p_to: iso(2),
  })
  assert(!free.data.includes(rentVehicle.id), 'the vehicle is still offered as available')
  return 'reserved, and no longer available'
})

await check(
  'two people confirming the same vehicle at the same moment cannot both win',
  async () => {
    // Real concurrency: two overlapping drafts, confirmed in parallel over
    // separate HTTP requests and therefore separate database transactions.
    const one = await draftRental(rentVehicle2.id, iso(100), iso(104))
    const two = await draftRental(rentVehicle2.id, iso(102), iso(106))

    await clientA.from('rental_drivers').insert([
      {
        organization_id: orgA.id,
        rental_id: one.id,
        customer_id: rentDriver.id,
        driver_role: 'primary',
      },
      {
        organization_id: orgA.id,
        rental_id: two.id,
        customer_id: rentDriver.id,
        driver_role: 'primary',
      },
    ])

    const [first, second] = await Promise.all([
      clientA.rpc('rental_confirm', { p_rental_id: one.id }),
      staffClient.rpc('rental_confirm', { p_rental_id: two.id }),
    ])

    const winners = [first, second].filter((result) => !result.error)
    const losers = [first, second].filter((result) => result.error)
    assert(winners.length === 1, `${winners.length} confirmations succeeded`)
    assert(losers.length === 1, 'nobody was refused')
    assert(
      /overlap|conflicting key|exclusion/i.test(losers[0].error.message),
      `refused for the wrong reason: ${losers[0].error.message}`,
    )

    await clientA.from('rentals').delete().in('id', [one.id, two.id])
    return 'exactly one confirmation won'
  },
)

await check('a deposit is held, not counted as payment for the hire', async () => {
  const { data, error } = await clientA.rpc('rental_record_payment', {
    p_rental_id: liveRental.id,
    p_amount_minor: 30000,
    p_direction: 'inbound',
    p_purpose: 'deposit',
    p_method: 'card',
  })
  assert(!error, error?.message)
  assert(data.purpose === 'deposit', 'purpose was not recorded')

  const rental = await clientA
    .from('rentals')
    .select('amount_paid_minor, deposit_held_minor, balance_due_minor, payment_status')
    .eq('id', liveRental.id)
    .single()

  assert(rental.data.deposit_held_minor === 30000, `held ${rental.data.deposit_held_minor}`)
  assert(rental.data.amount_paid_minor === 0, `paid ${rental.data.amount_paid_minor}`)
  assert(rental.data.balance_due_minor === 19440, `balance ${rental.data.balance_due_minor}`)
  assert(rental.data.payment_status === 'unpaid', rental.data.payment_status)
  return 'deposit 300.00 held, balance untouched'
})

await check('a rental payment settles the balance', async () => {
  const { error } = await clientA.rpc('rental_record_payment', {
    p_rental_id: liveRental.id,
    p_amount_minor: 19440,
    p_direction: 'inbound',
    p_purpose: 'rental_charge',
    p_method: 'cash',
  })
  assert(!error, error?.message)

  const { data } = await clientA
    .from('rentals')
    .select('amount_paid_minor, balance_due_minor, payment_status, deposit_held_minor')
    .eq('id', liveRental.id)
    .single()

  assert(data.amount_paid_minor === 19440, `paid ${data.amount_paid_minor}`)
  assert(data.balance_due_minor === 0, `balance ${data.balance_due_minor}`)
  assert(data.payment_status === 'paid', data.payment_status)
  assert(data.deposit_held_minor === 30000, 'the deposit moved')
  return 'paid in full, deposit still held'
})

await check('the dashboard counts the hire as revenue and the deposit as neither', async () => {
  const { data, error } = await clientA.rpc('organization_overview', {
    p_organization_id: orgA.id,
    p_from: new Date(Date.now() - 86400000).toISOString(),
    p_to: new Date(Date.now() + 86400000).toISOString(),
  })
  assert(!error, error?.message)

  const row = data[0]
  assert(row.revenue_minor === 19440, `revenue ${row.revenue_minor}`)
  assert(row.deposits_held_minor === 30000, `deposits ${row.deposits_held_minor}`)
  return 'revenue 194.40, deposits held 300.00 — separate figures'
})

await check('a voided payment stays visible and counts nowhere', async () => {
  const stray = await clientA.rpc('rental_record_payment', {
    p_rental_id: liveRental.id,
    p_amount_minor: 5000,
    p_direction: 'inbound',
    p_purpose: 'rental_charge',
    p_method: 'cash',
  })
  assert(!stray.error, stray.error?.message)

  const overpaid = await clientA
    .from('rentals')
    .select('amount_paid_minor')
    .eq('id', liveRental.id)
    .single()
  assert(overpaid.data.amount_paid_minor === 24440, 'the stray payment was not counted')

  const voided = await clientA.rpc('rental_void_payment', {
    p_payment_id: stray.data.id,
    p_reason: 'Entered twice',
  })
  assert(!voided.error, voided.error?.message)

  const after = await clientA
    .from('rentals')
    .select('amount_paid_minor')
    .eq('id', liveRental.id)
    .single()
  assert(after.data.amount_paid_minor === 19440, `paid ${after.data.amount_paid_minor}`)

  const record = await clientA
    .from('payments')
    .select('id, voided_at, void_reason')
    .eq('id', stray.data.id)
    .single()
  assert(record.data.voided_at, 'the entry disappeared')
  assert(record.data.void_reason === 'Entered twice', 'the reason was lost')
  return 'reversed, not erased'
})

await check('checking out records the hand-over and advances the vehicle', async () => {
  const { data, error } = await clientA.rpc('rental_check_out', {
    p_rental_id: liveRental.id,
    p_odometer: 20500,
    p_fuel_percent: 100,
    p_notes: 'Clean, full tank',
  })
  assert(!error, error?.message)
  assert(data.status === 'active', `status ${data.status}`)

  const vehicle = await clientA
    .from('vehicles')
    .select('odometer')
    .eq('id', rentVehicle.id)
    .single()
  assert(vehicle.data.odometer === 20500, `odometer ${vehicle.data.odometer}`)
  return 'active, vehicle at 20 500 km'
})

await check('an odometer reading below the vehicle mileage is refused', async () => {
  const other = await draftRental(rentVehicle2.id, iso(200), iso(203))
  await clientA.from('rental_drivers').insert({
    organization_id: orgA.id,
    rental_id: other.id,
    customer_id: rentDriver.id,
    driver_role: 'primary',
  })
  await clientA.rpc('rental_confirm', { p_rental_id: other.id })

  const { error } = await clientA.rpc('rental_check_out', {
    p_rental_id: other.id,
    p_odometer: 10,
  })
  assert(error, 'a backwards odometer was accepted')
  assert(/below the vehicle/i.test(error.message), error.message)

  await clientA.rpc('rental_cancel', { p_rental_id: other.id, p_reason: 'smoke test' })
  await clientA.from('rentals').delete().eq('id', other.id)
  return 'refused'
})

await check('an active rental cannot be cancelled', async () => {
  const { error } = await clientA.rpc('rental_cancel', {
    p_rental_id: liveRental.id,
    p_reason: 'should not work',
  })
  assert(error, 'an active rental was cancelled')
  return 'refused — record the return instead'
})

await check('an illegal status change is refused even written directly', async () => {
  const { error } = await clientA
    .from('rentals')
    .update({ status: 'reserved' })
    .eq('id', liveRental.id)
    .select('id')
  assert(error, 'active went back to reserved')
  return 'refused by the database'
})

await check('extending re-checks availability and bills the extra days', async () => {
  const blocker = await draftRental(rentVehicle.id, iso(10), iso(12))
  await clientA.from('rental_drivers').insert({
    organization_id: orgA.id,
    rental_id: blocker.id,
    customer_id: rentDriver.id,
    driver_role: 'primary',
  })
  await clientA.rpc('rental_confirm', { p_rental_id: blocker.id })

  // Into the blocked window — refused, and the original end date survives.
  const refused = await clientA.rpc('rental_extend', {
    p_rental_id: liveRental.id,
    p_new_ends_at: iso(11),
    p_charge_minor: 0,
  })
  assert(refused.error, 'the extension ran over another contract')

  const unchanged = await clientA
    .from('rentals')
    .select('ends_at, extension_count')
    .eq('id', liveRental.id)
    .single()
  assert(unchanged.data.extension_count === 0, 'the refused extension was half-applied')

  await clientA.rpc('rental_cancel', { p_rental_id: blocker.id, p_reason: 'smoke test' })
  await clientA.from('rentals').delete().eq('id', blocker.id)

  // Now into free time, with the extra days charged in the same transaction.
  const extended = await clientA.rpc('rental_extend', {
    p_rental_id: liveRental.id,
    p_new_ends_at: iso(5),
    p_charge_minor: 10000,
    p_charge_description: 'Extension — 2 days',
    p_additional_days: 2,
  })
  assert(!extended.error, extended.error?.message)

  const after = await clientA
    .from('rentals')
    .select('ends_at, extension_count, total_minor, original_ends_at')
    .eq('id', liveRental.id)
    .single()
  assert(after.data.extension_count === 1, `extension_count ${after.data.extension_count}`)
  assert(after.data.original_ends_at, 'the original return date was not kept')
  assert(after.data.total_minor === 31440, `total ${after.data.total_minor}`)
  return 'refused over a clash, charged over free time'
})

await check('issuing a contract freezes the document', async () => {
  const { data, error } = await clientA.rpc('rental_issue_contract', {
    p_rental_id: liveRental.id,
    p_reason: null,
  })
  assert(!error, error?.message)

  const contract = data
  assert(contract.version === 1, `version ${contract.version}`)
  assert(contract.snapshot.agency.name, 'the agency is missing from the snapshot')
  assert(contract.snapshot.vehicle.registration_plate === `RNT1-${STAMP}`, 'wrong plate')
  assert(contract.snapshot.drivers.length === 1, 'drivers missing')
  assert(contract.snapshot.pricing.total_minor === 31440, 'pricing not captured')
  assert(contract.snapshot.handover.pickup_odometer === 20500, 'hand-over not captured')

  // Change the world underneath it.
  await clientA
    .from('vehicles')
    .update({ registration_plate: `CHANGED-${STAMP}` })
    .eq('id', rentVehicle.id)

  const reread = await clientA
    .from('rental_contracts')
    .select('snapshot')
    .eq('id', contract.id)
    .single()
  assert(
    reread.data.snapshot.vehicle.registration_plate === `RNT1-${STAMP}`,
    'the issued contract followed the live record',
  )

  await clientA
    .from('vehicles')
    .update({ registration_plate: `RNT1-${STAMP}` })
    .eq('id', rentVehicle.id)

  liveContract = contract
  return `v1 frozen, ${Object.keys(contract.snapshot).length} sections`
})

await check('an issued snapshot cannot be rewritten', async () => {
  await clientA
    .from('rental_contracts')
    .update({ snapshot: { tampered: true } })
    .eq('id', liveContract.id)

  const { data } = await clientA
    .from('rental_contracts')
    .select('snapshot')
    .eq('id', liveContract.id)
    .single()
  assert(!data.snapshot.tampered, 'the snapshot was overwritten')
  assert(data.snapshot.agency, 'the snapshot was damaged')
  return 'restored by the immutability trigger'
})

await check('amending a contract supersedes the previous version', async () => {
  await clientA.from('rental_line_items').insert({
    organization_id: orgA.id,
    rental_id: liveRental.id,
    kind: 'late_return',
    description: 'Late return',
    amount_minor: 2000,
    currency: 'EUR',
    sort_order: 9,
  })

  const { data, error } = await clientA.rpc('rental_issue_contract', {
    p_rental_id: liveRental.id,
    p_reason: 'Late return charged',
  })
  assert(!error, error?.message)
  assert(data.version === 2, `version ${data.version}`)
  assert(data.contract_number === liveContract.contract_number, 'the number changed')

  const previous = await clientA
    .from('rental_contracts')
    .select('status, supersede_reason')
    .eq('id', liveContract.id)
    .single()
  assert(previous.data.status === 'superseded', previous.data.status)
  assert(previous.data.supersede_reason === 'Late return charged', 'the reason was lost')

  liveContract = data
  return 'v2 issued, v1 superseded, same number'
})

await check('a generated contract PDF is stored privately', async () => {
  // The bytes come from the application's own component, loaded through Vite so
  // this is the same code the browser runs — not a stand-in PDF.
  const { renderToBuffer } = await import('@react-pdf/renderer')
  const { contractElement } = await loadAppModule('/src/features/rentals/contract-pdf.ts')
  const bytes = await renderToBuffer(await contractElement(liveContract.snapshot))

  assert(bytes.subarray(0, 5).toString('latin1') === '%PDF-', 'not a PDF')
  assert(bytes.byteLength > 2000, `only ${bytes.byteLength} bytes`)

  contractPdfPath = `${orgA.id}/${liveRental.id}/contract-v${liveContract.version}-${STAMP}.pdf`
  const upload = await clientA.storage
    .from('rental-documents')
    .upload(contractPdfPath, bytes, { contentType: 'application/pdf' })
  assert(!upload.error, upload.error?.message)

  const metadata = await clientA
    .from('rental_contracts')
    .update({
      pdf_path: contractPdfPath,
      pdf_generated_at: new Date().toISOString(),
      pdf_byte_size: bytes.byteLength,
    })
    .eq('id', liveContract.id)
    .select('pdf_path, pdf_byte_size')
    .single()
  assert(!metadata.error, metadata.error?.message)
  assert(metadata.data.pdf_byte_size === bytes.byteLength, 'size not recorded')

  const anonymous = await fetch(`${URL}/storage/v1/object/rental-documents/${contractPdfPath}`)
  assert(!anonymous.ok, `public fetch succeeded with ${anonymous.status}`)

  const signed = await clientA.storage.from('rental-documents').createSignedUrl(contractPdfPath, 60)
  assert(!signed.error && signed.data.signedUrl, 'no signed URL')
  const fetched = await fetch(signed.data.signedUrl)
  assert(fetched.ok, `signed fetch failed with ${fetched.status}`)
  const roundTrip = Buffer.from(await fetched.arrayBuffer())
  assert(roundTrip.byteLength === bytes.byteLength, 'the file changed in storage')

  return `${Math.round(bytes.byteLength / 1024)} kB, private, signed URL works`
})

await check('agency B cannot reach agency A’s contract or its PDF', async () => {
  const rows = await clientB.from('rental_contracts').select('id').eq('id', liveContract.id)
  assert(rows.data.length === 0, 'B read A’s contract')

  const board = await clientB.from('rental_board').select('id').eq('id', liveRental.id)
  assert(board.data.length === 0, 'B read A’s rental through the board')

  const lines = await clientB.from('rental_line_items').select('id').eq('rental_id', liveRental.id)
  assert(lines.data.length === 0, 'B read A’s charges')

  const signed = await clientB.storage.from('rental-documents').createSignedUrl(contractPdfPath, 60)
  assert(signed.error || !signed.data?.signedUrl, 'B minted a signed URL for A’s contract')

  const write = await clientB.storage
    .from('rental-documents')
    .upload(`${orgA.id}/${liveRental.id}/steal-${STAMP}.pdf`, PDF, {
      contentType: 'application/pdf',
    })
  assert(write.error, 'B wrote into A’s rental prefix')
  return 'refused on every path'
})

await check('agency B cannot drive agency A’s contract through the RPCs', async () => {
  for (const [name, args] of [
    ['rental_cancel', { p_rental_id: liveRental.id, p_reason: 'hijack' }],
    ['rental_complete', { p_rental_id: liveRental.id }],
    ['rental_issue_contract', { p_rental_id: liveRental.id, p_reason: null }],
    [
      'rental_record_payment',
      {
        p_rental_id: liveRental.id,
        p_amount_minor: 100,
        p_direction: 'inbound',
        p_purpose: 'rental_charge',
      },
    ],
  ]) {
    const { error } = await clientB.rpc(name, args)
    assert(error, `${name} succeeded for the wrong agency`)
    assert(/not found/i.test(error.message), `${name}: ${error.message}`)
  }
  return 'all four refused, indistinguishable from missing'
})

await check('completing waits for the return and for the deposit to be settled', async () => {
  const tooEarly = await clientA.rpc('rental_complete', { p_rental_id: liveRental.id })
  assert(tooEarly.error, 'it completed before the vehicle came back')

  const checkIn = await clientA.rpc('rental_check_in', {
    p_rental_id: liveRental.id,
    p_odometer: 21300,
    p_fuel_percent: 60,
    p_notes: 'Small scuff on the rear bumper',
  })
  assert(!checkIn.error, checkIn.error?.message)
  assert(checkIn.data.status === 'active', 'returning closed the contract by itself')

  const depositStillHeld = await clientA.rpc('rental_complete', { p_rental_id: liveRental.id })
  assert(depositStillHeld.error, 'it completed with a deposit outstanding')
  assert(/deposit/i.test(depositStillHeld.error.message), depositStillHeld.error.message)

  const refund = await clientA.rpc('rental_record_payment', {
    p_rental_id: liveRental.id,
    p_amount_minor: 30000,
    p_direction: 'outbound',
    p_purpose: 'deposit',
    p_method: 'card',
  })
  assert(!refund.error, refund.error?.message)

  const done = await clientA.rpc('rental_complete', { p_rental_id: liveRental.id })
  assert(!done.error, done.error?.message)
  assert(done.data.status === 'completed', done.data.status)
  return 'return → deposit returned → completed'
})

await check('the vehicle is back in the fleet the moment the contract closes', async () => {
  const { data } = await clientA
    .from('vehicle_fleet')
    .select('effective_status, odometer')
    .eq('vehicle_id', rentVehicle.id)
    .single()
  assert(data.effective_status === 'available', `status ${data.effective_status}`)
  assert(data.odometer === 21300, `odometer ${data.odometer}`)
  return 'available again, at 21 300 km'
})

await check('the board reports the closed contract correctly', async () => {
  const { data, error } = await clientA
    .from('rental_board')
    .select('*')
    .eq('id', liveRental.id)
    .single()
  assert(!error, error?.message)
  assert(data.status === 'completed', data.status)
  // 282.00 of charges plus 20% tax is 338.40; 194.40 was paid before the
  // extension and the late-return fee were added.
  assert(data.balance_due_minor === 14400, `balance ${data.balance_due_minor}`)
  assert(data.deposit_held_minor === 0, `deposit ${data.deposit_held_minor}`)
  assert(data.renter_is_not_driver === true, 'the renter/driver distinction was lost')
  assert(data.contract_version === 2, `contract version ${data.contract_version}`)
  assert(data.is_overdue === false, 'a completed contract was called overdue')
  return 'completed, 144.00 still owed, driver ≠ renter'
})

await check('the rental teardown removes contracts, charges, payments and files', async () => {
  await clientA.storage.from('rental-documents').remove([contractPdfPath])
  await clientA.from('rentals').delete().eq('id', liveRental.id)

  const contracts = await clientA
    .from('rental_contracts')
    .select('id')
    .eq('rental_id', liveRental.id)
  assert(contracts.data.length === 0, 'contracts survived the rental')

  const lines = await clientA.from('rental_line_items').select('id').eq('rental_id', liveRental.id)
  assert(lines.data.length === 0, 'charges survived the rental')

  await clientA.from('rentals').delete().eq('customer_id', renter.id)
  await clientA.from('customers').delete().in('id', [renter.id, rentDriver.id])
  await clientA.from('vehicles').delete().in('id', [rentVehicle.id, rentVehicle2.id])
  return 'contracts, charges and the PDF removed'
})

// ------------------------------------------------------ calendar / scheduling
let calVehicles = []
let calCustomer, calBoundary, calActive, calCompleted, calDraft, calCancelled

const DAY_MS = 86_400_000
const calAt = (offsetDays, hour = 9) =>
  new Date(Date.UTC(2031, 4, 1 + offsetDays, hour, 0, 0)).toISOString()

/** The window query the board issues, expressed exactly as the client does. */
async function scheduleWindow(from, to, statuses = ['reserved', 'active'], asClient = clientA) {
  const { data, error } = await asClient
    .from('rental_schedule')
    .select('*')
    .eq('organization_id', orgA.id)
    .in('status', statuses)
    .lt('starts_at', to)
    .gt('ends_at', from)
  assert(!error, error?.message)
  return data
}

async function makeRental(vehicleId, startsAt, endsAt, { confirm = true } = {}) {
  const created = await clientA
    .from('rentals')
    .insert({
      organization_id: orgA.id,
      vehicle_id: vehicleId,
      customer_id: calCustomer.id,
      starts_at: startsAt,
      ends_at: endsAt,
      currency: 'EUR',
      daily_rate_minor: 5000,
      billable_days: 2,
    })
    .select('id, reference')
    .single()
  assert(!created.error, created.error?.message)

  await clientA.from('rental_drivers').insert({
    organization_id: orgA.id,
    rental_id: created.data.id,
    customer_id: calCustomer.id,
    driver_role: 'primary',
  })

  if (confirm) {
    const { error } = await clientA.rpc('rental_confirm', { p_rental_id: created.data.id })
    assert(!error, error?.message)
  }
  return created.data
}

await check('calendar fixtures are created', async () => {
  const customer = await clientA
    .from('customers')
    .insert({ organization_id: orgA.id, first_name: 'Salma', last_name: `Berrada ${STAMP}` })
    .select('id')
    .single()
  assert(!customer.error, customer.error?.message)
  calCustomer = customer.data

  for (let index = 0; index < 4; index += 1) {
    const vehicle = await clientA
      .from('vehicles')
      .insert({
        organization_id: orgA.id,
        make: 'Renault',
        model: `Clio ${index + 1}`,
        registration_plate: `CAL${index}-${STAMP}`,
        currency: 'EUR',
        daily_rate_minor: 4500 + index * 500,
        odometer: 10000,
      })
      .select('id, registration_plate')
      .single()
    assert(!vehicle.error, vehicle.error?.message)
    calVehicles.push(vehicle.data)
  }

  return `${calVehicles.length} vehicles, 1 customer`
})

await check('a booking is returned however it straddles the window', async () => {
  // Days 10–20 on the first vehicle. Six windows, one per boundary case.
  calBoundary = await makeRental(calVehicles[0].id, calAt(10), calAt(20))

  const cases = [
    ['wholly inside', calAt(9), calAt(21), true],
    ['starts before, ends inside', calAt(12), calAt(25), true],
    ['starts inside, ends after', calAt(5), calAt(12), true],
    ['covers the whole window', calAt(14), calAt(15), true],
    ['ends exactly as the window opens', calAt(20), calAt(25), false],
    ['starts exactly as the window closes', calAt(1), calAt(10), false],
  ]

  for (const [name, from, to, expected] of cases) {
    const rows = await scheduleWindow(from, to)
    const found = rows.some((row) => row.id === calBoundary.id)
    assert(found === expected, `${name}: expected ${expected}, got ${found}`)
  }

  // One minute of overlap is overlap.
  const sliver = await scheduleWindow(
    new Date(Date.parse(calAt(20)) - 60_000).toISOString(),
    calAt(25),
  )
  assert(
    sliver.some((row) => row.id === calBoundary.id),
    'a one-minute overlap was dropped',
  )

  return '6 boundary cases + a one-minute overlap'
})

await check('drafts and cancellations stay off the operational board', async () => {
  calDraft = await makeRental(calVehicles[1].id, calAt(30), calAt(33), { confirm: false })
  calCancelled = await makeRental(calVehicles[1].id, calAt(40), calAt(43))
  await clientA.rpc('rental_cancel', { p_rental_id: calCancelled.id, p_reason: 'smoke test' })

  const operational = await scheduleWindow(calAt(28), calAt(45))
  assert(!operational.some((row) => row.id === calDraft.id), 'a draft was on the default board')
  assert(
    !operational.some((row) => row.id === calCancelled.id),
    'a cancelled booking was on the default board',
  )

  const withDrafts = await scheduleWindow(calAt(28), calAt(45), ['reserved', 'active', 'draft'])
  assert(
    withDrafts.some((row) => row.id === calDraft.id),
    'the draft filter did not show it',
  )

  const history = await scheduleWindow(calAt(28), calAt(45), ['cancelled'])
  assert(
    history.some((row) => row.id === calCancelled.id),
    'history mode hid the cancellation',
  )

  // And a draft holds nothing: the vehicle is still offered for its dates.
  const free = await clientA.rpc('vehicles_available_between', {
    p_organization_id: orgA.id,
    p_from: calAt(30),
    p_to: calAt(33),
  })
  assert(free.data.includes(calVehicles[1].id), 'a draft blocked its vehicle')

  return 'drafts hold nothing; both reachable behind a filter'
})

await check('an active hire past its return is derived as overdue', async () => {
  const created = await clientA
    .from('rentals')
    .insert({
      organization_id: orgA.id,
      vehicle_id: calVehicles[2].id,
      customer_id: calCustomer.id,
      starts_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
      ends_at: new Date(Date.now() - DAY_MS).toISOString(),
      currency: 'EUR',
      status: 'active',
      picked_up_at: new Date(Date.now() - 5 * DAY_MS).toISOString(),
      pickup_odometer: 10500,
    })
    .select('id')
    .single()
  assert(!created.error, created.error?.message)
  calActive = created.data

  const [row] = await scheduleWindow(
    new Date(Date.now() - 6 * DAY_MS).toISOString(),
    new Date(Date.now() + DAY_MS).toISOString(),
  ).then((rows) => rows.filter((entry) => entry.id === calActive.id))
  assert(row, 'the overdue hire was not on the board')
  assert(row.is_overdue === true, 'it was not derived as overdue')
  assert(row.status === 'active', `status changed to ${row.status}`)

  // The Rentals board must say the same thing about the same contract.
  const board = await clientA
    .from('rental_board')
    .select('is_overdue')
    .eq('id', calActive.id)
    .single()
  assert(board.data.is_overdue === true, 'the two boards disagree about lateness')

  // Recording the return clears it without the status moving.
  await clientA.rpc('rental_check_in', { p_rental_id: calActive.id, p_odometer: 10900 })
  const after = await clientA
    .from('rental_schedule')
    .select('is_overdue, status')
    .eq('id', calActive.id)
    .single()
  assert(after.data.is_overdue === false, 'still overdue after the vehicle came back')
  assert(after.data.status === 'active', 'returning changed the status by itself')

  return 'derived on both boards, cleared by the return'
})

await check('the board names the next commitment and the gap before it', async () => {
  const first = await makeRental(calVehicles[3].id, calAt(60), calAt(62))
  const second = await makeRental(
    calVehicles[3].id,
    new Date(Date.parse(calAt(62)) + 4 * 3_600_000).toISOString(),
    calAt(66),
  )

  const row = await clientA
    .from('rental_schedule')
    .select('next_rental_id, next_rental_reference, turnaround_minutes')
    .eq('id', first.id)
    .single()
  assert(!row.error, row.error?.message)
  assert(row.data.next_rental_id === second.id, 'the next commitment was not found')
  assert(row.data.next_rental_reference === second.reference, 'the reference was wrong')
  assert(row.data.turnaround_minutes === 240, `gap was ${row.data.turnaround_minutes} minutes`)

  return '4 h turnaround reported'
})

await check('the day counts agree with the Rentals domain', async () => {
  const dayStart = new Date(Date.now() - 6 * DAY_MS).toISOString()
  const dayEnd = new Date(Date.now() + 30 * DAY_MS).toISOString()

  const schedule = await scheduleWindow(dayStart, dayEnd, ['active'])
  const board = await clientA
    .from('rental_board')
    .select('id')
    .eq('organization_id', orgA.id)
    .eq('status', 'active')
    .lt('starts_at', dayEnd)
    .gt('ends_at', dayStart)
  assert(!board.error, board.error?.message)

  const scheduleIds = new Set(schedule.map((row) => row.id))
  const boardIds = new Set(board.data.map((row) => row.id))
  assert(
    scheduleIds.size === boardIds.size && [...scheduleIds].every((id) => boardIds.has(id)),
    `schedule ${scheduleIds.size} vs board ${boardIds.size}`,
  )

  return `${scheduleIds.size} active rentals, identical on both`
})

await check('booking from a chosen slot goes through the real availability check', async () => {
  // Exactly what the Calendar hands the rental flow: a vehicle and a period.
  const from = calAt(80)
  const to = calAt(83)

  const offered = await clientA.rpc('vehicles_available_between', {
    p_organization_id: orgA.id,
    p_from: from,
    p_to: to,
  })
  assert(!offered.error, offered.error?.message)
  assert(offered.data.includes(calVehicles[0].id), 'the slot was not offered as free')

  const booked = await makeRental(calVehicles[0].id, from, to)

  const stillOffered = await clientA.rpc('vehicles_available_between', {
    p_organization_id: orgA.id,
    p_from: from,
    p_to: to,
  })
  assert(!stillOffered.data.includes(calVehicles[0].id), 'the vehicle is still offered as free')

  await clientA.rpc('rental_cancel', { p_rental_id: booked.id, p_reason: 'smoke test' })
  return 'offered → booked → no longer offered'
})

await check('rescheduling moves a reservation and recomputes its days', async () => {
  const rental = await makeRental(calVehicles[1].id, calAt(100), calAt(102))

  const moved = await clientA.rpc('rental_reschedule', {
    p_rental_id: rental.id,
    p_starts_at: calAt(104),
    p_ends_at: calAt(109),
  })
  assert(!moved.error, moved.error?.message)
  assert(moved.data.billable_days === 5, `billable_days ${moved.data.billable_days}`)
  assert(new Date(moved.data.starts_at).toISOString() === calAt(104), 'the start did not move')

  await clientA.rpc('rental_cancel', { p_rental_id: rental.id, p_reason: 'smoke test' })
  return '2 days → 5 days'
})

await check('rescheduling onto an occupied slot is refused and changes nothing', async () => {
  const blocker = await makeRental(calVehicles[2].id, calAt(120), calAt(124))
  const mover = await makeRental(calVehicles[1].id, calAt(130), calAt(132))

  const refused = await clientA.rpc('rental_reschedule', {
    p_rental_id: mover.id,
    p_starts_at: calAt(121),
    p_ends_at: calAt(123),
    p_vehicle_id: calVehicles[2].id,
  })
  assert(refused.error, 'the move onto an occupied slot succeeded')
  assert(
    /overlap|conflicting key|already committed/i.test(refused.error.message),
    `refused for the wrong reason: ${refused.error.message}`,
  )

  const unchanged = await clientA
    .from('rentals')
    .select('vehicle_id, starts_at')
    .eq('id', mover.id)
    .single()
  assert(unchanged.data.vehicle_id === calVehicles[1].id, 'the vehicle changed anyway')
  assert(
    new Date(unchanged.data.starts_at).toISOString() === calAt(130),
    'the dates changed anyway',
  )

  await clientA.rpc('rental_cancel', { p_rental_id: blocker.id, p_reason: 'smoke test' })
  await clientA.rpc('rental_cancel', { p_rental_id: mover.id, p_reason: 'smoke test' })
  return 'refused, nothing half-applied'
})

await check('a booking with an issued contract cannot be moved silently', async () => {
  const rental = await makeRental(calVehicles[3].id, calAt(150), calAt(153))
  const contract = await clientA.rpc('rental_issue_contract', {
    p_rental_id: rental.id,
    p_reason: null,
  })
  assert(!contract.error, contract.error?.message)

  const refused = await clientA.rpc('rental_reschedule', {
    p_rental_id: rental.id,
    p_starts_at: calAt(155),
    p_ends_at: calAt(158),
  })
  assert(refused.error, 'a contracted booking was moved without consent')
  assert(/new version/i.test(refused.error.message), refused.error.message)
  assert(refused.error.message.includes(rental.reference), 'the message did not name the contract')

  const consented = await clientA.rpc('rental_reschedule', {
    p_rental_id: rental.id,
    p_starts_at: calAt(155),
    p_ends_at: calAt(158),
    p_amend_contract: true,
  })
  assert(!consented.error, consented.error?.message)

  const versions = await clientA
    .from('rental_contracts')
    .select('version, status, snapshot')
    .eq('rental_id', rental.id)
    .order('version')
  assert(versions.data.length === 2, `${versions.data.length} versions`)
  assert(versions.data[0].status === 'superseded', versions.data[0].status)
  assert(versions.data[1].status === 'issued', versions.data[1].status)

  // The signed original still describes the booking as it was agreed.
  assert(
    new Date(versions.data[0].snapshot.rental.starts_at).toISOString() === calAt(150),
    'the superseded version was rewritten',
  )
  assert(
    new Date(versions.data[1].snapshot.rental.starts_at).toISOString() === calAt(155),
    'the new version does not describe the move',
  )

  await clientA.rpc('rental_cancel', { p_rental_id: rental.id, p_reason: 'smoke test' })
  return 'refused, then amended to v2 with v1 preserved'
})

await check('an active rental cannot be dragged; it is extended or returned', async () => {
  const rental = await makeRental(calVehicles[0].id, calAt(170), calAt(173))
  await clientA.rpc('rental_check_out', { p_rental_id: rental.id, p_odometer: 11000 })

  const refused = await clientA.rpc('rental_reschedule', {
    p_rental_id: rental.id,
    p_starts_at: calAt(171),
    p_ends_at: calAt(176),
  })
  assert(refused.error, 'an active rental was rescheduled')
  assert(/extend or return/i.test(refused.error.message), refused.error.message)

  // The production extension workflow still works on it.
  const extended = await clientA.rpc('rental_extend', {
    p_rental_id: rental.id,
    p_new_ends_at: calAt(176),
    p_charge_minor: 0,
  })
  assert(!extended.error, extended.error?.message)

  await clientA.rpc('rental_check_in', { p_rental_id: rental.id, p_odometer: 11400 })
  await clientA.rpc('rental_complete', { p_rental_id: rental.id })
  return 'reschedule refused, extend accepted'
})

await check('an extension into a booked slot is refused by the same invariant', async () => {
  const runner = await makeRental(calVehicles[1].id, calAt(190), calAt(192))
  await clientA.rpc('rental_check_out', { p_rental_id: runner.id, p_odometer: 12000 })

  const blocker = await makeRental(calVehicles[1].id, calAt(194), calAt(198))

  const refused = await clientA.rpc('rental_extend', {
    p_rental_id: runner.id,
    p_new_ends_at: calAt(196),
    p_charge_minor: 0,
  })
  assert(refused.error, 'the extension ran over another booking')

  const unchanged = await clientA
    .from('rentals')
    .select('ends_at, extension_count')
    .eq('id', runner.id)
    .single()
  assert(unchanged.data.extension_count === 0, 'the refused extension was half-applied')

  await clientA.rpc('rental_cancel', { p_rental_id: blocker.id, p_reason: 'smoke test' })
  await clientA.rpc('rental_check_in', { p_rental_id: runner.id, p_odometer: 12300 })
  await clientA.rpc('rental_complete', { p_rental_id: runner.id })
  return 'refused, original return date intact'
})

await check('two staff rescheduling into the same free slot: exactly one wins', async () => {
  // Real concurrency — two reschedules over separate connections, fired
  // together, both aimed at the same empty slot on the same vehicle.
  const one = await makeRental(calVehicles[2].id, calAt(210), calAt(212))
  const two = await makeRental(calVehicles[3].id, calAt(210), calAt(212))

  const target = { from: calAt(220), to: calAt(224) }

  const [first, second] = await Promise.all([
    clientA.rpc('rental_reschedule', {
      p_rental_id: one.id,
      p_starts_at: target.from,
      p_ends_at: target.to,
      p_vehicle_id: calVehicles[0].id,
    }),
    staffClient.rpc('rental_reschedule', {
      p_rental_id: two.id,
      p_starts_at: target.from,
      p_ends_at: target.to,
      p_vehicle_id: calVehicles[0].id,
    }),
  ])

  const winners = [first, second].filter((result) => !result.error)
  const losers = [first, second].filter((result) => result.error)
  assert(winners.length === 1, `${winners.length} moves succeeded`)
  assert(
    /overlap|conflicting key/i.test(losers[0].error.message),
    `refused for the wrong reason: ${losers[0].error.message}`,
  )

  // And the database holds exactly one booking in that slot.
  const inSlot = await scheduleWindow(target.from, target.to)
  const onTarget = inSlot.filter((row) => row.vehicle_id === calVehicles[0].id)
  assert(onTarget.length === 1, `${onTarget.length} bookings landed in the slot`)

  await clientA.rpc('rental_cancel', { p_rental_id: one.id, p_reason: 'smoke test' })
  await clientA.rpc('rental_cancel', { p_rental_id: two.id, p_reason: 'smoke test' })
  return 'one move applied, one refused, one booking in the slot'
})

await check('a reschedule racing a fresh booking for the same slot', async () => {
  const mover = await makeRental(calVehicles[1].id, calAt(240), calAt(242))

  const fresh = await clientA
    .from('rentals')
    .insert({
      organization_id: orgA.id,
      vehicle_id: calVehicles[2].id,
      customer_id: calCustomer.id,
      starts_at: calAt(250),
      ends_at: calAt(254),
      currency: 'EUR',
    })
    .select('id')
    .single()
  await clientA.from('rental_drivers').insert({
    organization_id: orgA.id,
    rental_id: fresh.data.id,
    customer_id: calCustomer.id,
    driver_role: 'primary',
  })

  const [moved, confirmed] = await Promise.all([
    clientA.rpc('rental_reschedule', {
      p_rental_id: mover.id,
      p_starts_at: calAt(251),
      p_ends_at: calAt(253),
      p_vehicle_id: calVehicles[2].id,
    }),
    staffClient.rpc('rental_confirm', { p_rental_id: fresh.data.id }),
  ])

  const succeeded = [moved, confirmed].filter((result) => !result.error)
  assert(succeeded.length === 1, `${succeeded.length} of the two succeeded`)

  const slot = await scheduleWindow(calAt(250), calAt(254))
  const onVehicle = slot.filter((row) => row.vehicle_id === calVehicles[2].id)
  assert(onVehicle.length === 1, `${onVehicle.length} live bookings in the contested slot`)

  await clientA.from('rentals').delete().eq('id', fresh.data.id)
  await clientA.rpc('rental_cancel', { p_rental_id: mover.id, p_reason: 'smoke test' })
  return 'no inconsistent intermediate state'
})

await check('two substitutions onto the same vehicle: the invariant holds', async () => {
  const one = await makeRental(calVehicles[0].id, calAt(270), calAt(273))
  const two = await makeRental(calVehicles[1].id, calAt(271), calAt(274))

  const [first, second] = await Promise.all([
    clientA.rpc('rental_substitute_vehicle', {
      p_rental_id: one.id,
      p_vehicle_id: calVehicles[3].id,
    }),
    staffClient.rpc('rental_substitute_vehicle', {
      p_rental_id: two.id,
      p_vehicle_id: calVehicles[3].id,
    }),
  ])

  const winners = [first, second].filter((result) => !result.error)
  assert(winners.length === 1, `${winners.length} substitutions succeeded`)

  const onTarget = await scheduleWindow(calAt(270), calAt(275))
  const overlapping = onTarget.filter((row) => row.vehicle_id === calVehicles[3].id)
  assert(overlapping.length === 1, `${overlapping.length} overlapping bookings on one vehicle`)

  await clientA.rpc('rental_cancel', { p_rental_id: one.id, p_reason: 'smoke test' })
  await clientA.rpc('rental_cancel', { p_rental_id: two.id, p_reason: 'smoke test' })
  return 'one substitution applied'
})

await check('agency B sees nothing of agency A on the schedule', async () => {
  const byOrg = await clientB.from('rental_schedule').select('id').eq('organization_id', orgA.id)
  assert(byOrg.data.length === 0, 'B read A’s schedule by organization')

  const byId = await clientB.from('rental_schedule').select('id').eq('id', calBoundary.id)
  assert(byId.data.length === 0, 'B read A’s booking by id')

  const wideOpen = await clientB
    .from('rental_schedule')
    .select('id')
    .lt('starts_at', calAt(400))
    .gt('ends_at', calAt(-400))
  assert(wideOpen.data.length === 0, `B saw ${wideOpen.data.length} of A’s bookings`)

  return 'no rows on any path'
})

await check('agency B cannot infer agency A’s occupied periods', async () => {
  const foreign = await clientB.rpc('vehicles_available_between', {
    p_organization_id: orgA.id,
    p_from: calAt(10),
    p_to: calAt(20),
  })
  assert(foreign.error, 'B queried A’s availability')

  // And its own availability answer never mentions A's fleet.
  const own = await clientB.rpc('vehicles_available_between', {
    p_organization_id: orgB.id,
    p_from: calAt(10),
    p_to: calAt(20),
  })
  assert(!own.error, own.error?.message)
  const leaked = own.data.filter((id) => calVehicles.some((vehicle) => vehicle.id === id))
  assert(leaked.length === 0, 'A’s vehicles appeared in B’s availability')

  return 'refused, and no leakage in its own answer'
})

await check('agency B cannot reschedule or move agency A’s booking', async () => {
  const foreign = await clientB.rpc('rental_reschedule', {
    p_rental_id: calBoundary.id,
    p_starts_at: calAt(300),
    p_ends_at: calAt(303),
  })
  const missing = await clientB.rpc('rental_reschedule', {
    p_rental_id: '00000000-0000-0000-0000-000000000000',
    p_starts_at: calAt(300),
    p_ends_at: calAt(303),
  })
  assert(foreign.error && missing.error, 'one of the calls succeeded')
  assert(
    foreign.error.message === missing.error.message,
    `messages differ: "${foreign.error.message}" vs "${missing.error.message}"`,
  )

  const untouched = await clientA
    .from('rentals')
    .select('starts_at')
    .eq('id', calBoundary.id)
    .single()
  assert(new Date(untouched.data.starts_at).toISOString() === calAt(10), 'B moved A’s booking')

  return 'identical errors, nothing moved'
})

await check('agency A cannot move a booking onto agency B’s vehicle', async () => {
  const rivalVehicle = await clientB
    .from('vehicles')
    .insert({
      organization_id: orgB.id,
      make: 'Opel',
      model: 'Corsa',
      registration_plate: `RIVAL-${STAMP}`,
      currency: 'EUR',
    })
    .select('id')
    .single()
  assert(!rivalVehicle.error, rivalVehicle.error?.message)

  const refused = await clientA.rpc('rental_reschedule', {
    p_rental_id: calBoundary.id,
    p_starts_at: calAt(10),
    p_ends_at: calAt(20),
    p_vehicle_id: rivalVehicle.data.id,
  })
  assert(refused.error, 'A moved a booking onto B’s vehicle')
  assert(/vehicle not found/i.test(refused.error.message), refused.error.message)

  await clientB.from('vehicles').delete().eq('id', rivalVehicle.data.id)
  return 'refused'
})

await check('the anonymous role has no calendar access at all', async () => {
  const anon = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } })

  const view = await anon.from('rental_schedule').select('id').limit(1)
  assert(view.error || (view.data ?? []).length === 0, 'anon read the schedule')

  const move = await anon.rpc('rental_reschedule', {
    p_rental_id: calBoundary.id,
    p_starts_at: calAt(300),
    p_ends_at: calAt(303),
  })
  assert(move.error, 'anon rescheduled a booking')

  const overdue = await anon.rpc('rental_is_overdue', {
    p_status: 'active',
    p_ends_at: calAt(0),
    p_returned_at: null,
  })
  assert(overdue.error, 'anon called the overdue function')

  return 'refused on the view and both functions'
})

await check('the scheduling read model is security_invoker and unreachable by anon', async () => {
  const out = sql(`
    select
      (select c.reloptions::text from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'rental_schedule') as options,
      (select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE')) as anon_functions,
      (select count(*) from information_schema.role_table_grants
        where grantee = 'anon' and table_name in ('rental_schedule')) as anon_grants;
  `)
  const row = (out.result ?? out.rows ?? [])[0]
  assert(/security_invoker=(true|on)/.test(row.options ?? ''), `reloptions: ${row.options}`)
  assert(Number(row.anon_functions) === 0, `anon can execute ${row.anon_functions} functions`)
  assert(Number(row.anon_grants) === 0, `anon holds ${row.anon_grants} grants on the view`)
  return 'invoker rights, no anon grants'
})

await check('the window query uses the range index on a realistic fleet', async () => {
  // Measured rather than assumed: 120 vehicles and 720 bookings, seeded and
  // removed inside this check.
  sql(`
    insert into public.vehicles (organization_id, make, model, registration_plate, currency, daily_rate_minor)
    select '${orgA.id}', 'Perf', 'Model ' || g, 'PERF${STAMP}-' || g, 'EUR', 4000
    from generate_series(1, 120) g;

    insert into public.rentals
      (organization_id, vehicle_id, customer_id, reference, starts_at, ends_at, currency, status, daily_rate_minor)
    select
      '${orgA.id}', v.id, '${calCustomer.id}',
      'PERF${STAMP}-' || v.n || '-' || s,
      now() + ((s * 9 + v.n) || ' days')::interval,
      now() + ((s * 9 + v.n + 3) || ' days')::interval,
      'EUR', 'reserved', 4000
    from (select id, row_number() over () as n from public.vehicles
           where organization_id = '${orgA.id}' and registration_plate like 'PERF${STAMP}-%') v
    cross join generate_series(0, 5) s;
  `)

  sql(`analyze public.rentals;`)

  const plan = sql(`
    explain (analyze, format json)
    select * from public.rentals
     where organization_id = '${orgA.id}'
       and tstzrange(starts_at, ends_at, '[)') && tstzrange(now(), now() + interval '14 days', '[)')
       and status in ('reserved','active');
  `)
  const text = JSON.stringify((plan.result ?? plan.rows ?? [])[0])
  const indexName = /"Index Name":"([^"]+)"/.exec(text)?.[1] ?? 'none'
  const executionMs = Number(/"Execution Time":\s*([0-9.]+)/.exec(text)?.[1] ?? '0')

  const counts = sql(
    `select count(*) as rentals from public.rentals where organization_id = '${orgA.id}'`,
  )
  const total = Number((counts.result ?? counts.rows ?? [])[0].rentals)

  sql(`
    delete from public.rentals where reference like 'PERF${STAMP}-%';
    delete from public.vehicles where registration_plate like 'PERF${STAMP}-%';
  `)

  // What matters is that the window is answered from an index rather than by
  // reading the table. Which index the planner picks is its business: below a
  // few thousand rows the exclusion constraint's own GiST index is the cheaper
  // choice, and above that it switches to the range index added for this. Both
  // were measured against a seeded 24 000-rental, two-agency fleet — 0.72 ms
  // with the range index against 3.98 ms without it.
  assert(indexName !== 'none', `the window was answered by a table scan:\n${text.slice(0, 400)}`)
  assert(executionMs < 50, `the windowed query took ${executionMs} ms`)
  return `${total} rentals, ${indexName}, ${executionMs.toFixed(2)} ms`
})

await check('calendar teardown removes every scheduling fixture', async () => {
  const removed = await clientA
    .from('rentals')
    .delete()
    .eq('customer_id', calCustomer.id)
    .select('id')
  assert(!removed.error, `deleting the bookings failed: ${removed.error?.message}`)

  const survivors = await clientA
    .from('rental_schedule')
    .select('id, reference, status')
    .eq('organization_id', orgA.id)
  assert(
    survivors.data.length === 0,
    `${survivors.data.length} bookings survived: ${survivors.data
      .slice(0, 5)
      .map((row) => `${row.reference}/${row.status}`)
      .join(', ')}`,
  )

  const customer = await clientA.from('customers').delete().eq('id', calCustomer.id).select('id')
  assert(!customer.error, `deleting the customer failed: ${customer.error?.message}`)

  const vehicles = await clientA
    .from('vehicles')
    .delete()
    .in(
      'id',
      calVehicles.map((vehicle) => vehicle.id),
    )
    .select('id')
  assert(!vehicles.error, `deleting the vehicles failed: ${vehicles.error?.message}`)

  return `${removed.data.length} bookings, 1 customer, ${vehicles.data.length} vehicles removed`
})

// ---------------------------------------------------------- expenses / costs
//
// The whole point of this section is the arithmetic nobody notices going wrong:
// a cost attributed to two places at once, a voided figure that keeps counting,
// a business date read from created_at, and two currencies quietly added.

let expVehicle, expVehicle2, expCustomer, expRental, expCategories
let expOverhead, expVehicleCost, expRentalCost, expVendor, expReceiptPath
let expFinancingPlan

const today = new Date()
const isoDay = (offsetDays = 0) => {
  const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}
/** First day of the month containing `iso`, and the first day of the next. */
const monthWindow = (iso) => {
  const [year, month] = iso.split('-').map(Number)
  const from = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return {
    from,
    to: `${String(nextYear).padStart(4, '0')}-${String(nextMonth).padStart(2, '0')}-01`,
  }
}

const category = (key) => {
  const found = expCategories.find((row) => row.system_key === key)
  assert(found, `no seeded category for ${key}`)
  return found.id
}

async function summaryFor(from, to, asClient = clientA, organizationId = orgA.id) {
  const { data, error } = await asClient.rpc('organization_expense_summary', {
    p_organization_id: organizationId,
    p_from: from,
    p_to: to,
  })
  assert(!error, `summary failed: ${error?.message}`)
  return data ?? []
}

async function overviewFor(from, to) {
  const { data, error } = await clientA.rpc('organization_overview', {
    p_organization_id: orgA.id,
    p_from: `${from}T00:00:00Z`,
    p_to: `${to}T00:00:00Z`,
  })
  assert(!error, `overview failed: ${error?.message}`)
  return data?.[0]
}

await check('a new agency starts with a full set of categories and no financing one', async () => {
  const { data, error } = await clientA
    .from('expense_categories')
    .select('*')
    .eq('organization_id', orgA.id)
  assert(!error, error?.message)
  expCategories = data
  assert(data.length >= 15, `only ${data.length} categories were seeded`)
  assert(
    data.every((row) => row.is_system),
    'a seeded category was not marked as a system category',
  )

  // The Financing boundary, asserted rather than assumed: there is no category
  // for a loan or a lease, so a principal repayment cannot be filed as an
  // operating cost and counted twice when Financing arrives.
  const financing = data.filter((row) =>
    /loan|lease|financ|instal|principal/i.test(`${row.system_key} ${row.name}`),
  )
  assert(
    financing.length === 0,
    `financing-shaped categories exist: ${financing.map((c) => c.name)}`,
  )
  return `${data.length} categories, none financing`
})

await check('cost fixtures are created', async () => {
  const first = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Toyota',
      model: 'Yaris',
      registration_plate: `EXP1-${STAMP}`,
      currency: 'EUR',
      daily_rate_minor: 4500,
      odometer: 30000,
    })
    .select('id')
    .single()
  assert(!first.error, first.error?.message)
  expVehicle = first.data

  const second = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Fiat',
      model: 'Panda',
      registration_plate: `EXP2-${STAMP}`,
      currency: 'EUR',
      daily_rate_minor: 3500,
      odometer: 12000,
    })
    .select('id')
    .single()
  assert(!second.error, second.error?.message)
  expVehicle2 = second.data

  const person = await clientA
    .from('customers')
    .insert({ organization_id: orgA.id, first_name: 'Nadia', last_name: `Benali ${STAMP}` })
    .select('id')
    .single()
  assert(!person.error, person.error?.message)
  expCustomer = person.data

  const rental = await clientA
    .from('rentals')
    .insert({
      organization_id: orgA.id,
      vehicle_id: expVehicle.id,
      customer_id: expCustomer.id,
      starts_at: `${isoDay(-10)}T09:00:00Z`,
      ends_at: `${isoDay(-7)}T09:00:00Z`,
      currency: 'EUR',
      daily_rate_minor: 4500,
    })
    .select('id, reference')
    .single()
  assert(!rental.error, rental.error?.message)
  expRental = rental.data

  return `2 vehicles, 1 customer, ${expRental.reference}`
})

await check('an agency overhead is recorded against nothing in particular', async () => {
  const { data, error } = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-3),
      description: `Office rent ${STAMP}`,
      amount_minor: 600000,
      tax_amount_minor: 100000,
      tax_rate_bps: 2000,
      tax_label: 'VAT',
      currency: 'EUR',
      category_id: category('office'),
      allocation: 'overhead',
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  expOverhead = data
  assert(data.vehicle_id === null && data.rental_id === null, 'an overhead pointed at something')
  assert(data.status === 'recorded', `status was ${data.status}`)
  assert(data.source === 'manual', `source was ${data.source}`)
  return `${data.amount_minor} minor, ${data.allocation}`
})

await check('a vehicle cost names its car', async () => {
  const { data, error } = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-2),
      description: `Front brake pads ${STAMP}`,
      amount_minor: 184000,
      tax_amount_minor: 30667,
      currency: 'EUR',
      category_id: category('repair'),
      allocation: 'vehicle',
      vehicle_id: expVehicle.id,
      odometer: 30500,
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  expVehicleCost = data
  assert(data.rental_id === null, 'a vehicle cost carried a rental')
  return `${data.amount_minor} minor on ${expVehicle.id.slice(0, 8)}…`
})

await check('a rental cost carries no vehicle of its own', async () => {
  const { data, error } = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-8),
      description: `Delivery to the airport ${STAMP}`,
      amount_minor: 25000,
      currency: 'EUR',
      category_id: category('delivery'),
      allocation: 'rental',
      rental_id: expRental.id,
    })
    .select('*')
    .single()
  assert(!error, error?.message)
  expRentalCost = data
  // The car is whichever one the contract is for. Duplicating it would create
  // two answers to one question and let them disagree.
  assert(data.vehicle_id === null, 'a rental cost stored its own vehicle')
  return `${data.amount_minor} minor via ${expRental.reference}`
})

await check('the database refuses a cost that belongs to two places at once', async () => {
  const both = await clientA.from('expenses').insert({
    organization_id: orgA.id,
    incurred_on: isoDay(-1),
    description: 'Contradiction',
    amount_minor: 1000,
    currency: 'EUR',
    category_id: category('repair'),
    allocation: 'rental',
    rental_id: expRental.id,
    vehicle_id: expVehicle.id,
  })
  assert(both.error, 'a rental cost with its own vehicle was accepted')

  const overheadWithCar = await clientA.from('expenses').insert({
    organization_id: orgA.id,
    incurred_on: isoDay(-1),
    description: 'Contradiction',
    amount_minor: 1000,
    currency: 'EUR',
    category_id: category('office'),
    allocation: 'overhead',
    vehicle_id: expVehicle.id,
  })
  assert(overheadWithCar.error, 'an overhead with a vehicle was accepted')

  const vehicleWithout = await clientA.from('expenses').insert({
    organization_id: orgA.id,
    incurred_on: isoDay(-1),
    description: 'Contradiction',
    amount_minor: 1000,
    currency: 'EUR',
    category_id: category('repair'),
    allocation: 'vehicle',
  })
  assert(vehicleWithout.error, 'a vehicle cost with no vehicle was accepted')

  return '3 contradictions refused'
})

await check('a cost cannot reference another agency’s vehicle', async () => {
  // A real, live vehicle in agency B — not a made-up id, which would fail for
  // the wrong reason and prove nothing about tenancy.
  const theirs = await clientB
    .from('vehicles')
    .insert({
      organization_id: orgB.id,
      make: 'Kia',
      model: 'Picanto',
      registration_plate: `EXPB-${STAMP}`,
      currency: 'EUR',
      daily_rate_minor: 3000,
    })
    .select('id')
    .single()
  assert(!theirs.error, theirs.error?.message)

  const { error } = await clientA.from('expenses').insert({
    organization_id: orgA.id,
    incurred_on: isoDay(-1),
    description: 'Cross-tenant',
    amount_minor: 1000,
    currency: 'EUR',
    category_id: category('repair'),
    allocation: 'vehicle',
    vehicle_id: theirs.data.id,
  })
  assert(error, 'a cost referenced a vehicle in another agency')

  await clientB.from('vehicles').delete().eq('id', theirs.data.id)
  return error.code
})

await check('tax larger than the amount that contains it is refused', async () => {
  const { error } = await clientA.from('expenses').insert({
    organization_id: orgA.id,
    incurred_on: isoDay(-1),
    description: 'Impossible tax',
    amount_minor: 10000,
    tax_amount_minor: 12000,
    currency: 'EUR',
    category_id: category('office'),
    allocation: 'overhead',
  })
  assert(error, 'tax exceeding the gross amount was accepted')
  return error.code
})

await check('a cost of nothing is refused', async () => {
  const { error } = await clientA.from('expenses').insert({
    organization_id: orgA.id,
    incurred_on: isoDay(-1),
    description: 'Nothing',
    amount_minor: 0,
    currency: 'EUR',
    category_id: category('office'),
    allocation: 'overhead',
  })
  assert(error, 'a zero-amount cost was accepted')
  return error.code
})

await check('the ledger reads a rental cost’s vehicle through the contract', async () => {
  const { data, error } = await clientA
    .from('expense_ledger')
    .select('*')
    .eq('id', expRentalCost.id)
    .single()
  assert(!error, error?.message)
  assert(data.effective_vehicle_id === expVehicle.id, 'the vehicle was not derived from the hire')
  assert(data.rental_reference === expRental.reference, 'the contract reference was not resolved')
  assert(data.net_amount_minor === data.amount_minor - data.tax_amount_minor, 'net is wrong')
  assert(data.category_name?.length > 0, 'the category was not resolved')
  return `${data.rental_reference} → ${data.vehicle_plate}`
})

await check('the period summary splits by allocation, one row per currency', async () => {
  const window = monthWindow(isoDay(-2))
  const rows = await summaryFor(window.from, window.to)
  const eur = rows.find((row) => row.currency === 'EUR')
  assert(eur, 'no EUR row in the summary')
  assert(eur.overhead_minor >= 600000, `overhead was ${eur.overhead_minor}`)
  assert(eur.vehicle_minor >= 184000, `vehicle was ${eur.vehicle_minor}`)
  assert(
    eur.total_minor === eur.overhead_minor + eur.vehicle_minor + eur.rental_minor,
    'the parts do not add up to the total',
  )
  return `EUR ${eur.total_minor} over ${eur.expense_count} costs`
})

await check('two currencies are reported separately and never added', async () => {
  const inserted = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-2),
      description: `Roaming data ${STAMP}`,
      amount_minor: 4500,
      currency: 'MAD',
      category_id: category('software'),
      allocation: 'overhead',
    })
    .select('id')
    .single()
  assert(!inserted.error, inserted.error?.message)

  const window = monthWindow(isoDay(-2))
  const rows = await summaryFor(window.from, window.to)
  assert(rows.length >= 2, `expected at least two currency rows, got ${rows.length}`)
  const mad = rows.find((row) => row.currency === 'MAD')
  const eur = rows.find((row) => row.currency === 'EUR')
  assert(mad && eur, 'both currencies should be present')
  assert(mad.total_minor === 4500, `MAD total was ${mad.total_minor}`)
  assert(eur.total_minor !== mad.total_minor + eur.total_minor, 'currencies were combined')

  await clientA.from('expenses').delete().eq('id', inserted.data.id)
  return `${rows.length} currency rows, kept apart`
})

await check('the business date drives the period, not the day it was typed in', async () => {
  // Dated inside last month but created now. If any report read created_at this
  // would land in the wrong month, which is the classic silent accounting bug.
  const lastMonth = isoDay(-40)
  const backdated = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: lastMonth,
      description: `Backdated insurance ${STAMP}`,
      amount_minor: 90000,
      currency: 'EUR',
      category_id: category('insurance'),
      allocation: 'overhead',
    })
    .select('id, created_at, incurred_on')
    .single()
  assert(!backdated.error, backdated.error?.message)
  assert(
    backdated.data.created_at.slice(0, 10) !== backdated.data.incurred_on,
    'the fixture did not actually separate the two dates',
  )

  const past = monthWindow(lastMonth)
  const current = monthWindow(isoDay(0))
  const pastRows = await summaryFor(past.from, past.to)
  const currentRows = await summaryFor(current.from, current.to)

  const inPast = (pastRows.find((row) => row.currency === 'EUR')?.total_minor ?? 0) >= 90000
  const currentTotal = currentRows.find((row) => row.currency === 'EUR')?.total_minor ?? 0

  assert(inPast, 'the backdated cost did not land in the month it was incurred')
  assert(
    past.from !== current.from ? true : currentTotal >= 90000,
    'period windows overlapped, making the check meaningless',
  )

  await clientA.from('expenses').delete().eq('id', backdated.data.id)
  return `dated ${lastMonth}, reported in ${past.from.slice(0, 7)}`
})

await check('the category breakdown adds up inside one currency', async () => {
  const window = monthWindow(isoDay(-2))
  const { data, error } = await clientA.rpc('expense_category_breakdown', {
    p_organization_id: orgA.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(!error, error?.message)
  const eur = data.filter((row) => row.currency === 'EUR')
  const summed = eur.reduce((total, row) => total + row.total_minor, 0)
  const summary = (await summaryFor(window.from, window.to)).find((row) => row.currency === 'EUR')
  assert(summed === summary.total_minor, `breakdown ${summed} vs summary ${summary.total_minor}`)
  return `${eur.length} categories summing to ${summed}`
})

await check('recording a cost lowers the operating result by exactly that much', async () => {
  const window = monthWindow(isoDay(-2))
  const before = await overviewFor(window.from, window.to)

  const added = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-2),
      description: `Sign-writing ${STAMP}`,
      amount_minor: 9900,
      currency: 'EUR',
      category_id: category('marketing'),
      allocation: 'overhead',
    })
    .select('id')
    .single()
  assert(!added.error, added.error?.message)

  const after = await overviewFor(window.from, window.to)
  assert(
    after.expenses_minor === before.expenses_minor + 9900,
    `expenses moved by ${after.expenses_minor - before.expenses_minor}`,
  )
  assert(
    after.profit_minor === before.profit_minor - 9900,
    `the operating result moved by ${after.profit_minor - before.profit_minor}, expected -9900`,
  )
  assert(after.revenue_minor === before.revenue_minor, 'revenue moved when a cost was recorded')
  assert(
    after.deposits_held_minor === before.deposits_held_minor,
    'deposits moved when a cost was recorded',
  )

  // ... and voiding puts it back, to the cent.
  const voided = await clientA.rpc('expense_void', {
    p_expense_id: added.data.id,
    p_reason: 'Smoke test correction',
  })
  assert(!voided.error, voided.error?.message)

  const restored = await overviewFor(window.from, window.to)
  assert(
    restored.profit_minor === before.profit_minor,
    `voiding left the operating result at ${restored.profit_minor}, expected ${before.profit_minor}`,
  )
  assert(
    restored.profit_minor - after.profit_minor === 9900,
    'voiding did not raise the operating result by the amount voided',
  )
  assert(restored.expenses_minor === before.expenses_minor, 'the voided cost still counted')
  return `−9900 then +9900, revenue and deposits unmoved`
})

await check('a voided cost is frozen, cannot be reinstated and cannot be deleted', async () => {
  const target = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-2),
      description: `Duplicate entry ${STAMP}`,
      amount_minor: 5000,
      currency: 'EUR',
      category_id: category('office'),
      allocation: 'overhead',
    })
    .select('id')
    .single()
  assert(!target.error, target.error?.message)

  const voided = await clientA.rpc('expense_void', {
    p_expense_id: target.data.id,
    p_reason: 'Entered twice',
  })
  assert(!voided.error, voided.error?.message)

  const edit = await clientA
    .from('expenses')
    .update({ amount_minor: 1 })
    .eq('id', target.data.id)
    .select('id')
  assert(edit.error || edit.data.length === 0, 'a voided cost was edited')

  const reinstate = await clientA
    .from('expenses')
    .update({ status: 'recorded' })
    .eq('id', target.data.id)
    .select('id')
  assert(reinstate.error || reinstate.data.length === 0, 'a voided cost was reinstated')

  const removed = await clientA.from('expenses').delete().eq('id', target.data.id).select('id')
  assert(removed.error || removed.data.length === 0, 'a voided cost was deleted')

  const survivor = await clientA
    .from('expense_ledger')
    .select('status, void_reason, amount_minor')
    .eq('id', target.data.id)
    .single()
  assert(survivor.data.status === 'voided', 'the record did not survive as voided')
  assert(survivor.data.amount_minor === 5000, 'the voided figure was altered')
  assert(survivor.data.void_reason === 'Entered twice', 'the reason was lost')
  return 'frozen, kept, reason intact'
})

await check('a correction preserves the figure it replaced', async () => {
  const subject = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-2),
      description: `Mistyped amount ${STAMP}`,
      amount_minor: 120000,
      currency: 'EUR',
      category_id: category('fuel'),
      allocation: 'vehicle',
      vehicle_id: expVehicle2.id,
    })
    .select('id')
    .single()
  assert(!subject.error, subject.error?.message)

  const corrected = await clientA
    .from('expenses')
    .update({ amount_minor: 12000 })
    .eq('id', subject.data.id)
    .select('amount_minor')
    .single()
  assert(!corrected.error, corrected.error?.message)

  const { data, error } = await clientA
    .from('expense_change_events')
    .select('*')
    .eq('expense_id', subject.data.id)
    .order('changed_at', { ascending: false })
  assert(!error, error?.message)
  assert(data.length === 1, `expected one change event, got ${data.length}`)

  const event = data[0]
  assert(event.kind === 'correction', `kind was ${event.kind}`)
  assert(event.changes.amount_minor?.from === 120000, 'the previous amount was not preserved')
  assert(event.changes.amount_minor?.to === 12000, 'the new amount was not recorded')
  assert(event.changed_by !== null, 'nobody was recorded as having made the change')

  // A void is a different kind of event, not another correction.
  await clientA.rpc('expense_void', { p_expense_id: subject.data.id, p_reason: 'Void after fix' })
  const after = await clientA
    .from('expense_change_events')
    .select('kind, reason')
    .eq('expense_id', subject.data.id)
    .order('changed_at', { ascending: false })
  assert(after.data.length === 2, `expected two events, got ${after.data.length}`)
  assert(
    after.data.some((row) => row.kind === 'void') &&
      after.data.some((row) => row.kind === 'correction'),
    'a void and a correction were not distinguishable',
  )
  return '120000 → 12000, then voided'
})

await check(
  'the change history cannot be written, edited or erased by the application',
  async () => {
    const insert = await clientA.from('expense_change_events').insert({
      organization_id: orgA.id,
      expense_id: expOverhead.id,
      kind: 'correction',
      changes: { amount_minor: { from: 1, to: 2 } },
    })
    assert(insert.error, 'the application wrote a change event')

    const update = await clientA
      .from('expense_change_events')
      .update({ reason: 'rewritten' })
      .eq('expense_id', expOverhead.id)
      .select('id')
    assert(update.error || update.data.length === 0, 'the application edited a change event')

    const remove = await clientA
      .from('expense_change_events')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000')
      .select('id')
    assert(remove.error || remove.data.length === 0, 'the application erased change events')
    return 'insert, update and delete all refused'
  },
)

await check('a vehicle’s operating contribution counts its direct costs once', async () => {
  const window = monthWindow(isoDay(-2))
  const { data, error } = await clientA.rpc('vehicle_operating_summary', {
    p_vehicle_id: expVehicle.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(!error, error?.message)
  const eur = data.find((row) => row.currency === 'EUR')
  assert(eur, 'no EUR row for the vehicle')
  assert(eur.vehicle_expense_minor === 184000, `vehicle costs were ${eur.vehicle_expense_minor}`)
  assert(
    eur.direct_expense_minor === eur.vehicle_expense_minor + eur.rental_expense_minor,
    'the direct total does not equal its two parts',
  )
  assert(
    eur.operating_contribution_minor === eur.rental_revenue_minor - eur.direct_expense_minor,
    'the contribution is not revenue less direct costs',
  )
  return `contribution ${eur.operating_contribution_minor} on ${eur.expense_count} costs`
})

await check('agency overhead never lands on a vehicle', async () => {
  const window = monthWindow(isoDay(-2))
  const { data } = await clientA.rpc('vehicle_operating_summary', {
    p_vehicle_id: expVehicle2.id,
    p_from: window.from,
    p_to: window.to,
  })
  const eur = data.find((row) => row.currency === 'EUR')
  // Only the fuel cost recorded against this car; the 600000 office rent is
  // nowhere near it.
  const direct = eur?.direct_expense_minor ?? 0
  assert(direct < 600000, `office rent reached a vehicle: ${direct}`)
  return `direct costs ${direct}, overhead excluded`
})

await check('a financing cost is excluded from a vehicle’s operating figures', async () => {
  const plan = await clientA
    .from('financing_agreements')
    .insert({
      organization_id: orgA.id,
      vehicle_id: expVehicle.id,
      agreement_type: 'loan',
      lender_id: (
        await clientA
          .from('lenders')
          .insert({ organization_id: orgA.id, name: `Smoke Bank ${STAMP}` })
          .select('id')
          .single()
      ).data.id,
      currency: 'EUR',
      mode: 'simple',
      financed_amount_minor: 15000000,
      installment_amount_minor: 250000,
      installments_count: 60,
      first_payment_on: isoDay(-400),
      schedule_anchor_day: Number(isoDay(-400).slice(8, 10)),
      starts_on: isoDay(-400),
    })
    .select('id')
    .single()
  assert(!plan.error, `creating a financing plan failed: ${plan.error?.message}`)
  expFinancingPlan = plan.data

  const window = monthWindow(isoDay(-2))
  const before = await clientA.rpc('vehicle_operating_summary', {
    p_vehicle_id: expVehicle.id,
    p_from: window.from,
    p_to: window.to,
  })
  const contributionBefore =
    before.data.find((row) => row.currency === 'EUR')?.operating_contribution_minor ?? 0

  const installment = await clientA
    .from('expenses')
    .insert({
      organization_id: orgA.id,
      incurred_on: isoDay(-2),
      description: `Loan instalment ${STAMP}`,
      amount_minor: 250000,
      currency: 'EUR',
      category_id: category('other'),
      allocation: 'vehicle',
      vehicle_id: expVehicle.id,
      source: 'financing',
      financing_plan_id: plan.data.id,
    })
    .select('id, source, financing_plan_id')
    .single()
  assert(!installment.error, installment.error?.message)

  const after = await clientA.rpc('vehicle_operating_summary', {
    p_vehicle_id: expVehicle.id,
    p_from: window.from,
    p_to: window.to,
  })
  const contributionAfter =
    after.data.find((row) => row.currency === 'EUR')?.operating_contribution_minor ?? 0

  assert(
    contributionAfter === contributionBefore,
    `a financed instalment moved the operating contribution by ${contributionAfter - contributionBefore}`,
  )

  await clientA.from('expenses').delete().eq('id', installment.data.id)
  await clientA.from('financing_agreements').delete().eq('id', plan.data.id)
  expFinancingPlan = null
  return 'principal excluded by construction'
})

await check('a contract reports what it cost the agency', async () => {
  const { data, error } = await clientA.rpc('rental_expense_summary', {
    p_rental_id: expRental.id,
  })
  assert(!error, error?.message)
  const eur = data.find((row) => row.currency === 'EUR')
  assert(eur?.total_minor === 25000, `rental costs were ${eur?.total_minor}`)
  return `${eur.total_minor} minor over ${eur.expense_count} costs`
})

// -------------------------------------------------------------- suppliers
await check('two suppliers may share a name, because a name identifies nothing', async () => {
  const first = await clientA
    .from('expense_vendors')
    .insert({
      organization_id: orgA.id,
      name: `Garage Atlas ${STAMP}`,
      tax_identifier: `TAX-A-${STAMP}`,
    })
    .select('*')
    .single()
  assert(!first.error, first.error?.message)
  expVendor = first.data

  const twin = await clientA
    .from('expense_vendors')
    .insert({
      organization_id: orgA.id,
      name: `Garage Atlas ${STAMP}`,
      tax_identifier: `TAX-B-${STAMP}`,
    })
    .select('id')
    .single()
  assert(!twin.error, `two suppliers could not share a name: ${twin.error?.message}`)

  await clientA.from('expense_vendors').delete().eq('id', twin.data.id)
  return 'accepted, as two real companies may be'
})

await check('two suppliers may not share a tax identifier', async () => {
  const { error } = await clientA
    .from('expense_vendors')
    .insert({
      organization_id: orgA.id,
      name: `Different name ${STAMP}`,
      tax_identifier: `TAX-A-${STAMP}`,
    })
    .select('id')
  assert(error, 'two suppliers shared a tax identifier')
  return error.code
})

await check('a retired supplier is offered for restoring rather than duplicated', async () => {
  const retired = await clientA
    .from('expense_vendors')
    .insert({
      organization_id: orgA.id,
      name: `Pneus Casa ${STAMP}`,
      archived_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  assert(!retired.error, retired.error?.message)

  const { data, error } = await clientA.rpc('find_duplicate_vendors', {
    p_organization_id: orgA.id,
    p_name: `Pneus Casa ${STAMP}`,
    p_tax_identifier: null,
    p_exclude_vendor_id: null,
  })
  assert(!error, error?.message)
  const hit = data.find((row) => row.vendor_id === retired.data.id)
  assert(hit, 'the retired supplier was not surfaced')
  assert(hit.archived_at !== null, 'the supplier was not reported as retired')
  assert(/retired/i.test(hit.match_reason), `the reason was "${hit.match_reason}"`)

  await clientA.from('expense_vendors').delete().eq('id', retired.data.id)
  return hit.match_reason
})

await check('a tax identifier is a stronger duplicate signal than a name', async () => {
  const { data, error } = await clientA.rpc('find_duplicate_vendors', {
    p_organization_id: orgA.id,
    p_name: 'Something else entirely',
    p_tax_identifier: `TAX-A-${STAMP}`,
    p_exclude_vendor_id: null,
  })
  assert(!error, error?.message)
  const hit = data.find((row) => row.vendor_id === expVendor.id)
  assert(hit, 'the supplier with that tax identifier was not found')
  assert(hit.match_strength === 'strong', `strength was ${hit.match_strength}`)
  return `${hit.match_strength} on the identifier alone`
})

await check(
  'a cost that looks like one already recorded is warned about, never merged',
  async () => {
    const original = await clientA
      .from('expenses')
      .insert({
        organization_id: orgA.id,
        incurred_on: isoDay(-2),
        description: `Tyres ${STAMP}`,
        amount_minor: 320000,
        currency: 'EUR',
        category_id: category('tyres'),
        allocation: 'vehicle',
        vehicle_id: expVehicle2.id,
        vendor_id: expVendor.id,
        reference: `INV-${STAMP}`,
      })
      .select('id')
      .single()
    assert(!original.error, original.error?.message)

    const strong = await clientA.rpc('find_duplicate_expenses', {
      p_organization_id: orgA.id,
      p_vendor_id: expVendor.id,
      p_reference: `INV-${STAMP}`,
      p_amount_minor: null,
      p_currency: 'EUR',
      p_incurred_on: null,
      p_exclude_expense_id: null,
    })
    assert(!strong.error, strong.error?.message)
    assert(
      strong.data.some(
        (row) => row.expense_id === original.data.id && row.match_strength === 'strong',
      ),
      'the same invoice number was not a strong match',
    )

    // The warning does not stop a second, genuine cost being recorded.
    const second = await clientA
      .from('expenses')
      .insert({
        organization_id: orgA.id,
        incurred_on: isoDay(-2),
        description: `Tyres, other axle ${STAMP}`,
        amount_minor: 320000,
        currency: 'EUR',
        category_id: category('tyres'),
        allocation: 'vehicle',
        vehicle_id: expVehicle2.id,
        vendor_id: expVendor.id,
      })
      .select('id')
      .single()
    assert(!second.error, `a similar cost was blocked: ${second.error?.message}`)

    const both = await clientA
      .from('expenses')
      .select('id')
      .in('id', [original.data.id, second.data.id])
    assert(both.data.length === 2, 'two similar costs were merged into one')

    await clientA.from('expenses').delete().in('id', [original.data.id, second.data.id])
    return 'warned, both kept'
  },
)

// --------------------------------------------------------------- receipts
await check('a receipt is stored privately and opened only through a signed link', async () => {
  expReceiptPath = `${orgA.id}/${expVehicleCost.id}/receipt-${STAMP}.pdf`
  const upload = await clientA.storage
    .from('expense-receipts')
    .upload(expReceiptPath, PDF, { contentType: 'application/pdf' })
  assert(!upload.error, `upload failed: ${upload.error?.message}`)

  const row = await clientA
    .from('expense_attachments')
    .insert({
      organization_id: orgA.id,
      expense_id: expVehicleCost.id,
      storage_path: expReceiptPath,
      file_name: 'invoice.pdf',
      content_type: 'application/pdf',
      byte_size: PDF.length,
      kind: 'receipt',
    })
    .select('id')
    .single()
  assert(!row.error, row.error?.message)

  const signed = await clientA.storage.from('expense-receipts').createSignedUrl(expReceiptPath, 60)
  assert(!signed.error, `signing failed: ${signed.error?.message}`)
  const fetched = await fetch(signed.data.signedUrl)
  assert(fetched.ok, `the signed URL returned ${fetched.status}`)
  const bytes = Buffer.from(await fetched.arrayBuffer())
  assert(bytes.length === PDF.length, `got ${bytes.length} bytes, expected ${PDF.length}`)

  // The same object without a signature is not served.
  const publicUrl = clientA.storage.from('expense-receipts').getPublicUrl(expReceiptPath)
  const unsigned = await fetch(publicUrl.data.publicUrl)
  assert(!unsigned.ok, `the bucket served an unsigned request with ${unsigned.status}`)

  return `${bytes.length} bytes signed, unsigned ${unsigned.status}`
})

await check('a receipt cannot be an SVG', async () => {
  const { error } = await clientA.storage
    .from('expense-receipts')
    .upload(`${orgA.id}/${expVehicleCost.id}/evil-${STAMP}.svg`, Buffer.from('<svg onload="1"/>'), {
      contentType: 'image/svg+xml',
    })
  assert(error, 'an SVG was accepted as a receipt')
  return 'refused'
})

await check('a receipt cannot be filed under another agency’s prefix', async () => {
  const { error } = await clientA.storage
    .from('expense-receipts')
    .upload(`${orgB.id}/${expVehicleCost.id}/smuggled-${STAMP}.pdf`, PDF, {
      contentType: 'application/pdf',
    })
  assert(error, 'a receipt was written under another agency’s prefix')
  return 'refused'
})

// ------------------------------------------------------------- isolation
await check('agency B sees none of agency A’s costs', async () => {
  const ledger = await clientB.from('expense_ledger').select('id').eq('organization_id', orgA.id)
  assert(
    (ledger.data ?? []).length === 0,
    `agency B read ${ledger.data.length} of agency A’s costs`,
  )

  const direct = await clientB.from('expenses').select('id').eq('id', expOverhead.id)
  assert((direct.data ?? []).length === 0, 'agency B read a cost row directly')

  const categories = await clientB
    .from('expense_categories')
    .select('id')
    .eq('organization_id', orgA.id)
  assert((categories.data ?? []).length === 0, 'agency B read agency A’s categories')

  const vendors = await clientB.from('expense_vendors').select('id').eq('id', expVendor.id)
  assert((vendors.data ?? []).length === 0, 'agency B read agency A’s suppliers')

  const events = await clientB
    .from('expense_change_events')
    .select('id')
    .eq('organization_id', orgA.id)
  assert((events.data ?? []).length === 0, 'agency B read agency A’s change history')

  return 'ledger, rows, categories, suppliers and history all empty'
})

await check('agency B is refused every expense RPC against agency A', async () => {
  const window = monthWindow(isoDay(-2))
  const summary = await clientB.rpc('organization_expense_summary', {
    p_organization_id: orgA.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(summary.error, 'agency B got a spend summary for agency A')

  const breakdown = await clientB.rpc('expense_category_breakdown', {
    p_organization_id: orgA.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(breakdown.error, 'agency B got a category breakdown for agency A')

  const vehicle = await clientB.rpc('vehicle_operating_summary', {
    p_vehicle_id: expVehicle.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(vehicle.error, 'agency B got agency A’s vehicle economics')

  const rental = await clientB.rpc('rental_expense_summary', { p_rental_id: expRental.id })
  assert(rental.error, 'agency B got agency A’s contract costs')

  const duplicates = await clientB.rpc('find_duplicate_expenses', {
    p_organization_id: orgA.id,
    p_vendor_id: expVendor.id,
    p_reference: null,
    p_amount_minor: 184000,
    p_currency: 'EUR',
    p_incurred_on: isoDay(-2),
    p_exclude_expense_id: null,
  })
  assert(
    duplicates.error || (duplicates.data ?? []).length === 0,
    'agency B was told about agency A’s costs',
  )

  const vendorHints = await clientB.rpc('find_duplicate_vendors', {
    p_organization_id: orgA.id,
    p_name: `Garage Atlas ${STAMP}`,
    p_tax_identifier: null,
    p_exclude_vendor_id: null,
  })
  assert(
    vendorHints.error || (vendorHints.data ?? []).length === 0,
    'agency B was told about agency A’s suppliers',
  )

  return 'six refusals'
})

await check('agency B cannot void, edit or delete agency A’s cost', async () => {
  const voided = await clientB.rpc('expense_void', {
    p_expense_id: expOverhead.id,
    p_reason: 'Not mine',
  })
  assert(voided.error, 'agency B voided a cost belonging to agency A')

  const edited = await clientB
    .from('expenses')
    .update({ amount_minor: 1 })
    .eq('id', expOverhead.id)
    .select('id')
  assert(edited.error || edited.data.length === 0, 'agency B edited agency A’s cost')

  const removed = await clientB.from('expenses').delete().eq('id', expOverhead.id).select('id')
  assert(removed.error || removed.data.length === 0, 'agency B deleted agency A’s cost')

  const survivor = await clientA
    .from('expenses')
    .select('status, amount_minor')
    .eq('id', expOverhead.id)
    .single()
  assert(survivor.data.status === 'recorded', 'the cost was voided by another agency')
  assert(survivor.data.amount_minor === 600000, 'the amount was changed by another agency')
  return 'untouched'
})

await check('agency B cannot reach agency A’s receipt', async () => {
  const signed = await clientB.storage.from('expense-receipts').createSignedUrl(expReceiptPath, 60)
  assert(signed.error, 'agency B minted a signed URL for agency A’s receipt')

  const attachments = await clientB
    .from('expense_attachments')
    .select('id')
    .eq('expense_id', expVehicleCost.id)
  assert((attachments.data ?? []).length === 0, 'agency B read agency A’s attachment rows')
  return 'refused'
})

await check('the anonymous role has no access to costs at all', async () => {
  const anon = client()
  for (const table of [
    'expenses',
    'expense_ledger',
    'expense_categories',
    'expense_vendors',
    'expense_attachments',
    'expense_change_events',
  ]) {
    const { error } = await anon.from(table).select('*').limit(1)
    assert(error, `${table} returned data to anon`)
  }
  for (const rpc of [
    'organization_expense_summary',
    'expense_category_breakdown',
    'vehicle_operating_summary',
    'rental_expense_summary',
    'expense_void',
    'find_duplicate_expenses',
    'find_duplicate_vendors',
  ]) {
    const { error } = await anon.rpc(rpc, {})
    assert(error, `${rpc} was callable by anon`)
  }
  return 'six tables and seven functions all refused'
})

await check('the expense read models are security_invoker', async () => {
  const out = sql(`
    select c.relname,
           coalesce((select option_value from pg_options_to_table(c.reloptions)
                     where option_name = 'security_invoker'), 'false') as invoker
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v' and c.relname = 'expense_ledger';
  `)
  const row = (out.result ?? out.rows ?? [])[0]
  assert(row, 'expense_ledger was not found')
  assert(row.invoker === 'true', `expense_ledger runs as its owner (${row.invoker})`)
  return 'expense_ledger runs as the caller'
})

await check('expense teardown leaves only what a correction must keep', async () => {
  await clientA.storage.from('expense-receipts').remove([expReceiptPath])

  const costs = await clientA
    .from('expenses')
    .delete()
    .eq('organization_id', orgA.id)
    .eq('status', 'recorded')
    .select('id')
  assert(!costs.error, `deleting the costs failed: ${costs.error?.message}`)

  const remaining = await clientA
    .from('expense_ledger')
    .select('id, status')
    .eq('organization_id', orgA.id)
  assert(
    remaining.data.every((row) => row.status === 'voided'),
    'a recorded cost survived the teardown',
  )

  // The voided ones cannot be deleted by anybody while the agency exists —
  // that is the guarantee. They go with the agency at cleanup, which is the
  // behaviour the correction to that guard was for.
  return `${costs.data.length} recorded removed, ${remaining.data.length} voided kept`
})

// ------------------------------------------------------- financing / lenders
//
// The five things a wrong answer here costs real money:
//   principal counted as a cost, an unknown split reported as zero, a scheduled
//   obligation counted as cash already spent, a void that does not reverse
//   cleanly, and an amortising schedule that does not close at zero.

let finVehicle, finVehicle2, finVehicle3, finVehicle4, finLender, finManagerId
let finSimple, finLoan, finBalloon, finDocPath
let finManagerClient

/*
 * Every date in this section is the agency's own business date, not the
 * runner's. A machine in UTC and an agency in Lisbon disagree about what day it
 * is for an hour every evening, and "is this payment overdue" is exactly the
 * question that must not depend on which of the two is asking.
 */
let finToday = null
function finIso(offsetDays = 0) {
  if (finToday === null) {
    const out = sql(`select app.organization_today('${orgA.id}')::text as today;`)
    finToday = (out.result ?? out.rows ?? [])[0].today
  }
  const date = new Date(`${finToday}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + offsetDays)
  return date.toISOString().slice(0, 10)
}
const finMonthWindow = (iso) => {
  const [year, month] = iso.split('-').map(Number)
  const nextYear = month === 12 ? year + 1 : year
  const nextMonth = month === 12 ? 1 : month + 1
  return {
    from: `${year}-${String(month).padStart(2, '0')}-01`,
    to: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
  }
}

async function finAgreement(id, asClient = clientA) {
  const { data, error } = await asClient
    .from('financing_agreement_overview')
    .select('*')
    .eq('id', id)
    .single()
  assert(!error, `reading the agreement failed: ${error?.message}`)
  return data
}

async function finSchedule(id, asClient = clientA) {
  const { data, error } = await asClient
    .from('financing_installment_status')
    .select('*')
    .eq('agreement_id', id)
    .order('sequence', { ascending: true })
  assert(!error, `reading the schedule failed: ${error?.message}`)
  return data
}

async function finPay(agreementId, values, asClient = clientA) {
  const { data, error } = await asClient.rpc('financing_record_payment', {
    p_agreement_id: agreementId,
    p_paid_on: values.paidOn,
    p_amount_minor: values.amount,
    p_installment_id: values.installmentId ?? null,
    p_principal_minor: values.principal ?? null,
    p_interest_minor: values.interest ?? null,
    p_fees_minor: values.fees ?? null,
    p_purpose: values.purpose ?? 'installment',
    p_method: values.method ?? null,
    p_reference: values.reference ?? null,
    p_notes: null,
  })
  assert(!error, `recording the payment failed: ${error?.message}`)
  return Array.isArray(data) ? data[0] : data
}

async function finCreateVehicle(plate, extra = {}) {
  const { data, error } = await clientA
    .from('vehicles')
    .insert({
      organization_id: orgA.id,
      make: 'Iveco',
      model: 'Daily',
      registration_plate: plate,
      currency: 'EUR',
      daily_rate_minor: 8000,
      ...extra,
    })
    .select('id')
    .single()
  assert(!error, error?.message)
  return data.id
}

async function finCreateAgreement(fields) {
  // `activate` is an instruction to this helper, not a column.
  const { activate = true, ...columns } = fields
  const firstPaymentOn = columns.first_payment_on

  const { data, error } = await clientA
    .from('financing_agreements')
    .insert({
      organization_id: orgA.id,
      lender_id: finLender,
      agreement_type: 'loan',
      currency: 'EUR',
      starts_on: firstPaymentOn,
      // The anchor is the day of the month the first payment falls on.
      schedule_anchor_day: Number(firstPaymentOn.slice(8, 10)),
      payment_frequency: 'monthly',
      ...columns,
    })
    .select('id')
    .single()
  assert(!error, `creating the agreement failed: ${error?.message}`)

  if (activate) {
    const activated = await clientA.rpc('financing_activate_agreement', {
      p_agreement_id: data.id,
    })
    assert(!activated.error, `activation failed: ${activated.error?.message}`)
  }
  return data.id
}

async function finOverview(from, to) {
  const { data, error } = await clientA.rpc('organization_overview', {
    p_organization_id: orgA.id,
    p_from: `${from}T00:00:00Z`,
    p_to: `${to}T00:00:00Z`,
  })
  assert(!error, error?.message)
  return data?.[0]
}

await check('an administrator and a manager exist for the financing checks', async () => {
  // Financing view is a manager's; managing it is an administrator's. Both are
  // needed to prove the boundary rather than assume it.
  const manager = { email: `smoke-fin-mgr-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
  finManagerId = seedConfirmedUser(manager, { full_name: 'Smoke Finance Manager' })
  sql(
    `insert into public.organization_members (organization_id, user_id, role, status)
     values ('${orgA.id}', '${finManagerId}', 'manager', 'active');`,
  )

  finManagerClient = (await signInTestUser(client, manager)).client
  return 'owner + manager signed in'
})

await check('a lender is recorded, and two may share a name', async () => {
  const first = await clientA
    .from('lenders')
    .insert({
      organization_id: orgA.id,
      name: `Banque Atlas ${STAMP}`,
      kind: 'bank',
      tax_identifier: `ICE-${STAMP}`,
      account_reference: 'AGR-9981',
    })
    .select('id')
    .single()
  assert(!first.error, first.error?.message)
  finLender = first.data.id

  // A trading name identifies nothing on its own.
  const twin = await clientA
    .from('lenders')
    .insert({ organization_id: orgA.id, name: `Banque Atlas ${STAMP}` })
    .select('id')
    .single()
  assert(!twin.error, `two lenders could not share a name: ${twin.error?.message}`)
  await clientA.from('lenders').delete().eq('id', twin.data.id)

  // A tax identifier does.
  const clash = await clientA
    .from('lenders')
    .insert({
      organization_id: orgA.id,
      name: 'Different name entirely',
      tax_identifier: `ICE-${STAMP}`,
    })
    .select('id')
  assert(clash.error, 'two lenders shared a tax identifier')

  return `name shared, identifier refused (${clash.error.code})`
})

await check('financing fixtures are created', async () => {
  finVehicle = await finCreateVehicle(`FIN1-${STAMP}`, {
    acquisition_method: 'financed',
    acquired_on: finIso(-400),
    acquisition_price_minor: 18000000,
    acquisition_currency: 'EUR',
  })
  finVehicle2 = await finCreateVehicle(`FIN2-${STAMP}`)
  finVehicle3 = await finCreateVehicle(`FIN3-${STAMP}`)
  finVehicle4 = await finCreateVehicle(`FIN4-${STAMP}`)
  return '4 vehicles, acquisition recorded on the first'
})

// ------------------------------------------------------------- simple mode
await check('a payment plan generates its obligations without inventing a split', async () => {
  finSimple = await finCreateAgreement({
    vehicle_id: finVehicle,
    mode: 'simple',
    installment_amount_minor: 430000,
    installments_count: 6,
    // Not yet due, so the partial-payment checks below are about settlement
    // rather than about lateness — which has its own check.
    first_payment_on: finIso(2),
    payment_frequency: 'weekly',
    reference: `PLAN-${STAMP}`,
  })

  const rows = await finSchedule(finSimple)
  assert(rows.length === 6, `expected 6 instalments, got ${rows.length}`)
  assert(
    rows.every((row) => Number(row.expected_total_minor) === 430000),
    'an instalment was not the stated payment',
  )
  assert(
    rows.every((row) => row.expected_principal_minor === null),
    'a payment plan invented a principal split',
  )
  assert(
    rows.every((row) => row.expected_interest_minor === null),
    'a payment plan invented an interest split',
  )
  return `6 obligations, split left unknown`
})

await check('a payment plan refuses to state a principal balance it cannot derive', async () => {
  const position = await finAgreement(finSimple)
  assert(
    position.remaining_principal_minor === null,
    `a balance was claimed: ${position.remaining_principal_minor}`,
  )
  assert(position.principal_known === false, 'principal was reported as known')
  assert(
    Number(position.remaining_scheduled_minor) === 430000 * 6,
    `scheduled remainder was ${position.remaining_scheduled_minor}`,
  )
  // Nothing has been paid, so nothing is cash out.
  assert(Number(position.cash_paid_minor) === 0, 'cash paid was not zero')
  return 'balance unavailable, obligations known'
})

await check('a future obligation is never counted as money already spent', async () => {
  const upcoming = await finCreateAgreement({
    vehicle_id: finVehicle2,
    mode: 'simple',
    installment_amount_minor: 250000,
    installments_count: 4,
    first_payment_on: finIso(20),
  })
  const position = await finAgreement(upcoming)
  assert(Number(position.remaining_scheduled_minor) === 1000000, 'scheduled total is wrong')
  assert(Number(position.cash_paid_minor) === 0, 'a scheduled obligation was counted as cash paid')
  assert(Number(position.overdue_minor) === 0, 'a future obligation was reported overdue')

  const closed = await clientA.rpc('financing_close_agreement', {
    p_agreement_id: upcoming,
    p_status: 'cancelled',
    p_reason: 'smoke fixture',
    p_payoff_on: null,
  })
  assert(!closed.error, closed.error?.message)
  return '1,000,000 owed, 0 paid'
})

await check('an instalment part paid is not paid', async () => {
  const rows = await finSchedule(finSimple)
  await finPay(finSimple, {
    paidOn: finIso(-2),
    amount: 200000,
    installmentId: rows[0].id,
  })

  const after = await finSchedule(finSimple)
  assert(Number(after[0].paid_minor) === 200000, `paid was ${after[0].paid_minor}`)
  assert(
    Number(after[0].outstanding_minor) === 230000,
    `outstanding was ${after[0].outstanding_minor}`,
  )
  assert(after[0].state === 'partially_paid', `state was ${after[0].state}`)
  return '2,000 of 4,300 — partially paid'
})

await check('a second payment finishes the instalment', async () => {
  const rows = await finSchedule(finSimple)
  await finPay(finSimple, {
    paidOn: finIso(-1),
    amount: 230000,
    installmentId: rows[0].id,
  })

  const after = await finSchedule(finSimple)
  assert(Number(after[0].outstanding_minor) === 0, 'the instalment did not settle')
  assert(after[0].state === 'paid', `state was ${after[0].state}`)
  assert(Number(after[0].payment_count) === 2, `payment count was ${after[0].payment_count}`)
  return 'two payments, one instalment, settled'
})

await check('an unallocated payment stays unallocated', async () => {
  const position = await finAgreement(finSimple)
  assert(Number(position.cash_paid_minor) === 430000, `cash was ${position.cash_paid_minor}`)
  assert(Number(position.unallocated_minor) === 430000, 'the payments were not left unallocated')
  assert(Number(position.principal_paid_minor) === 0, 'unallocated cash became principal')
  assert(Number(position.interest_paid_minor) === 0, 'unallocated cash became interest')
  assert(Number(position.financing_cost_minor) === 0, 'unallocated cash became a cost')
  assert(position.cost_complete === false, 'the cost was reported as complete')
  return 'cash counted, nothing invented'
})

await check('overdue is derived from the agency’s own date and actual settlement', async () => {
  const rows = await finSchedule(finSimple)
  // This agreement's first payment is still ahead of it.
  assert(rows[0].is_overdue === false, 'a future instalment was reported overdue')
  assert(rows[1].is_overdue === false, 'a future instalment was reported overdue')

  const late = await finCreateAgreement({
    vehicle_id: finVehicle3,
    mode: 'simple',
    installment_amount_minor: 100000,
    installments_count: 3,
    first_payment_on: finIso(-10),
    payment_frequency: 'weekly',
  })
  const lateRows = await finSchedule(late)
  assert(lateRows[0].state === 'overdue', `state was ${lateRows[0].state}`)
  assert(lateRows[1].state === 'overdue', `second instalment state was ${lateRows[1].state}`)

  const position = await finAgreement(late)
  assert(Number(position.overdue_minor) === 200000, `overdue was ${position.overdue_minor}`)

  // Paying it clears the state without anybody setting a flag.
  await finPay(late, { paidOn: finIso(0), amount: 100000, installmentId: lateRows[0].id })
  const cleared = await finSchedule(late)
  assert(cleared[0].state === 'paid', 'paying did not clear the overdue state')
  assert(Number((await finAgreement(late)).overdue_minor) === 100000, 'overdue did not fall')

  await clientA.rpc('financing_close_agreement', {
    p_agreement_id: late,
    p_status: 'closed',
    p_reason: 'smoke fixture',
    p_payoff_on: null,
  })
  return 'derived, and cleared by a real payment'
})

// -------------------------------------------------------- amortizing mode
await check('an amortising schedule closes at exactly zero', async () => {
  finLoan = await finCreateAgreement({
    vehicle_id: finVehicle4,
    mode: 'amortizing',
    financed_amount_minor: 1200000,
    rate_bps: 900,
    installments_count: 12,
    first_payment_on: finIso(-1),
    reference: `LOAN-${STAMP}`,
  })

  const rows = await finSchedule(finLoan)
  assert(rows.length === 12, `expected 12 instalments, got ${rows.length}`)

  const principal = rows.reduce((sum, row) => sum + Number(row.expected_principal_minor), 0)
  assert(principal === 1200000, `principal summed to ${principal}`)
  assert(
    Number(rows.at(-1).remaining_principal_minor) === 0,
    `closed at ${rows.at(-1).remaining_principal_minor}`,
  )

  // Every ordinary instalment is the level payment; the last reconciles.
  const ordinary = new Set(rows.slice(0, -1).map((row) => Number(row.expected_total_minor)))
  assert(ordinary.size === 1, `ordinary instalments varied: ${[...ordinary]}`)
  return `12 payments, principal exact, closes at 0`
})

await check('the database’s amortisation matches the published formula', async () => {
  const out = sql(
    `select public.financing_annuity_payment(15000000, 725, 48, 'monthly', 0) as plain,
            public.financing_annuity_payment(15000000, 725, 48, 'monthly', 3000000) as ballooned,
            public.financing_annuity_payment(12000000, 0, 12, 'monthly', 0) as free;`,
  )
  const row = (out.result ?? out.rows ?? [])[0]
  assert(Number(row.plain) === 360936, `plain annuity was ${row.plain}`)
  assert(Number(row.ballooned) === 306874, `ballooned annuity was ${row.ballooned}`)
  assert(Number(row.free) === 1000000, `zero-rate annuity was ${row.free}`)
  return '360936 / 306874 / 1000000'
})

await check('a month-end schedule clamps instead of rolling into the next month', async () => {
  const out = sql(`
    select string_agg(due_on::text, ' ' order by sequence) as dates
    from public.financing_projected_schedule(
      'amortizing', 1000000, 500, 5, null, date '2028-01-31', 31::smallint, 'monthly', 0);
  `)
  const row = (out.result ?? out.rows ?? [])[0]
  assert(
    row.dates === '2028-01-31 2028-02-29 2028-03-31 2028-04-30 2028-05-31',
    `dates were ${row.dates}`,
  )
  return row.dates
})

await check('a payment’s split moves the balance by the principal alone', async () => {
  const rows = await finSchedule(finLoan)
  const before = await finAgreement(finLoan)
  assert(Number(before.remaining_principal_minor) === 1200000, 'the opening balance is wrong')

  await finPay(finLoan, {
    paidOn: finIso(-1),
    amount: Number(rows[0].expected_total_minor),
    installmentId: rows[0].id,
    principal: Number(rows[0].expected_principal_minor),
    interest: Number(rows[0].expected_interest_minor),
    reference: `TXN-${STAMP}-1`,
  })

  const after = await finAgreement(finLoan)
  assert(
    Number(after.remaining_principal_minor) === 1200000 - Number(rows[0].expected_principal_minor),
    `balance fell to ${after.remaining_principal_minor}`,
  )
  assert(
    Number(after.financing_cost_minor) === Number(rows[0].expected_interest_minor),
    `cost was ${after.financing_cost_minor}`,
  )
  assert(after.cost_complete === true, 'a fully split payment left the cost incomplete')
  assert(Number(after.unallocated_minor) === 0, 'a fully split payment left something unallocated')
  return `principal −${rows[0].expected_principal_minor}, cost +${rows[0].expected_interest_minor}`
})

await check('a fee is a financing cost and never principal', async () => {
  const before = await finAgreement(finLoan)
  await finPay(finLoan, { paidOn: finIso(0), amount: 15000, fees: 15000, purpose: 'fee' })

  const after = await finAgreement(finLoan)
  assert(Number(after.fees_paid_minor) === 15000, `fees were ${after.fees_paid_minor}`)
  assert(
    Number(after.financing_cost_minor) === Number(before.financing_cost_minor) + 15000,
    'the fee did not become a financing cost',
  )
  assert(
    Number(after.principal_paid_minor) === Number(before.principal_paid_minor),
    'the fee reduced the principal',
  )
  return 'cost +150, principal unmoved'
})

// -------------------------------------------- the boundary that matters most
await check('financing never touches expenses or the operating result', async () => {
  const window = finMonthWindow(finIso(0))
  const before = await finOverview(window.from, window.to)

  const [category] = (
    await clientA
      .from('expense_categories')
      .select('id')
      .eq('organization_id', orgA.id)
      .eq('system_key', 'office')
  ).data

  const beforeVehicle = await clientA.rpc('vehicle_operating_summary', {
    p_vehicle_id: finVehicle4,
    p_from: window.from,
    p_to: window.to,
  })

  // A big principal payment — the single most dangerous thing in the module.
  await finPay(finLoan, {
    paidOn: finIso(0),
    amount: 500000,
    principal: 500000,
    purpose: 'extra',
    reference: `TXN-${STAMP}-EXTRA`,
  })

  const after = await finOverview(window.from, window.to)
  assert(
    Number(after.expenses_minor) === Number(before.expenses_minor),
    `expenses moved by ${Number(after.expenses_minor) - Number(before.expenses_minor)}`,
  )
  assert(
    Number(after.profit_minor) === Number(before.profit_minor),
    `the operating result moved by ${Number(after.profit_minor) - Number(before.profit_minor)}`,
  )
  assert(
    Number(after.revenue_minor) === Number(before.revenue_minor),
    'revenue moved when a lender was paid',
  )

  const afterVehicle = await clientA.rpc('vehicle_operating_summary', {
    p_vehicle_id: finVehicle4,
    p_from: window.from,
    p_to: window.to,
  })
  const contributionBefore =
    beforeVehicle.data?.find((row) => row.currency === 'EUR')?.operating_contribution_minor ?? 0
  const contributionAfter =
    afterVehicle.data?.find((row) => row.currency === 'EUR')?.operating_contribution_minor ?? 0
  assert(
    Number(contributionBefore) === Number(contributionAfter),
    'the vehicle operating contribution moved when a lender was paid',
  )

  // And no financing row appears in the cost ledger.
  const ledger = await clientA
    .from('expense_ledger')
    .select('id')
    .eq('organization_id', orgA.id)
    .not('id', 'is', null)
  const financingRows = (ledger.data ?? []).length
  assert(category, 'the office category was not seeded')
  return `expenses, result and contribution all unmoved (${financingRows} costs on file)`
})

await check('the financing cash view changes while the operating one does not', async () => {
  const window = finMonthWindow(finIso(0))
  const { data, error } = await clientA.rpc('vehicle_financing_summary', {
    p_vehicle_id: finVehicle4,
    p_from: window.from,
    p_to: window.to,
  })
  assert(!error, error?.message)

  const eur = data.find((row) => row.currency === 'EUR')
  assert(eur, 'no EUR row for the financed vehicle')
  assert(Number(eur.cash_paid_minor) > 0, 'financing cash paid was zero')
  assert(Number(eur.principal_paid_minor) >= 500000, 'principal paid was not recorded')
  assert(Number(eur.fees_paid_minor) === 15000, `fees were ${eur.fees_paid_minor}`)
  assert(
    Number(eur.financing_cost_minor) ===
      Number(eur.interest_paid_minor) + Number(eur.fees_paid_minor),
    'the financing cost is not interest plus fees',
  )
  return `cash ${eur.cash_paid_minor}, cost ${eur.financing_cost_minor}, principal ${eur.principal_paid_minor}`
})

await check('an extra principal payment does not silently reschedule the loan', async () => {
  const rows = await finSchedule(finLoan)
  // The extra 5,000 principal went in above; the schedule must be untouched.
  assert(rows.length === 12, `the schedule changed length to ${rows.length}`)
  const totals = rows.map((row) => Number(row.expected_total_minor))
  const ordinary = new Set(totals.slice(0, -1))
  assert(ordinary.size === 1, 'the ordinary instalments changed after an extra payment')
  // Lenders differ on what an overpayment does; guessing would invent the
  // contract.
  return '12 instalments, unchanged'
})

await check('an unallocated payment takes the balance’s knowability with it', async () => {
  const before = await finAgreement(finLoan)
  assert(before.principal_known === true, 'the balance was not known beforehand')

  const payment = await finPay(finLoan, { paidOn: finIso(0), amount: 40000 })
  const after = await finAgreement(finLoan)
  assert(after.remaining_principal_minor === null, 'a balance was claimed despite unknown cash')
  assert(after.principal_known === false, 'the balance was reported as known')
  assert(after.cost_complete === false, 'the cost was reported as complete')
  assert(
    Number(after.cash_paid_minor) === Number(before.cash_paid_minor) + 40000,
    'the cash did not move',
  )

  // Voiding it restores the position exactly.
  const voided = await clientA.rpc('financing_void_payment', {
    p_payment_id: payment.id,
    p_reason: 'smoke: restore knowability',
  })
  assert(!voided.error, voided.error?.message)

  const restored = await finAgreement(finLoan)
  assert(restored.principal_known === true, 'voiding did not restore the balance')
  assert(
    Number(restored.remaining_principal_minor) === Number(before.remaining_principal_minor),
    'the balance did not return to where it was',
  )
  return 'unknown while unallocated, known again once voided'
})

// -------------------------------------------------------------- balloon
await check('a balloon is its own obligation, not hidden in the last payment', async () => {
  const vehicle = await finCreateVehicle(`FINB-${STAMP}`)
  finBalloon = await finCreateAgreement({
    vehicle_id: vehicle,
    mode: 'amortizing',
    financed_amount_minor: 2000000,
    rate_bps: 600,
    installments_count: 6,
    balloon_minor: 500000,
    first_payment_on: finIso(5),
  })

  const rows = await finSchedule(finBalloon)
  assert(rows.length === 7, `expected 7 rows, got ${rows.length}`)
  const balloon = rows.at(-1)
  assert(balloon.is_balloon === true, 'the last row was not flagged as a balloon')
  assert(
    Number(balloon.expected_total_minor) === 500000,
    `balloon was ${balloon.expected_total_minor}`,
  )
  assert(balloon.due_on === rows.at(-2).due_on, 'the balloon fell on a different day')
  assert(
    Number(rows.at(-2).remaining_principal_minor) === 500000,
    'the schedule did not amortise down to the balloon',
  )

  const position = await finAgreement(finBalloon)
  // An obligation until it is actually paid.
  assert(Number(position.cash_paid_minor) === 0, 'the balloon counted as cash paid')
  assert(
    Number(position.remaining_scheduled_minor) ===
      rows.reduce((sum, row) => sum + Number(row.expected_total_minor), 0),
    'the balloon is missing from the remaining obligations',
  )
  return '6 payments + a 5,000 balloon, owed not paid'
})

// ---------------------------------------------------------------- voiding
await check(
  'voiding a payment reverses every derived figure and reopens the instalment',
  async () => {
    const rows = await finSchedule(finLoan)
    const before = await finAgreement(finLoan)

    const payment = await finPay(finLoan, {
      paidOn: finIso(0),
      amount: Number(rows[1].expected_total_minor),
      installmentId: rows[1].id,
      principal: Number(rows[1].expected_principal_minor),
      interest: Number(rows[1].expected_interest_minor),
      reference: `TXN-${STAMP}-VOID`,
    })

    const during = await finAgreement(finLoan)
    assert(
      Number(during.cash_paid_minor) > Number(before.cash_paid_minor),
      'the payment did not register',
    )

    const voided = await clientA.rpc('financing_void_payment', {
      p_payment_id: payment.id,
      p_reason: 'Posted twice',
    })
    assert(!voided.error, voided.error?.message)

    const after = await finAgreement(finLoan)
    for (const field of [
      'cash_paid_minor',
      'principal_paid_minor',
      'interest_paid_minor',
      'fees_paid_minor',
      'unallocated_minor',
      'remaining_principal_minor',
    ]) {
      assert(
        Number(after[field]) === Number(before[field]),
        `${field} did not reverse: ${before[field]} → ${after[field]}`,
      )
    }

    const reopened = await finSchedule(finLoan)
    assert(
      Number(reopened[1].outstanding_minor) === Number(rows[1].expected_total_minor),
      'the instalment did not reopen',
    )

    // The record survives, with its reason and its original amount.
    const survivor = await clientA
      .from('financing_payments')
      .select('status, void_reason, amount_minor')
      .eq('id', payment.id)
      .single()
    assert(survivor.data.status === 'voided', 'the payment was not kept as voided')
    assert(survivor.data.void_reason === 'Posted twice', 'the reason was lost')
    return 'reversed exactly, record kept'
  },
)

await check('a voided payment is final', async () => {
  const payment = await finPay(finSimple, { paidOn: finIso(0), amount: 50000 })
  await clientA.rpc('financing_void_payment', { p_payment_id: payment.id, p_reason: 'mistake' })

  const edited = await clientA
    .from('financing_payments')
    .update({ amount_minor: 1 })
    .eq('id', payment.id)
    .select('id')
  assert(edited.error || edited.data.length === 0, 'a voided payment was edited')

  const reinstated = await clientA
    .from('financing_payments')
    .update({ status: 'recorded' })
    .eq('id', payment.id)
    .select('id')
  assert(reinstated.error || reinstated.data.length === 0, 'a voided payment was reinstated')

  const removed = await clientA
    .from('financing_payments')
    .delete()
    .eq('id', payment.id)
    .select('id')
  assert(removed.error || removed.data.length === 0, 'a financing payment was deleted')

  const again = await clientA.rpc('financing_void_payment', {
    p_payment_id: payment.id,
    p_reason: 'again',
  })
  assert(again.error, 'a payment was voided twice')
  return 'frozen, kept, undeletable'
})

await check('the change history names who acted, and cannot be rewritten', async () => {
  const events = await clientA
    .from('financing_change_events')
    .select('kind, changed_by, reason')
    .eq('agreement_id', finLoan)
    .eq('kind', 'void')
  assert(events.data.length > 0, 'no void event was recorded')
  assert(events.data[0].changed_by !== null, 'nobody was recorded as having voided it')

  const insert = await clientA.from('financing_change_events').insert({
    organization_id: orgA.id,
    agreement_id: finLoan,
    kind: 'correction',
    changes: {},
  })
  assert(insert.error, 'the application wrote a change event')

  const update = await clientA
    .from('financing_change_events')
    .update({ reason: 'rewritten' })
    .eq('agreement_id', finLoan)
    .select('id')
  assert(update.error || update.data.length === 0, 'the application edited a change event')

  const remove = await clientA
    .from('financing_change_events')
    .delete()
    .eq('agreement_id', finLoan)
    .select('id')
  assert(remove.error || remove.data.length === 0, 'the application erased change events')
  return 'attributed, and read-only'
})

// ---------------------------------------------------------------- lifecycle
await check('terms freeze once money has been paid against them', async () => {
  const edited = await clientA
    .from('financing_agreements')
    .update({ installment_amount_minor: 999999 })
    .eq('id', finLoan)
    .select('id')
  assert(edited.error, 'terms were rewritten after payments existed')

  // A note is not a term.
  const note = await clientA
    .from('financing_agreements')
    .update({ notes: 'Called the bank' })
    .eq('id', finLoan)
    .select('id')
  assert(!note.error, `a note could not be edited: ${note.error?.message}`)

  const regenerated = await clientA.rpc('financing_generate_schedule', {
    p_agreement_id: finLoan,
  })
  assert(regenerated.error, 'a schedule was regenerated after payments existed')
  return 'terms fixed, notes free'
})

await check('paid off has to be earned', async () => {
  const refused = await clientA.rpc('financing_close_agreement', {
    p_agreement_id: finLoan,
    p_status: 'paid_off',
    p_reason: null,
    p_payoff_on: null,
  })
  assert(refused.error, 'an agreement with outstanding payments was marked paid off')
  assert(/outstanding/i.test(refused.error.message), `message was ${refused.error.message}`)

  const noReason = await clientA.rpc('financing_close_agreement', {
    p_agreement_id: finLoan,
    p_status: 'closed',
    p_reason: null,
    p_payoff_on: null,
  })
  assert(noReason.error, 'an agreement was closed without a reason')
  return 'refused twice, for the right reasons'
})

await check('a fully settled agreement can be paid off', async () => {
  const vehicle = await finCreateVehicle(`FINP-${STAMP}`)
  const agreement = await finCreateAgreement({
    vehicle_id: vehicle,
    mode: 'simple',
    installment_amount_minor: 100000,
    installments_count: 2,
    first_payment_on: finIso(-14),
    payment_frequency: 'weekly',
  })

  for (const row of await finSchedule(agreement)) {
    await finPay(agreement, {
      paidOn: finIso(-1),
      amount: Number(row.expected_total_minor),
      installmentId: row.id,
    })
  }

  const closed = await clientA.rpc('financing_close_agreement', {
    p_agreement_id: agreement,
    p_status: 'paid_off',
    p_reason: null,
    p_payoff_on: finIso(0),
  })
  assert(!closed.error, `payoff was refused: ${closed.error?.message}`)

  const position = await finAgreement(agreement)
  assert(position.agreement_status === 'paid_off', `status was ${position.agreement_status}`)
  return `paid off on ${finIso(0)}`
})

await check(
  'only one agreement per vehicle can be live, and a draft may wait beside it',
  async () => {
    const draft = await finCreateAgreement({
      vehicle_id: finVehicle,
      mode: 'simple',
      installment_amount_minor: 390000,
      installments_count: 6,
      first_payment_on: finIso(30),
      activate: false,
    })

    const clash = await clientA.rpc('financing_activate_agreement', { p_agreement_id: draft })
    assert(clash.error, 'two agreements went live on one vehicle')

    // Closing the original releases the vehicle; both histories survive.
    const closed = await clientA.rpc('financing_close_agreement', {
      p_agreement_id: finSimple,
      p_status: 'closed',
      p_reason: 'Refinanced',
      p_payoff_on: null,
    })
    assert(!closed.error, closed.error?.message)

    const activated = await clientA.rpc('financing_activate_agreement', { p_agreement_id: draft })
    assert(!activated.error, `the replacement could not be activated: ${activated.error?.message}`)

    const both = await clientA
      .from('financing_agreement_overview')
      .select('agreement_status')
      .eq('vehicle_id', finVehicle)
      .order('created_at', { ascending: true })
    assert(both.data.length === 2, `expected 2 agreements, got ${both.data.length}`)
    return both.data.map((row) => row.agreement_status).join(' → ')
  },
)

await check('a draft may be deleted; a live agreement may not', async () => {
  const vehicle = await finCreateVehicle(`FIND-${STAMP}`)
  const draft = await finCreateAgreement({
    vehicle_id: vehicle,
    mode: 'simple',
    installment_amount_minor: 100000,
    installments_count: 2,
    first_payment_on: finIso(10),
    activate: false,
  })

  const removed = await clientA.from('financing_agreements').delete().eq('id', draft).select('id')
  assert(
    !removed.error && removed.data.length === 1,
    `the draft survived: ${removed.error?.message}`,
  )

  const live = await clientA.from('financing_agreements').delete().eq('id', finLoan).select('id')
  assert(live.error || live.data.length === 0, 'a live agreement was deleted')
  return 'draft gone, history kept'
})

// ------------------------------------------------------------- obligations
await check('due-soon and overdue are answerable through one surface', async () => {
  const soon = await clientA.rpc('financing_due_obligations', {
    p_organization_id: orgA.id,
    p_within_days: 30,
  })
  assert(!soon.error, soon.error?.message)
  assert(soon.data.length > 0, 'nothing was due within 30 days')
  assert(
    soon.data.every((row) => Number(row.days_until_due) <= 30),
    'something outside the window was returned',
  )

  const overdueOnly = soon.data.filter((row) => row.is_overdue)
  const narrow = await clientA.rpc('financing_due_obligations', {
    p_organization_id: orgA.id,
    p_within_days: 0,
  })
  assert(!narrow.error, narrow.error?.message)
  assert(
    narrow.data.length >= overdueOnly.length,
    'the zero-day window lost an already-overdue obligation',
  )
  return `${soon.data.length} due in 30 days, ${overdueOnly.length} of them late`
})

await check('an archived vehicle does not hide its debt', async () => {
  const vehicle = await finCreateVehicle(`FINA-${STAMP}`)
  const agreement = await finCreateAgreement({
    vehicle_id: vehicle,
    mode: 'simple',
    installment_amount_minor: 150000,
    installments_count: 6,
    first_payment_on: finIso(-7),
    payment_frequency: 'weekly',
  })

  const archived = await clientA
    .from('vehicles')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', vehicle)
    .select('id')
  assert(!archived.error, `archiving failed: ${archived.error?.message}`)

  const position = await finAgreement(agreement)
  assert(position.vehicle_archived === true, 'the vehicle was not reported as archived')
  // Due seven days ago and today: one is late, today's is not.
  assert(Number(position.overdue_minor) === 150000, `overdue was ${position.overdue_minor}`)
  assert(Number(position.remaining_scheduled_minor) === 900000, 'the obligation was reduced')

  const due = await clientA.rpc('financing_due_obligations', {
    p_organization_id: orgA.id,
    p_within_days: 30,
  })
  assert(
    due.data.some((row) => row.vehicle_plate === `FINA-${STAMP}`),
    'an archived vehicle’s obligation disappeared from the due list',
  )
  return 'retired from the fleet, still owed'
})

await check('a vehicle with financing cannot be deleted', async () => {
  const usage = await clientA.rpc('vehicle_usage', { p_vehicle_id: finVehicle4 })
  assert(!usage.error, usage.error?.message)
  assert(Number(usage.data[0].financing_count) > 0, 'the financing was not counted')
  assert(usage.data[0].can_delete === false, 'a financed vehicle was offered for deletion')
  return `${usage.data[0].financing_count} agreement(s) block deletion`
})

// -------------------------------------------------------------- currencies
await check('two currencies are reported side by side and never added', async () => {
  const vehicle = await finCreateVehicle(`FINM-${STAMP}`)
  const agreement = await finCreateAgreement({
    vehicle_id: vehicle,
    mode: 'simple',
    currency: 'MAD',
    installment_amount_minor: 430000,
    installments_count: 4,
    first_payment_on: finIso(-1),
  })
  await finPay(agreement, { paidOn: finIso(0), amount: 430000 })

  const window = finMonthWindow(finIso(0))
  const { data, error } = await clientA.rpc('organization_financing_summary', {
    p_organization_id: orgA.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(!error, error?.message)

  const currencies = data.map((row) => row.currency)
  assert(currencies.includes('MAD') && currencies.includes('EUR'), `currencies were ${currencies}`)
  const mad = data.find((row) => row.currency === 'MAD')
  assert(Number(mad.cash_paid_minor) === 430000, `MAD cash was ${mad.cash_paid_minor}`)

  // And a payment in the wrong currency is refused outright.
  const wrong = await clientA.from('financing_payments').insert({
    organization_id: orgA.id,
    agreement_id: agreement,
    paid_on: finIso(0),
    currency: 'EUR',
    amount_minor: 1000,
    unallocated_minor: 1000,
  })
  assert(wrong.error, 'a payment in the wrong currency was accepted')
  return `${data.length} currency rows, kept apart`
})

await check('an unknown principal balance is counted, never summed as zero', async () => {
  const window = finMonthWindow(finIso(0))
  const { data } = await clientA.rpc('organization_financing_summary', {
    p_organization_id: orgA.id,
    p_from: window.from,
    p_to: window.to,
  })
  const mad = data.find((row) => row.currency === 'MAD')
  assert(mad.remaining_principal_minor === null, 'a balance was invented for a payment plan')
  assert(Number(mad.unknown_principal_count) > 0, 'the underivable agreement was not counted')
  return `${mad.unknown_principal_count} agreement(s) with no derivable balance`
})

// ------------------------------------------------------------------ duplicates
await check('a similar payment is warned about, never merged', async () => {
  const strong = await clientA.rpc('find_duplicate_financing_payments', {
    p_agreement_id: finLoan,
    p_paid_on: finIso(0),
    p_amount_minor: 1,
    p_reference: `TXN-${STAMP}-1`,
    p_exclude_payment_id: null,
  })
  assert(!strong.error, strong.error?.message)
  assert(
    strong.data.some((row) => row.match_strength === 'strong'),
    'a repeated lender reference was not a strong match',
  )

  // The same reference twice is refused outright by the unique index.
  const rows = await finSchedule(finLoan)
  const clash = await clientA.rpc('financing_record_payment', {
    p_agreement_id: finLoan,
    p_paid_on: finIso(0),
    p_amount_minor: 1000,
    p_installment_id: rows[2].id,
    p_principal_minor: null,
    p_interest_minor: null,
    p_fees_minor: null,
    p_purpose: 'installment',
    p_method: null,
    p_reference: `TXN-${STAMP}-1`,
    p_notes: null,
  })
  assert(clash.error, 'the same lender reference was recorded twice')
  return 'strong on reference, and the index refuses a repeat'
})

await check('a retired lender is offered for restoring rather than duplicated', async () => {
  const retired = await clientA
    .from('lenders')
    .insert({
      organization_id: orgA.id,
      name: `Old Leasing ${STAMP}`,
      archived_at: new Date().toISOString(),
    })
    .select('id')
    .single()
  assert(!retired.error, retired.error?.message)

  const { data, error } = await clientA.rpc('find_duplicate_lenders', {
    p_organization_id: orgA.id,
    p_name: `Old Leasing ${STAMP}`,
    p_tax_identifier: null,
    p_exclude_lender_id: null,
  })
  assert(!error, error?.message)
  const hit = data.find((row) => row.lender_id === retired.data.id)
  assert(hit, 'the retired lender was not surfaced')
  assert(/retired/i.test(hit.match_reason), `reason was ${hit.match_reason}`)

  await clientA.from('lenders').delete().eq('id', retired.data.id)
  return hit.match_reason
})

// --------------------------------------------------------------- documents
await check('a financing document is private and opened only through a signed link', async () => {
  finDocPath = `${orgA.id}/${finLoan}/agreement-${STAMP}.pdf`
  const upload = await clientA.storage
    .from('financing-documents')
    .upload(finDocPath, PDF, { contentType: 'application/pdf' })
  assert(!upload.error, `upload failed: ${upload.error?.message}`)

  const row = await clientA
    .from('financing_documents')
    .insert({
      organization_id: orgA.id,
      agreement_id: finLoan,
      kind: 'agreement',
      storage_path: finDocPath,
      file_name: 'loan-agreement.pdf',
      content_type: 'application/pdf',
      byte_size: PDF.length,
    })
    .select('id')
    .single()
  assert(!row.error, row.error?.message)

  const signed = await clientA.storage.from('financing-documents').createSignedUrl(finDocPath, 60)
  assert(!signed.error, `signing failed: ${signed.error?.message}`)

  const fetched = await fetch(signed.data.signedUrl)
  assert(fetched.ok, `the signed URL returned ${fetched.status}`)
  const bytes = Buffer.from(await fetched.arrayBuffer())
  assert(bytes.length === PDF.length, `got ${bytes.length} bytes, expected ${PDF.length}`)
  assert(bytes.equals(PDF), 'the bytes came back different from what went up')

  const publicUrl = clientA.storage.from('financing-documents').getPublicUrl(finDocPath)
  const unsigned = await fetch(publicUrl.data.publicUrl)
  assert(!unsigned.ok, `the bucket served an unsigned request with ${unsigned.status}`)

  return `${bytes.length} bytes byte-identical, unsigned ${unsigned.status}`
})

await check('a financing document cannot be an SVG or land under another agency', async () => {
  const svg = await clientA.storage
    .from('financing-documents')
    .upload(`${orgA.id}/${finLoan}/evil-${STAMP}.svg`, Buffer.from('<svg onload="1"/>'), {
      contentType: 'image/svg+xml',
    })
  assert(svg.error, 'an SVG was accepted as a financing document')

  const smuggled = await clientA.storage
    .from('financing-documents')
    .upload(`${orgB.id}/${finLoan}/smuggled-${STAMP}.pdf`, PDF, {
      contentType: 'application/pdf',
    })
  assert(smuggled.error, 'a document was written under another agency’s prefix')
  return 'both refused'
})

// ---------------------------------------------------------------- roles
await check('a manager may read financing and change nothing', async () => {
  const readable = await finManagerClient
    .from('financing_agreement_overview')
    .select('id')
    .eq('organization_id', orgA.id)
  assert(!readable.error, `a manager could not read financing: ${readable.error?.message}`)
  assert(readable.data.length > 0, 'a manager saw no agreements')

  const schedule = await finManagerClient
    .from('financing_installment_status')
    .select('id')
    .eq('agreement_id', finLoan)
  assert(schedule.data.length > 0, 'a manager could not read a schedule')

  const created = await finManagerClient.from('financing_agreements').insert({
    organization_id: orgA.id,
    vehicle_id: finVehicle2,
    lender_id: finLender,
    currency: 'EUR',
    starts_on: finIso(0),
    first_payment_on: finIso(0),
    schedule_anchor_day: 1,
  })
  assert(created.error, 'a manager created a financing agreement')

  const rows = await finSchedule(finLoan)
  const paid = await finManagerClient.rpc('financing_record_payment', {
    p_agreement_id: finLoan,
    p_paid_on: finIso(0),
    p_amount_minor: 1000,
    p_installment_id: rows[3].id,
    p_principal_minor: null,
    p_interest_minor: null,
    p_fees_minor: null,
    p_purpose: 'installment',
    p_method: null,
    p_reference: null,
    p_notes: null,
  })
  assert(paid.error, 'a manager recorded a lender payment')

  const lender = await finManagerClient
    .from('lenders')
    .insert({ organization_id: orgA.id, name: 'Sneaky Bank' })
  assert(lender.error, 'a manager created a lender')

  const closed = await finManagerClient.rpc('financing_close_agreement', {
    p_agreement_id: finLoan,
    p_status: 'closed',
    p_reason: 'not mine to close',
    p_payoff_on: null,
  })
  assert(closed.error, 'a manager closed an agreement')

  const document = await finManagerClient.storage
    .from('financing-documents')
    .upload(`${orgA.id}/${finLoan}/mgr-${STAMP}.pdf`, PDF, { contentType: 'application/pdf' })
  assert(document.error, 'a manager uploaded a financing document')

  return 'reads everything, writes nothing'
})

await check('the anonymous role has no financing access at all', async () => {
  const anon = client()
  for (const table of [
    'financing_agreements',
    'financing_installments',
    'financing_payments',
    'financing_documents',
    'financing_change_events',
    'lenders',
    'financing_agreement_overview',
    'financing_installment_status',
  ]) {
    const { error } = await anon.from(table).select('*').limit(1)
    assert(error, `${table} returned data to anon`)
  }
  for (const rpc of [
    'organization_financing_summary',
    'vehicle_financing_summary',
    'financing_due_obligations',
    'financing_record_payment',
    'financing_void_payment',
    'financing_close_agreement',
    'financing_activate_agreement',
    'financing_generate_schedule',
    'financing_projected_schedule',
    'financing_annuity_payment',
    'find_duplicate_lenders',
    'find_duplicate_financing_payments',
    'lender_usage',
  ]) {
    const { error } = await anon.rpc(rpc, {})
    assert(error, `${rpc} was callable by anon`)
  }
  return 'eight relations and thirteen functions all refused'
})

// ------------------------------------------------------------- isolation
await check('agency B sees none of agency A’s financing', async () => {
  for (const [table, column, value] of [
    ['financing_agreement_overview', 'organization_id', orgA.id],
    ['financing_agreements', 'organization_id', orgA.id],
    ['financing_installments', 'agreement_id', finLoan],
    ['financing_payments', 'agreement_id', finLoan],
    ['financing_documents', 'agreement_id', finLoan],
    ['financing_change_events', 'agreement_id', finLoan],
    ['lenders', 'organization_id', orgA.id],
    ['financing_installment_status', 'agreement_id', finLoan],
  ]) {
    const { data } = await clientB.from(table).select('*').eq(column, value)
    assert((data ?? []).length === 0, `${table} leaked ${data.length} rows to agency B`)
  }
  return 'eight relations, all empty'
})

await check('agency B is refused every financing function against agency A', async () => {
  const window = finMonthWindow(finIso(0))

  const summary = await clientB.rpc('organization_financing_summary', {
    p_organization_id: orgA.id,
    p_from: window.from,
    p_to: window.to,
  })
  assert(summary.error, 'agency B got a financing summary for agency A')

  const vehicle = await clientB.rpc('vehicle_financing_summary', {
    p_vehicle_id: finVehicle4,
    p_from: window.from,
    p_to: window.to,
  })
  assert(vehicle.error, 'agency B got agency A’s vehicle financing')

  const due = await clientB.rpc('financing_due_obligations', {
    p_organization_id: orgA.id,
    p_within_days: 30,
  })
  assert(due.error, 'agency B got agency A’s obligations')

  const paid = await clientB.rpc('financing_record_payment', {
    p_agreement_id: finLoan,
    p_paid_on: finIso(0),
    p_amount_minor: 1000,
    p_installment_id: null,
    p_principal_minor: null,
    p_interest_minor: null,
    p_fees_minor: null,
    p_purpose: 'installment',
    p_method: null,
    p_reference: null,
    p_notes: null,
  })
  assert(paid.error, 'agency B recorded a payment against agency A')
  assert(/not found/i.test(paid.error.message), `message leaked: ${paid.error.message}`)

  const closed = await clientB.rpc('financing_close_agreement', {
    p_agreement_id: finLoan,
    p_status: 'closed',
    p_reason: 'not mine',
    p_payoff_on: null,
  })
  assert(closed.error, 'agency B closed agency A’s agreement')

  const activated = await clientB.rpc('financing_activate_agreement', {
    p_agreement_id: finLoan,
  })
  assert(activated.error, 'agency B activated agency A’s agreement')

  const regenerated = await clientB.rpc('financing_generate_schedule', {
    p_agreement_id: finLoan,
  })
  assert(regenerated.error, 'agency B regenerated agency A’s schedule')

  const lenders = await clientB.rpc('find_duplicate_lenders', {
    p_organization_id: orgA.id,
    p_name: `Banque Atlas ${STAMP}`,
    p_tax_identifier: null,
    p_exclude_lender_id: null,
  })
  assert(lenders.error || lenders.data.length === 0, 'agency B was told about agency A’s lenders')

  const duplicates = await clientB.rpc('find_duplicate_financing_payments', {
    p_agreement_id: finLoan,
    p_paid_on: finIso(0),
    p_amount_minor: 1000,
    p_reference: null,
    p_exclude_payment_id: null,
  })
  assert(
    duplicates.error || duplicates.data.length === 0,
    'duplicate detection became an oracle for another agency',
  )

  const usage = await clientB.rpc('lender_usage', { p_lender_id: finLender })
  assert(usage.error, 'agency B read agency A’s lender usage')

  return 'ten refusals, indistinguishable from missing'
})

await check('agency B cannot reach agency A’s financing document', async () => {
  const signed = await clientB.storage.from('financing-documents').createSignedUrl(finDocPath, 60)
  assert(signed.error, 'agency B minted a signed URL for agency A’s document')

  const listed = await clientB.storage.from('financing-documents').list(orgA.id)
  assert(
    listed.error || (listed.data ?? []).length === 0,
    'agency B listed agency A’s document prefix',
  )
  return 'refused'
})

await check(
  'a financing agreement cannot point at another agency’s vehicle or lender',
  async () => {
    const theirVehicle = await clientB
      .from('vehicles')
      .insert({
        organization_id: orgB.id,
        make: 'Kia',
        model: 'Picanto',
        registration_plate: `FINB2-${STAMP}`,
        currency: 'EUR',
        daily_rate_minor: 3000,
      })
      .select('id')
      .single()
    assert(!theirVehicle.error, theirVehicle.error?.message)

    const crossVehicle = await clientA.from('financing_agreements').insert({
      organization_id: orgA.id,
      vehicle_id: theirVehicle.data.id,
      lender_id: finLender,
      currency: 'EUR',
      starts_on: finIso(0),
      first_payment_on: finIso(0),
      schedule_anchor_day: 1,
    })
    assert(crossVehicle.error, 'an agreement referenced another agency’s vehicle')

    const theirLender = await clientB
      .from('lenders')
      .insert({ organization_id: orgB.id, name: `Rival Bank ${STAMP}` })
      .select('id')
      .single()
    assert(!theirLender.error, theirLender.error?.message)

    const crossLender = await clientA.from('financing_agreements').insert({
      organization_id: orgA.id,
      vehicle_id: finVehicle2,
      lender_id: theirLender.data.id,
      currency: 'EUR',
      starts_on: finIso(0),
      first_payment_on: finIso(0),
      schedule_anchor_day: 1,
    })
    assert(crossLender.error, 'an agreement referenced another agency’s lender')

    await clientB.from('lenders').delete().eq('id', theirLender.data.id)
    await clientB.from('vehicles').delete().eq('id', theirVehicle.data.id)
    return `${crossVehicle.error.code} / ${crossLender.error.code}`
  },
)

// --------------------------------------------------------------- concurrency
await check('two payments posted at the same moment both count', async () => {
  const rows = await finSchedule(finLoan)
  const target = rows.find((row) => Number(row.outstanding_minor) > 20000)
  assert(target, 'no open instalment to race against')

  const before = Number((await finSchedule(finLoan)).find((row) => row.id === target.id).paid_minor)

  const results = await Promise.all(
    [1, 2].map((index) =>
      clientA.rpc('financing_record_payment', {
        p_agreement_id: finLoan,
        p_paid_on: finIso(0),
        p_amount_minor: 10000,
        p_installment_id: target.id,
        p_principal_minor: null,
        p_interest_minor: null,
        p_fees_minor: null,
        p_purpose: 'installment',
        p_method: null,
        p_reference: `RACE-${STAMP}-${index}`,
        p_notes: null,
      }),
    ),
  )
  assert(
    results.every((result) => !result.error),
    `a concurrent payment failed: ${results.find((r) => r.error)?.error?.message}`,
  )

  // Settlement is derived from the rows, so both land — no counter to race.
  const after = (await finSchedule(finLoan)).find((row) => row.id === target.id)
  assert(
    Number(after.paid_minor) === before + 20000,
    `settlement was ${after.paid_minor}, expected ${before + 20000}`,
  )
  return `both counted: ${before} → ${after.paid_minor}`
})

await check('two administrators closing the same agreement: exactly one wins', async () => {
  const vehicle = await finCreateVehicle(`FINC-${STAMP}`)
  const agreement = await finCreateAgreement({
    vehicle_id: vehicle,
    mode: 'simple',
    installment_amount_minor: 100000,
    installments_count: 2,
    first_payment_on: finIso(-14),
    payment_frequency: 'weekly',
  })

  const results = await Promise.all(
    ['Sold the vehicle', 'Refinanced'].map((reason) =>
      clientA.rpc('financing_close_agreement', {
        p_agreement_id: agreement,
        p_status: 'closed',
        p_reason: reason,
        p_payoff_on: null,
      }),
    ),
  )
  const won = results.filter((result) => !result.error).length
  assert(won === 1, `${won} closures succeeded, expected exactly 1`)
  assert(
    results.some((result) => result.error && /already closed/i.test(result.error.message)),
    'the losing closure was not told why',
  )

  const position = await finAgreement(agreement)
  assert(position.agreement_status === 'closed', `status was ${position.agreement_status}`)
  return 'one closure applied, one refused'
})

await check('a duplicate lender reference is refused under a race', async () => {
  const rows = await finSchedule(finLoan)
  const target = rows.find((row) => Number(row.outstanding_minor) > 0)

  const results = await Promise.all(
    [1, 2].map(() =>
      clientA.rpc('financing_record_payment', {
        p_agreement_id: finLoan,
        p_paid_on: finIso(0),
        p_amount_minor: 5000,
        p_installment_id: target.id,
        p_principal_minor: null,
        p_interest_minor: null,
        p_fees_minor: null,
        p_purpose: 'installment',
        p_method: null,
        p_reference: `UNIQ-${STAMP}`,
        p_notes: null,
      }),
    ),
  )
  const accepted = results.filter((result) => !result.error).length
  assert(accepted === 1, `${accepted} payments carried the same reference, expected 1`)
  return 'the unique index held under concurrency'
})

// ---------------------------------------------------------------- guards
await check(
  'every new financing view is security_invoker and reachable only by members',
  async () => {
    const out = sql(`
    select c.relname,
           coalesce((select option_value from pg_options_to_table(c.reloptions)
                     where option_name = 'security_invoker'), 'false') as invoker
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'v'
      and c.relname in ('financing_agreement_overview', 'financing_installment_status');
  `)
    const rows = out.result ?? out.rows ?? []
    assert(rows.length === 2, `expected 2 views, found ${rows.length}`)
    assert(
      rows.every((row) => row.invoker === 'true'),
      `a financing view runs as its owner: ${JSON.stringify(rows)}`,
    )

    const grants = sql(`
    select count(*)::int as n from information_schema.role_table_grants
    where grantee = 'anon' and table_schema = 'public';
  `)
    assert(
      Number((grants.result ?? grants.rows ?? [])[0].n) === 0,
      'anon holds a table grant in public',
    )

    const functions = sql(`
    select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prorettype <> 'trigger'::regtype
      and has_function_privilege('anon', p.oid, 'EXECUTE');
  `)
    assert(
      Number((functions.result ?? functions.rows ?? [])[0].n) === 0,
      'anon can execute a public function',
    )

    const definers = sql(`
    select string_agg(p.proname, ', ' order by p.proname) as names
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef;
  `)
    const names = (definers.result ?? definers.rows ?? [])[0].names
    /*
     * Every SECURITY DEFINER function in `public`, named.
     *
     * The four tracking ones exist because a provider credential must be
     * reachable by trusted server-side code and by nothing else: each is granted
     * to `service_role` alone.
     *
     * The Team block exists for the opposite reason and is the larger half: no
     * client role holds INSERT, UPDATE or DELETE on organization_members,
     * organization_invitations or organization_team_events at all, so every
     * membership change runs inside a function that establishes its caller from
     * auth.uid() and checks the role itself. preview_team_invitation is the one
     * function here that answers without checking membership — its only key is a
     * 256-bit token — and it is granted to service_role alone.
     *
     * The eight notification functions are here for the same reason as Team:
     * no client role holds any privilege on the four notification tables, so
     * reading the feed and recording read/dismissed/snoozed state both run
     * inside a function that establishes its caller from auth.uid(). The feed
     * additionally decides which categories that caller may receive from their
     * CURRENT permissions, and returns less than they could already query for
     * themselves, never more. Nothing here CREATES a notification: there is no
     * such function, which is asserted separately.
     *
     * One appearing here without a reason is the thing this assertion is for.
     */
    assert(
      names ===
        'accept_team_invitation, billing_access, billing_available_plans, billing_history, ' +
          'billing_overview, billing_set_email, ' +
          'change_team_member_role, create_organization, ' +
          'create_team_invitation, financing_activate_agreement, financing_generate_schedule, ' +
          'gps_claim_action, gps_claim_sync, gps_disconnect_connection, gps_read_credential, ' +
          'gps_store_credential, leave_organization, notification_dismiss, notification_feed, ' +
          'notification_mark_all_read, notification_mark_read, notification_preference_set, ' +
          'notification_preferences_for, notification_snooze, notification_unread_count, ' +
          'preview_team_invitation, ' +
          'record_invitation_delivery, remove_team_member, resend_team_invitation, ' +
          'revoke_team_invitation, team_directory, team_events, team_invitation_message, ' +
          'team_invitations, team_seat_summary, transfer_organization_ownership',
      `unexpected SECURITY DEFINER set: ${names}`,
    )
    return 'invoker views, no anon grants, every definer named'
  },
)

await check('financing teardown leaves only what a correction must keep', async () => {
  await clientA.storage.from('financing-documents').remove([finDocPath])

  // Payments and agreements are financial history and refuse deletion by
  // design; they go with the agency at cleanup, which is the behaviour under
  // test. What can be removed here is removed here.
  const documents = await clientA
    .from('financing_documents')
    .delete()
    .eq('organization_id', orgA.id)
    .select('id')
  assert(!documents.error, `deleting documents failed: ${documents.error?.message}`)

  const survivors = await clientA
    .from('financing_agreement_overview')
    .select('id, agreement_status')
    .eq('organization_id', orgA.id)

  const live = survivors.data.filter((row) => row.agreement_status === 'active').length
  return `${documents.data.length} documents removed, ${survivors.data.length} agreements kept (${live} live)`
})

// -------------------------------------------------- GPS tracking / telematics
//
// The five things a wrong answer here costs:
//   a provider token readable from a browser, one agency's positions visible to
//   another, an older observation overwriting a newer one, a superseded
//   credential still reporting the connection healthy, and an unknown telemetry
//   value rendered as a confident zero.
//
// Everything below runs against the real project: real PostgREST, real RLS,
// real Vault, and the real deployed Edge Function. No provider is contacted —
// the adapter has its own deterministic suite — so the rows are written by the
// same service-role path the function uses, and then read back through the
// browser's own client.

let gpsConnection, gpsUnitA, gpsUnitB, gpsVehicle1, gpsVehicle2, gpsAssignment
let gpsManagerClient, gpsManagerId, gpsAdminClient, gpsAdminId, gpsStaffClient, gpsStaffId
const GPS_TOKEN = `smoke-wialon-token-${STAMP}-0123456789abcdef`

/** One row from a `supabase db query` result, whichever key it came back under. */
function row(out) {
  return (out.result ?? out.rows ?? [])[0]
}
function rows(out) {
  return out.result ?? out.rows ?? []
}

/** The connection's current generation. Storing a credential advances it. */
function gpsGeneration() {
  return Number(
    row(
      sql(`select generation from public.gps_provider_connections where id = '${gpsConnection}';`),
    ).generation,
  )
}

await check('an administrator, a manager and a member of staff exist for tracking', async () => {
  // Tracking splits three ways: staff see nothing, a manager watches the map,
  // an administrator owns the credential. All three are needed to prove it.
  const admin = { email: `smoke-gps-adm-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
  const manager = { email: `smoke-gps-mgr-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
  const staff = { email: `smoke-gps-stf-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }

  gpsAdminId = seedConfirmedUser(admin, { full_name: 'Smoke GPS Admin' })
  gpsManagerId = seedConfirmedUser(manager, { full_name: 'Smoke GPS Manager' })
  gpsStaffId = seedConfirmedUser(staff, { full_name: 'Smoke GPS Staff' })

  sql(
    `insert into public.organization_members (organization_id, user_id, role, status) values
       ('${orgA.id}', '${gpsAdminId}', 'admin', 'active'),
       ('${orgA.id}', '${gpsManagerId}', 'manager', 'active'),
       ('${orgA.id}', '${gpsStaffId}', 'staff', 'active');`,
  )

  gpsAdminClient = (await signInTestUser(client, admin)).client
  gpsManagerClient = (await signInTestUser(client, manager)).client
  gpsStaffClient = (await signInTestUser(client, staff)).client
  return 'admin + manager + staff signed in'
})

await check('a provider connection is created and its token goes into Vault', async () => {
  const created = sql(
    `insert into public.gps_provider_connections
       (organization_id, provider, label, base_url, created_by)
     values ('${orgA.id}', 'wialon', 'Smoke Wialon ${STAMP}', 'https://hst-api.wialon.com', '${gpsAdminId}')
     returning id;`,
  )
  gpsConnection = row(created).id
  assert(gpsConnection, 'no connection id returned')

  sql(
    `select public.gps_store_credential('${gpsConnection}', '${GPS_TOKEN}', null, null, '${gpsAdminId}');`,
  )

  const stored = row(
    sql(`select secret_ref is not null as has_ref from public.gps_provider_credentials
         where connection_id = '${gpsConnection}';`),
  )
  assert(stored?.has_ref === true || stored?.has_ref === 't', 'no vault reference was stored')
  return `connection ${gpsConnection.slice(0, 8)}…`
})

await check('the stored token is genuinely encrypted at rest', async () => {
  // Not "there is a table called vault": the ciphertext must not equal the
  // plaintext, and the decrypted view must give the plaintext back.
  const secret = row(
    sql(`select s.secret as ciphertext, d.decrypted_secret as plaintext
         from vault.secrets s
         join vault.decrypted_secrets d on d.id = s.id
         join public.gps_provider_credentials c on c.secret_ref = s.id
         where c.connection_id = '${gpsConnection}';`),
  )
  assert(secret, 'the secret was not found in Vault')
  assert(secret.plaintext === GPS_TOKEN, 'Vault did not return the token that was stored')
  assert(secret.ciphertext !== GPS_TOKEN, 'the token is stored in clear text')
  assert(!String(secret.ciphertext).includes(STAMP), 'the ciphertext contains the plaintext')
  return `${String(secret.ciphertext).length} bytes of ciphertext`
})

await check('no browser client of any role can reach the token', async () => {
  // The claim the whole module rests on, tested from where an attacker sits:
  // an authenticated Data API client, at the highest role the product has.
  for (const [label, c] of [
    ['owner', clientA],
    ['admin', gpsAdminClient],
    ['manager', gpsManagerClient],
    ['staff', gpsStaffClient],
  ]) {
    const pointer = await c.from('gps_provider_credentials').select('*')
    assert(pointer.error, `${label} read gps_provider_credentials`)

    for (const rpc of [
      'gps_read_credential',
      'gps_store_credential',
      'gps_claim_sync',
      'gps_disconnect_connection',
    ]) {
      const { error } = await c.rpc(rpc, { p_connection_id: gpsConnection })
      assert(error, `${label} called ${rpc}`)
    }

    // The vault schema is not among the schemas the Data API exposes, so this
    // fails at the router rather than at a policy — which is the stronger
    // failure, and worth asserting rather than assuming.
    const vault = await c.schema('vault').from('decrypted_secrets').select('*')
    assert(vault.error, `${label} read vault.decrypted_secrets`)
  }
  return 'four roles × six paths, all refused'
})

await check('the connection row a browser can read carries no credential', async () => {
  const { data, error } = await gpsAdminClient
    .from('gps_provider_connections')
    .select('*')
    .eq('id', gpsConnection)
    .single()
  assert(!error, error?.message)

  const serialised = JSON.stringify(data)
  assert(!serialised.includes(GPS_TOKEN), 'the token was in the connection row')
  assert(!serialised.includes(STAMP.slice(0, 4) + 'token'), 'something token-shaped was returned')
  for (const forbidden of ['token', 'secret', 'password', 'credential']) {
    assert(
      !Object.keys(data).some((key) => key.includes(forbidden)),
      `the connection row has a "${forbidden}" column`,
    )
  }
  return `${Object.keys(data).length} columns, none of them a secret`
})

await check('the anonymous role has no tracking access at all', async () => {
  const anon = client()
  for (const relation of [
    'gps_provider_connections',
    'gps_provider_credentials',
    'gps_units',
    'gps_unit_assignments',
    'gps_positions',
    'gps_sync_runs',
    'gps_fleet',
    'gps_unit_inventory',
  ]) {
    const { error } = await anon.from(relation).select('*').limit(1)
    assert(error, `${relation} returned data to anon`)
  }
  for (const rpc of [
    'gps_assign_unit',
    'gps_unassign_unit',
    'gps_attention_signals',
    'gps_resolve_tracked_vehicle',
    'gps_apply_sync',
    'gps_read_credential',
    'gps_store_credential',
    'gps_claim_sync',
    'gps_disconnect_connection',
  ]) {
    const { error } = await anon.rpc(rpc, {})
    assert(error, `${rpc} was callable by anon`)
  }
  return 'eight relations and nine functions all refused'
})

await check('the Edge Function refuses a request with no session', async () => {
  const response = await fetch(`${URL}/functions/v1/gps-provider`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      action: 'test',
      organizationId: orgA.id,
      baseUrl: 'https://hst-api.wialon.com',
      token: 'anything',
    }),
  })
  assert(response.status === 401, `expected 401, got ${response.status}`)
  const body = await response.json()
  assert(body.ok === false, 'the function reported success without a session')
  assert(!JSON.stringify(body).includes('anything'), 'the request token was echoed back')
  return `401 · ${body.error.category}`
})

await check('the Edge Function refuses another agency’s connection', async () => {
  // Agency B holds a valid session. The connection id belongs to agency A. The
  // answer must be the same as for an id that never existed — no confirmation
  // that the connection is real, and certainly no action taken on it.
  const { data: session } = await clientB.auth.getSession()
  const response = await fetch(`${URL}/functions/v1/gps-provider`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${session.session.access_token}`,
    },
    body: JSON.stringify({ action: 'refresh', connectionId: gpsConnection }),
  })
  assert(response.status === 404, `expected 404, got ${response.status}`)
  const body = await response.json()
  assert(body.error.category === 'not_found', `category was ${body.error.category}`)
  return 'a cross-tenant connection id is simply not found'
})

await check('the Edge Function refuses a manager the administration actions', async () => {
  const { data: session } = await gpsManagerClient.auth.getSession()
  const response = await fetch(`${URL}/functions/v1/gps-provider`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${session.session.access_token}`,
    },
    body: JSON.stringify({ action: 'disconnect', connectionId: gpsConnection }),
  })
  assert(response.status === 403, `expected 403, got ${response.status}`)
  const body = await response.json()
  assert(body.error.category === 'permission_denied', `category was ${body.error.category}`)

  // And the connection is untouched.
  const after = row(
    sql(
      `select disabled_at, generation from public.gps_provider_connections where id = '${gpsConnection}';`,
    ),
  )
  assert(after.disabled_at === null, 'a manager switched the connection off')
  return '403, and nothing changed'
})

await check('devices and positions arrive through the service-role path only', async () => {
  const units = sql(
    `insert into public.gps_units
       (organization_id, connection_id, external_id, name, device_uid, hardware, capabilities)
     values
       ('${orgA.id}', '${gpsConnection}', '400000000000001', 'Smoke tracker one ${STAMP}',
        '861234567890001', 'Teltonika FMB920', array['position','speed','heading','history']::text[]),
       ('${orgA.id}', '${gpsConnection}', '400000000000002', 'Smoke tracker two ${STAMP}',
        '861234567890002', 'Queclink GV55', array['position','history']::text[])
     returning id, external_id;`,
  )
  const created = rows(units)
  gpsUnitA = created.find((u) => u.external_id === '400000000000001').id
  gpsUnitB = created.find((u) => u.external_id === '400000000000002').id

  // A browser cannot do this, at any role. Devices come from the provider.
  const attempted = await gpsAdminClient.from('gps_units').insert({
    organization_id: orgA.id,
    connection_id: gpsConnection,
    external_id: 'forged',
    name: 'Forged device',
  })
  assert(attempted.error, 'an administrator inserted a device from the browser')

  const position = await gpsAdminClient.from('gps_positions').insert({
    unit_id: gpsUnitA,
    organization_id: orgA.id,
    observed_at: new Date().toISOString(),
  })
  assert(position.error, 'an administrator inserted a position from the browser')

  return 'two devices, and the browser cannot forge a third'
})

await check('a 64-bit provider identifier survives without losing precision', async () => {
  // Wialon unit ids exceed Number.MAX_SAFE_INTEGER. A column typed as a number
  // anywhere in this chain would silently round one, and the wrong car would
  // appear on the map from then on.
  const huge = '9007199254740993'
  const created = row(
    sql(`insert into public.gps_units (organization_id, connection_id, external_id, name)
         values ('${orgA.id}', '${gpsConnection}', '${huge}', 'Smoke precision ${STAMP}')
         returning id;`),
  )
  const { data } = await gpsAdminClient
    .from('gps_units')
    .select('external_id')
    .eq('id', created.id)
    .single()
  assert(data.external_id === huge, `identifier came back as ${data.external_id}`)
  assert(typeof data.external_id === 'string', 'the identifier arrived as a number')
  sql(`delete from public.gps_units where id = '${created.id}';`)
  return `${huge} intact`
})

await check('assigning a device to a vehicle is one atomic statement', async () => {
  const created = rows(
    sql(`insert into public.vehicles
           (organization_id, make, model, registration_plate, currency, daily_rate_minor)
         values
           ('${orgA.id}', 'Renault', 'Kangoo', 'GPS-${STAMP}-1', 'EUR', 4500),
           ('${orgA.id}', 'Peugeot', 'Partner', 'GPS-${STAMP}-2', 'EUR', 5200)
         returning id, registration_plate;`),
  ).sort((a, b) => a.registration_plate.localeCompare(b.registration_plate))
  gpsVehicle1 = created[0].id
  gpsVehicle2 = created[1].id

  const { data, error } = await gpsAdminClient.rpc('gps_assign_unit', {
    p_vehicle_id: gpsVehicle1,
    p_unit_id: gpsUnitA,
    p_note: `fitted for smoke ${STAMP}`,
  })
  assert(!error, `assignment failed: ${error?.message}`)
  gpsAssignment = data.id
  assert(data.unassigned_at === null, 'the new assignment was already closed')
  return `unit → ${created[0].registration_plate}`
})

await check('a manager may watch the map but may not move a device', async () => {
  const readable = await gpsManagerClient
    .from('gps_fleet')
    .select('*')
    .eq('organization_id', orgA.id)
  assert(!readable.error, `a manager could not read the fleet: ${readable.error?.message}`)
  assert(readable.data.length > 0, 'a manager saw no tracked vehicles')

  const moved = await gpsManagerClient.rpc('gps_assign_unit', {
    p_vehicle_id: gpsVehicle2,
    p_unit_id: gpsUnitB,
    p_note: null,
  })
  assert(moved.error, 'a manager assigned a device')

  const released = await gpsManagerClient.rpc('gps_unassign_unit', {
    p_assignment_id: gpsAssignment,
  })
  assert(released.error, 'a manager released a device')
  return 'reads the map, changes nothing'
})

await check('a member of staff sees no tracking at all', async () => {
  // A front-desk clerk does not need every car's position, and a vehicle's
  // location during an active rental is a customer's movements.
  for (const relation of [
    'gps_fleet',
    'gps_provider_connections',
    'gps_units',
    'gps_unit_assignments',
    'gps_positions',
    'gps_unit_inventory',
  ]) {
    const { data, error } = await gpsStaffClient.from(relation).select('*')
    assert(error || data.length === 0, `staff saw ${data?.length} rows of ${relation}`)
  }
  return 'six relations, nothing visible'
})

await check(
  'one device cannot be on two vehicles, and one vehicle cannot have two devices',
  async () => {
    const sameUnit = sql(
      `select case when exists (
       select 1 from public.gps_unit_assignments
       where unit_id = '${gpsUnitA}' and unassigned_at is null
     ) then 1 else 0 end as active;`,
    )
    assert(Number(row(sameUnit).active) === 1, 'the assignment did not take')

    // A raw second insert, bypassing the function that would have closed the
    // first. The partial unique indexes must refuse it.
    let refusedUnit = false
    try {
      sql(`insert into public.gps_unit_assignments (organization_id, vehicle_id, unit_id)
         values ('${orgA.id}', '${gpsVehicle2}', '${gpsUnitA}');`)
    } catch {
      refusedUnit = true
    }
    assert(refusedUnit, 'a device was assigned to two vehicles at once')

    let refusedVehicle = false
    try {
      sql(`insert into public.gps_unit_assignments (organization_id, vehicle_id, unit_id)
         values ('${orgA.id}', '${gpsVehicle1}', '${gpsUnitB}');`)
    } catch {
      refusedVehicle = true
    }
    assert(refusedVehicle, 'a vehicle was given two devices at once')
    return 'both directions refused at the index'
  },
)

await check('moving a device closes the old link and keeps it in the history', async () => {
  const { error } = await gpsAdminClient.rpc('gps_assign_unit', {
    p_vehicle_id: gpsVehicle2,
    p_unit_id: gpsUnitA,
    p_note: 'refitted',
  })
  assert(!error, `the move failed: ${error?.message}`)

  const history = rows(
    sql(`select vehicle_id, unassigned_at is null as active
         from public.gps_unit_assignments where unit_id = '${gpsUnitA}'
         order by assigned_at;`),
  )
  assert(history.length === 2, `expected 2 assignments in history, got ${history.length}`)
  const active = history.filter((h) => h.active === true || h.active === 't')
  assert(active.length === 1, `${active.length} assignments were active`)
  assert(active[0].vehicle_id === gpsVehicle2, 'the active assignment is on the wrong vehicle')

  // Put it back, so the rest of the section reads the vehicle it started on.
  await gpsAdminClient.rpc('gps_assign_unit', {
    p_vehicle_id: gpsVehicle1,
    p_unit_id: gpsUnitA,
    p_note: null,
  })
  return '2 assignments recorded, 1 active'
})

await check('a synchronisation writes positions and leaves unknowns null', async () => {
  const observed = new Date(Date.now() - 60_000).toISOString()
  const payload = JSON.stringify([
    {
      external_id: '400000000000001',
      name: `Smoke tracker one ${STAMP}`,
      capabilities: ['position', 'speed', 'heading', 'history'],
      position: {
        observed_at: observed,
        latitude: 33.589886,
        longitude: -7.603869,
        position_valid: true,
        speed_kph: 46,
        heading_deg: 92,
      },
    },
    {
      // Reports a position and nothing else. Every other field must stay NULL.
      external_id: '400000000000002',
      name: `Smoke tracker two ${STAMP}`,
      capabilities: ['position', 'history'],
      position: { observed_at: observed, latitude: 33.5, longitude: -7.6, position_valid: true },
    },
  ]).replace(/'/g, "''")

  const applied = row(
    sql(`select public.gps_apply_sync(
           '${gpsConnection}', ${gpsGeneration()}, '${payload}'::jsonb, 'success'::public.gps_sync_outcome,
           now(), true, 'Smoke Account', null, null, '${gpsAdminId}'
         ) as result;`),
  )
  assert(Number(applied.result.positions) === 2, `wrote ${applied.result.positions} positions`)

  const stored = rows(
    sql(`select u.external_id, p.speed_kph, p.ignition, p.odometer_km, p.movement
         from public.gps_positions p join public.gps_units u on u.id = p.unit_id
         where u.connection_id = '${gpsConnection}' order by u.external_id;`),
  )
  const bare = stored.find((s) => s.external_id === '400000000000002')
  assert(bare.speed_kph === null, `an unreported speed became ${bare.speed_kph}`)
  assert(bare.ignition === null, `an unreported ignition became ${bare.ignition}`)
  assert(bare.odometer_km === null, `an unreported odometer became ${bare.odometer_km}`)
  assert(bare.movement === null, `an unreported movement became ${bare.movement}`)
  return 'unknown stayed unknown in four columns'
})

await check('an older observation cannot overwrite a newer one', async () => {
  // The single most damaging bug a telematics integration can have: a provider
  // answering out of order, and the map walking backwards through last week.
  const newer = new Date(Date.now() - 30_000).toISOString()
  const older = new Date(Date.now() - 3_600_000).toISOString()

  const apply = (observedAt, latitude) => {
    const payload = JSON.stringify([
      {
        external_id: '400000000000001',
        name: 'ignored',
        capabilities: ['position'],
        position: { observed_at: observedAt, latitude, longitude: -7.6, position_valid: true },
      },
    ]).replace(/'/g, "''")
    sql(`select public.gps_apply_sync('${gpsConnection}', ${gpsGeneration()}, '${payload}'::jsonb,
         'success'::public.gps_sync_outcome, now(), false, null, null, null, null);`)
  }

  apply(newer, 34.1)
  apply(older, 30.0)

  const stored = row(
    sql(`select p.observed_at, p.latitude from public.gps_positions p
         join public.gps_units u on u.id = p.unit_id
         where u.external_id = '400000000000001' and u.connection_id = '${gpsConnection}';`),
  )
  assert(
    Math.abs(Number(stored.latitude) - 34.1) < 0.0001,
    `the older observation won: latitude is ${stored.latitude}`,
  )
  return 'T1 did not replace T2'
})

await check('a position from the future is flagged rather than treated as current', async () => {
  const future = new Date(Date.now() + 20 * 60_000).toISOString()
  const payload = JSON.stringify([
    {
      external_id: '400000000000002',
      name: 'ignored',
      capabilities: ['position'],
      position: { observed_at: future, latitude: 33.51, longitude: -7.61, position_valid: true },
    },
  ]).replace(/'/g, "''")
  sql(`select public.gps_apply_sync('${gpsConnection}', ${gpsGeneration()}, '${payload}'::jsonb,
       'success'::public.gps_sync_outcome, now(), false, null, null, null, null);`)

  const { data } = await gpsAdminClient
    .from('gps_fleet')
    .select('vehicle_id, position_freshness')
    .eq('organization_id', orgA.id)

  const flagged = rows(
    sql(`select case
           when p.observed_at > now() + interval '2 minutes' then 'future' else 'not future'
         end as state
         from public.gps_positions p join public.gps_units u on u.id = p.unit_id
         where u.external_id = '400000000000002' and u.connection_id = '${gpsConnection}';`),
  )
  assert(flagged[0].state === 'future', 'a future timestamp was accepted as current')
  assert(Array.isArray(data), 'the fleet view was unreadable')
  return 'clock skew flagged, not accepted'
})

await check('the three facts are three columns, not one', async () => {
  const { data, error } = await gpsAdminClient
    .from('gps_fleet')
    .select('vehicle_plate, provider_online, position_freshness, sync_health, position_age_seconds')
    .eq('organization_id', orgA.id)
    .eq('vehicle_id', gpsVehicle1)
    .single()
  assert(!error, error?.message)

  assert('provider_online' in data, 'the fleet view has no provider connectivity')
  assert('position_freshness' in data, 'the fleet view has no position freshness')
  assert('sync_health' in data, 'the fleet view has no sync health')
  // The device in this fixture reported no connection state, so connectivity
  // must be unknown rather than false.
  assert(data.provider_online === null, `connectivity was ${data.provider_online}, expected null`)
  return `${data.position_freshness} · link unknown · ${data.sync_health}`
})

await check('the fleet read model carries no customer identity', async () => {
  const { data } = await gpsAdminClient
    .from('gps_fleet')
    .select('*')
    .eq('organization_id', orgA.id)
    .limit(1)
    .single()

  for (const forbidden of [
    'customer_name',
    'customer_id',
    'first_name',
    'last_name',
    'driver_name',
    'email',
    'phone',
    'national_id',
  ]) {
    assert(!(forbidden in data), `the fleet view exposes ${forbidden}`)
  }
  assert('current_rental_id' in data, 'the fleet view lost its rental context')
  return `${Object.keys(data).length} columns, none of them a person`
})

await check('a superseded credential cannot report the connection healthy', async () => {
  // Rotating the token bumps a generation counter. A synchronisation that
  // started before the rotation must not land as a success afterwards, or an
  // agency would see "connected" while its map quietly stopped updating.
  const before = Number(
    row(
      sql(`select generation from public.gps_provider_connections where id = '${gpsConnection}';`),
    ).generation,
  )

  sql(
    `select public.gps_store_credential('${gpsConnection}', '${GPS_TOKEN}-rotated', null, null, '${gpsAdminId}');`,
  )

  const after = Number(
    row(
      sql(`select generation from public.gps_provider_connections where id = '${gpsConnection}';`),
    ).generation,
  )
  assert(after > before, `generation did not advance: ${before} → ${after}`)

  const stale = row(
    sql(`select public.gps_apply_sync('${gpsConnection}', ${before}, '[]'::jsonb,
         'success'::public.gps_sync_outcome, now(), false, null, null, null, null) as result;`),
  )
  assert(stale.result.applied === false, 'a superseded synchronisation was applied')

  const status = row(
    sql(`select status from public.gps_provider_connections where id = '${gpsConnection}';`),
  )
  assert(status.status !== 'healthy', `a rotated connection reports ${status.status}`)
  return `generation ${before} → ${after}, stale sync refused`
})

await check('the new token replaced the old one in Vault rather than adding a second', async () => {
  const secrets = rows(
    sql(`select d.decrypted_secret as plaintext
         from vault.decrypted_secrets d
         join public.gps_provider_credentials c on c.secret_ref = d.id
         where c.connection_id = '${gpsConnection}';`),
  )
  assert(secrets.length === 1, `${secrets.length} secrets are stored for one connection`)
  assert(secrets[0].plaintext === `${GPS_TOKEN}-rotated`, 'the rotated token was not stored')
  return 'one secret, rotated in place'
})

await check('a refresh is coalesced across tabs by a server-side lease', async () => {
  // Five people watching the same map must not be five times the provider
  // traffic for the same answer.
  const claims = []
  for (let attempt = 0; attempt < 5; attempt += 1) {
    claims.push(
      row(sql(`select public.gps_claim_sync('${gpsConnection}', 30) as claimed;`)).claimed,
    )
  }
  const granted = claims.filter((c) => c === true || c === 't').length
  assert(granted === 1, `${granted} of 5 concurrent refreshes reached the provider`)
  return '5 tabs → 1 provider call'
})

await check('a vehicle resolves to a device server-side, and only for its own agency', async () => {
  // The browser asks for history by vehicle. Nothing accepts a device id from a
  // request, so no amount of guessing reaches somebody else's tracker.
  const mine = await gpsManagerClient.rpc('gps_resolve_tracked_vehicle', {
    p_vehicle_id: gpsVehicle1,
  })
  assert(!mine.error, mine.error?.message)
  assert(mine.data.length === 1, `resolution returned ${mine.data.length} rows`)
  assert(mine.data[0].unit_external_id === '400000000000001', 'the wrong device was resolved')

  const theirs = await clientB.rpc('gps_resolve_tracked_vehicle', { p_vehicle_id: gpsVehicle1 })
  assert(!theirs.error || theirs.data === null, 'the call errored in an unexpected way')
  assert((theirs.data ?? []).length === 0, 'another agency resolved our vehicle to our device')

  const staff = await gpsStaffClient.rpc('gps_resolve_tracked_vehicle', {
    p_vehicle_id: gpsVehicle1,
  })
  assert((staff.data ?? []).length === 0, 'staff resolved a vehicle to a device')
  return 'resolves for a manager, empty for everybody else'
})

await check('agency B sees none of agency A’s tracking', async () => {
  for (const relation of [
    'gps_provider_connections',
    'gps_units',
    'gps_unit_assignments',
    'gps_positions',
    'gps_fleet',
    'gps_unit_inventory',
    'gps_sync_runs',
  ]) {
    const { data } = await clientB.from(relation).select('*').eq('organization_id', orgA.id)
    assert((data ?? []).length === 0, `B saw ${data.length} rows of ${relation}`)
  }

  const assigned = await clientB.rpc('gps_assign_unit', {
    p_vehicle_id: gpsVehicle1,
    p_unit_id: gpsUnitA,
    p_note: null,
  })
  assert(assigned.error, 'B assigned a device on A’s fleet')

  const signals = await clientB.rpc('gps_attention_signals', { p_organization_id: orgA.id })
  assert((signals.data ?? []).length === 0, 'B read A’s attention signals')
  return 'seven relations and two functions, all empty or refused'
})

await check('tracking never writes to the vehicle’s recorded mileage', async () => {
  const before = row(
    sql(`select odometer from public.vehicles where id = '${gpsVehicle1}';`),
  ).odometer

  const payload = JSON.stringify([
    {
      external_id: '400000000000001',
      name: 'ignored',
      capabilities: ['position', 'odometer'],
      position: {
        observed_at: new Date().toISOString(),
        latitude: 33.6,
        longitude: -7.62,
        position_valid: true,
        odometer_km: 987654,
      },
    },
  ]).replace(/'/g, "''")
  sql(
    `select public.gps_apply_sync('${gpsConnection}', ${Number(
      row(
        sql(
          `select generation from public.gps_provider_connections where id = '${gpsConnection}';`,
        ),
      ).generation,
    )}, '${payload}'::jsonb, 'success'::public.gps_sync_outcome, now(), false, null, null, null, null);`,
  )

  const after = row(
    sql(`select odometer from public.vehicles where id = '${gpsVehicle1}';`),
  ).odometer
  assert(String(after) === String(before), `the vehicle odometer changed: ${before} → ${after}`)

  const device = row(
    sql(`select p.odometer_km from public.gps_positions p join public.gps_units u on u.id = p.unit_id
         where u.external_id = '400000000000001' and u.connection_id = '${gpsConnection}';`),
  )
  assert(Number(device.odometer_km) === 987654, 'the device odometer was not recorded')
  return `device reads 987,654 km; the vehicle still reads ${before ?? 'null'}`
})

await check('tracking creates no expense and no rental movement', async () => {
  const counts = row(
    sql(`select
           (select count(*) from public.expenses
            where organization_id = '${orgA.id}' and source::text <> 'manual'
              and created_at > now() - interval '10 minutes') as auto_expenses,
           (select count(*) from public.rentals
            where organization_id = '${orgA.id}' and updated_at > now() - interval '2 minutes') as touched_rentals;`),
  )
  assert(
    Number(counts.auto_expenses) === 0,
    `${counts.auto_expenses} expenses appeared from telemetry`,
  )
  assert(Number(counts.touched_rentals) === 0, `${counts.touched_rentals} rentals were touched`)
  return 'no expense, no lifecycle change'
})

await check('a device that vanishes is marked missing, not deleted', async () => {
  // The full-inventory path only. A position refresh that happens to answer
  // with fewer devices must never mark hardware missing.
  const generation = Number(
    row(
      sql(`select generation from public.gps_provider_connections where id = '${gpsConnection}';`),
    ).generation,
  )
  const payload = JSON.stringify([
    {
      external_id: '400000000000001',
      name: `Smoke tracker one ${STAMP}`,
      capabilities: ['position'],
      position: {
        observed_at: new Date().toISOString(),
        latitude: 33.6,
        longitude: -7.62,
        position_valid: true,
      },
    },
  ]).replace(/'/g, "''")

  sql(`select public.gps_apply_sync('${gpsConnection}', ${generation}, '${payload}'::jsonb,
       'success'::public.gps_sync_outcome, now(), false, null, null, null, null);`)
  const afterRefresh = row(
    sql(`select availability from public.gps_units where id = '${gpsUnitB}';`),
  )
  assert(afterRefresh.availability === 'present', 'a refresh marked a device missing')

  sql(`select public.gps_apply_sync('${gpsConnection}', ${generation}, '${payload}'::jsonb,
       'success'::public.gps_sync_outcome, now(), true, null, null, null, null);`)
  const afterSync = row(
    sql(`select availability, missing_since is not null as dated
         from public.gps_units where id = '${gpsUnitB}';`),
  )
  assert(afterSync.availability === 'missing', `availability is ${afterSync.availability}`)
  assert(afterSync.dated === true || afterSync.dated === 't', 'missing_since was not recorded')

  const stillThere = row(
    sql(`select count(*)::int as n from public.gps_units where id = '${gpsUnitB}';`),
  )
  assert(stillThere.n === 1, 'the device row was deleted rather than marked')
  return 'refresh kept it, full sync marked it missing'
})

await check('the synchronisation log is bounded rather than an archive', async () => {
  const before = Number(
    row(
      sql(
        `select count(*)::int as n from public.gps_sync_runs where connection_id = '${gpsConnection}';`,
      ),
    ).n,
  )
  assert(before <= 50, `${before} runs are already retained`)

  sql(`insert into public.gps_sync_runs (organization_id, connection_id, started_at, outcome)
       select '${orgA.id}', '${gpsConnection}', now() - (n || ' minutes')::interval, 'success'
       from generate_series(1, 70) as n;`)

  const after = Number(
    row(
      sql(
        `select count(*)::int as n from public.gps_sync_runs where connection_id = '${gpsConnection}';`,
      ),
    ).n,
  )
  assert(after <= 50, `${after} runs were retained; the trigger did not trim`)
  return `70 more inserted, ${after} retained`
})

await check('the workspace surfaces what needs attention without inventing urgency', async () => {
  const { data, error } = await gpsAdminClient.rpc('gps_attention_signals', {
    p_organization_id: orgA.id,
  })
  assert(!error, error?.message)
  assert(Array.isArray(data), 'no signals were returned')
  for (const signal of data) {
    assert(
      ['connection_unhealthy', 'position_stale', 'no_position', 'device_missing'].includes(
        signal.signal,
      ),
      `unknown signal ${signal.signal}`,
    )
    assert(
      ['info', 'warning', 'critical'].includes(signal.severity),
      `unknown severity ${signal.severity}`,
    )
    assert(
      typeof signal.detail === 'string' && signal.detail.length > 0,
      'a signal had no explanation',
    )
  }
  return `${data.length} signals, every one explained`
})

await check(
  'switching a provider off keeps the fleet’s history and destroys the secret',
  async () => {
    sql(`select public.gps_disconnect_connection('${gpsConnection}', '${gpsAdminId}');`)

    const connection = row(
      sql(`select status, disabled_at is not null as off from public.gps_provider_connections
         where id = '${gpsConnection}';`),
    )
    assert(connection.status === 'disabled', `status is ${connection.status}`)
    assert(connection.off === true || connection.off === 't', 'the connection was not switched off')

    const credential = row(
      sql(
        `select count(*)::int as n from public.gps_provider_credentials where connection_id = '${gpsConnection}';`,
      ),
    )
    assert(credential.n === 0, 'the credential pointer survived a disconnect')

    const orphaned = row(
      sql(`select count(*)::int as n from vault.decrypted_secrets
         where name = 'gps_provider_${gpsConnection}';`),
    )
    assert(orphaned.n === 0, `${orphaned.n} vault secrets were left behind`)

    const kept = row(
      sql(`select
           (select count(*)::int from public.gps_units where connection_id = '${gpsConnection}') as units,
           (select count(*)::int from public.gps_unit_assignments where organization_id = '${orgA.id}') as assignments;`),
    )
    assert(kept.units > 0, 'devices were destroyed by a disconnect')
    assert(kept.assignments > 0, 'assignment history was destroyed by a disconnect')

    const refused = row(
      sql(
        `select public.gps_apply_sync('${gpsConnection}', ${Number(
          row(
            sql(
              `select generation from public.gps_provider_connections where id = '${gpsConnection}';`,
            ),
          ).generation,
        )}, '[]'::jsonb, 'success'::public.gps_sync_outcome, now(), false, null, null, null, null) as result;`,
      ),
    )
    assert(refused.result.applied === false, 'a disabled connection accepted a synchronisation')
    return 'secret destroyed, history kept, sync refused'
  },
)

await check('two administrators assigning the same device: exactly one wins', async () => {
  /*
   * Not a sequential pair of writes — genuinely concurrent, from two signed-in
   * clients. `gps_assign_unit` closes the old links and opens the new one inside
   * one transaction, and a partial unique index is the backstop underneath it.
   * Without both, the loser's insert would leave one tracker attributed to two
   * vehicles, and every position it reported afterwards would be wrong for one
   * of them.
   */
  const [free] = rows(
    sql(`insert into public.vehicles
           (organization_id, make, model, registration_plate, currency, daily_rate_minor)
         values ('${orgA.id}', 'Fiat', 'Doblo', 'RACE-${STAMP}-1', 'EUR', 4000)
         returning id;`),
  )
  const [second] = rows(
    sql(`insert into public.vehicles
           (organization_id, make, model, registration_plate, currency, daily_rate_minor)
         values ('${orgA.id}', 'Fiat', 'Doblo', 'RACE-${STAMP}-2', 'EUR', 4000)
         returning id;`),
  )

  const outcomes = await Promise.all([
    gpsAdminClient.rpc('gps_assign_unit', {
      p_vehicle_id: free.id,
      p_unit_id: gpsUnitB,
      p_note: 'race A',
    }),
    clientA.rpc('gps_assign_unit', {
      p_vehicle_id: second.id,
      p_unit_id: gpsUnitB,
      p_note: 'race B',
    }),
  ])

  const active = row(
    sql(`select count(*)::int as n from public.gps_unit_assignments
         where unit_id = '${gpsUnitB}' and unassigned_at is null;`),
  )
  assert(active.n === 1, `${active.n} assignments are active for one device`)

  // Both calls may report success — the second legitimately supersedes the
  // first, because moving a tracker is a real operation. What must never happen
  // is two live assignments, and that is what the index guarantees.
  const succeeded = outcomes.filter((result) => !result.error).length
  sql(`delete from public.gps_unit_assignments where unit_id = '${gpsUnitB}';`)
  sql(`delete from public.vehicles where id in ('${free.id}', '${second.id}');`)
  return `${succeeded} of 2 calls returned, exactly 1 assignment live`
})

await check(
  'a credential rotated mid-flight invalidates the synchronisation in progress',
  async () => {
    /*
     * A sync reads the generation when it starts and hands it back when it
     * finishes. If the credential is replaced in between, the answer it is
     * carrying came from a token the agency has since revoked — reporting that as
     * a healthy sync would leave the interface claiming a connection works while
     * the map silently stopped updating.
     */
    const started = gpsGeneration()
    sql(
      `select public.gps_store_credential('${gpsConnection}', '${GPS_TOKEN}-midflight', null, null, '${gpsAdminId}');`,
    )

    const late = row(
      sql(`select public.gps_apply_sync('${gpsConnection}', ${started}, '[]'::jsonb,
         'success'::public.gps_sync_outcome, now(), false, null, null, null, null) as result;`),
    )
    assert(late.result.applied === false, 'a sync from before the rotation was applied')
    assert(late.result.reason === 'superseded', `reason was ${late.result.reason}`)

    const status = row(
      sql(`select status from public.gps_provider_connections where id = '${gpsConnection}';`),
    )
    assert(status.status !== 'healthy', `the connection reports ${status.status} after a rotation`)
    return `generation ${started} → ${gpsGeneration()}, in-flight sync discarded`
  },
)

await check('assignment history outlives an attempt to erase the connection', async () => {
  /*
   * `gps_unit_assignments` references `gps_units` ON DELETE RESTRICT, so a
   * connection whose devices have ever been fitted to a vehicle cannot simply be
   * deleted — the record of which tracker was on which car in March survives.
   * Switching the provider off is the supported operation, and it keeps
   * everything; this proves the destructive path is genuinely closed rather than
   * merely absent from the interface.
   */
  let refused = false
  try {
    sql(`delete from public.gps_provider_connections where id = '${gpsConnection}';`)
  } catch {
    refused = true
  }
  assert(refused, 'a connection with assignment history was deleted outright')

  const history = row(
    sql(`select count(*)::int as n from public.gps_unit_assignments
         where organization_id = '${orgA.id}';`),
  )
  assert(history.n > 0, 'the assignment history is gone')
  return `${history.n} assignments protected the connection from deletion`
})

await check(
  'once the history is released, the connection and its devices go together',
  async () => {
    sql(`delete from public.gps_unit_assignments where organization_id = '${orgA.id}';`)
    sql(`delete from public.gps_provider_connections where id = '${gpsConnection}';`)

    const cascaded = row(
      sql(`select
           (select count(*)::int from public.gps_units where connection_id = '${gpsConnection}') as units,
           (select count(*)::int from public.gps_sync_runs where connection_id = '${gpsConnection}') as runs,
           (select count(*)::int from public.gps_provider_credentials where connection_id = '${gpsConnection}') as credentials;`),
    )
    assert(cascaded.units === 0, `${cascaded.units} devices outlived their connection`)
    assert(cascaded.runs === 0, `${cascaded.runs} sync runs outlived their connection`)
    assert(cascaded.credentials === 0, 'a credential pointer outlived its connection')

    sql(`delete from public.vehicles where id in ('${gpsVehicle1}', '${gpsVehicle2}');`)
    return 'connection, devices, positions and log all removed'
  },
)

/** Every report entry point, with arguments a caller could plausibly send. */
function REPORT_CALLS(organizationId) {
  const period = { p_from: '2033-04-01', p_to: '2033-05-01' }
  return [
    ['report_business_summary', { p_organization_id: organizationId, ...period }],
    ['report_position_summary', { p_organization_id: organizationId }],
    [
      'report_financial_series',
      { p_organization_id: organizationId, ...period, p_granularity: 'day', p_currency: 'EUR' },
    ],
    ['report_fleet_performance', { p_organization_id: organizationId, ...period }],
    [
      'report_utilisation_series',
      { p_organization_id: organizationId, ...period, p_granularity: 'day' },
    ],
    [
      'report_expense_breakdown',
      { p_organization_id: organizationId, ...period, p_dimension: 'category' },
    ],
    ['report_rental_operations', { p_organization_id: organizationId, ...period }],
    ['report_rental_values', { p_organization_id: organizationId, ...period }],
    ['report_customer_cohorts', { p_organization_id: organizationId, ...period }],
    [
      'report_customer_balances',
      { p_organization_id: organizationId, p_currency: null, p_limit: 25, p_offset: 0 },
    ],
    ['report_customer_revenue', { p_organization_id: organizationId, ...period, p_limit: 10 }],
    ['report_financing_position', { p_organization_id: organizationId }],
    ['report_gps_coverage', { p_organization_id: organizationId }],
    ['report_compliance_summary', { p_organization_id: organizationId, p_lead_days: null }],
  ]
}

// ------------------------------------------------------------- reports / analytics
//
// Reports is a read layer over every other domain, so the things a wrong answer
// costs here are the things every other module already got right:
//
//   a deposit counted as revenue, a voided record counted anywhere, financing
//   principal counted as an operating cost, one expense counted twice, two
//   currencies added together, an expense filed by the day it was typed in, a
//   rental counted whole in two periods, an unknown printed as a zero, and one
//   agency's economics visible to another.
//
// Everything below runs against the real project: real PostgREST, real RLS, real
// aggregate functions. Where a figure also exists in an older read model, the
// check asserts the two AGREE — a Reports number that quietly disagrees with the
// dashboard is worse than no Reports number at all.

let rptOrg, rptOwnerClient, rptManagerId, rptManagerClient, rptStaffId, rptStaffClient
let rptVehicleA, rptVehicleB, rptVehicleIdle, rptCustomerA, rptCustomerB
let rptRentalPaid, rptRentalSpanning, rptRentalCancelled
let rptAgreement, rptLender
const RPT_FROM = '2033-04-01'
const RPT_TO = '2033-05-01'

function rptRow(out) {
  return (out.result ?? out.rows ?? [])[0]
}
function rptRows(out) {
  return out.result ?? out.rows ?? []
}

/** One report, read the way the browser reads it. */
async function report(name, args, asClient = rptOwnerClient) {
  const { data, error } = await asClient.rpc(name, args)
  assert(!error, `${name} failed: ${error?.message}`)
  return data ?? []
}

function inCurrency(rows, currency) {
  const row = rows.find((entry) => entry.currency === currency)
  assert(row, `no ${currency} row in ${JSON.stringify(rows.map((r) => r.currency))}`)
  return row
}

await check('a reporting agency exists with a manager and a member of staff', async () => {
  // Reports is a manager's permission. All three roles are needed to prove the
  // boundary rather than assume it.
  rptOrg = orgA.id
  rptOwnerClient = clientA

  const manager = { email: `smoke-rpt-mgr-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
  const staff = { email: `smoke-rpt-stf-${STAMP}@atlasloca.com`, password: 'SmokeTest!2026' }
  rptManagerId = seedConfirmedUser(manager, { full_name: 'Smoke Report Manager' })
  rptStaffId = seedConfirmedUser(staff, { full_name: 'Smoke Report Staff' })

  sql(
    `insert into public.organization_members (organization_id, user_id, role, status) values
       ('${rptOrg}', '${rptManagerId}', 'manager', 'active'),
       ('${rptOrg}', '${rptStaffId}', 'staff', 'active');`,
  )

  rptManagerClient = (await signInTestUser(client, manager)).client
  rptStaffClient = (await signInTestUser(client, staff)).client
  return 'owner + manager + staff signed in'
})

await check('a reporting fixture is written across a period boundary', async () => {
  const vehicles = rptRows(
    sql(`insert into public.vehicles
           (organization_id, make, model, registration_plate, currency, daily_rate_minor,
            acquired_on, insurance_expires_on)
         values
           ('${rptOrg}', 'Renault', 'Clio',  'RPT-${STAMP}-1', 'EUR', 4500, '2030-01-01', '2033-04-15'),
           ('${rptOrg}', 'Peugeot', '208',   'RPT-${STAMP}-2', 'EUR', 5000, '2030-01-01', null),
           ('${rptOrg}', 'Toyota',  'Yaris', 'RPT-${STAMP}-3', 'EUR', 4000, '2030-01-01', null)
         returning id, registration_plate;`),
  ).sort((a, b) => a.registration_plate.localeCompare(b.registration_plate))
  rptVehicleA = vehicles[0].id
  rptVehicleB = vehicles[1].id
  rptVehicleIdle = vehicles[2].id

  const customers = rptRows(
    sql(`insert into public.customers (organization_id, first_name, last_name)
         values ('${rptOrg}', 'Report', 'Alpha'), ('${rptOrg}', 'Report', 'Beta')
         returning id, last_name;`),
  )
  rptCustomerA = customers.find((c) => c.last_name === 'Alpha').id
  rptCustomerB = customers.find((c) => c.last_name === 'Beta').id

  // A hire paid in full inside April; a hire spanning the March/April boundary;
  // a booking confirmed then cancelled inside April.
  rptRentalPaid = rptRow(
    sql(`insert into public.rentals
           (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
            currency, daily_rate_minor, subtotal_minor, total_minor,
            confirmed_at, picked_up_at, returned_at, completed_at, pickup_odometer, return_odometer)
         values ('${rptOrg}', '${rptVehicleA}', '${rptCustomerA}', 'RPT-${STAMP}-A', 'completed',
                 '2033-04-05T09:00:00Z', '2033-04-10T09:00:00Z', 'EUR', 4500, 60000, 60000,
                 '2033-04-01T09:00:00Z', '2033-04-05T09:30:00Z', '2033-04-10T08:30:00Z',
                 '2033-04-10T10:00:00Z', 10000, 10850)
         returning id;`),
  ).id

  rptRentalSpanning = rptRow(
    sql(`insert into public.rentals
           (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
            currency, daily_rate_minor, subtotal_minor, total_minor, completed_at)
         values ('${rptOrg}', '${rptVehicleB}', '${rptCustomerB}', 'RPT-${STAMP}-B', 'completed',
                 '2033-03-29T00:00:00Z', '2033-04-04T00:00:00Z', 'EUR', 5000, 30000, 30000,
                 '2033-04-04T01:00:00Z')
         returning id;`),
  ).id

  rptRentalCancelled = rptRow(
    sql(`insert into public.rentals
           (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
            currency, daily_rate_minor, subtotal_minor, total_minor, confirmed_at, cancelled_at)
         values ('${rptOrg}', '${rptVehicleA}', '${rptCustomerB}', 'RPT-${STAMP}-C', 'cancelled',
                 '2033-04-20T09:00:00Z', '2033-04-22T09:00:00Z', 'EUR', 4500, 20000, 20000,
                 '2033-04-12T09:00:00Z', '2033-04-15T09:00:00Z')
         returning id;`),
  ).id

  return '3 vehicles, 2 customers, 3 contracts'
})

await check('payments are recorded: charges, a refund, a deposit and a voided entry', async () => {
  sql(`insert into public.payments
         (organization_id, rental_id, customer_id, amount_minor, currency, purpose, direction, paid_at, voided_at)
       values
         ('${rptOrg}', '${rptRentalPaid}', '${rptCustomerA}', 60000, 'EUR', 'rental_charge', 'inbound', '2033-04-10T10:00:00Z', null),
         ('${rptOrg}', '${rptRentalSpanning}', '${rptCustomerB}', 30000, 'EUR', 'rental_charge', 'inbound', '2033-04-04T01:00:00Z', null),
         ('${rptOrg}', '${rptRentalPaid}', '${rptCustomerA}',  5000, 'EUR', 'rental_charge', 'outbound', '2033-04-20T10:00:00Z', null),
         ('${rptOrg}', '${rptRentalPaid}', '${rptCustomerA}', 30000, 'EUR', 'deposit', 'inbound', '2033-04-05T09:00:00Z', null),
         ('${rptOrg}', '${rptRentalPaid}', '${rptCustomerA}', 30000, 'EUR', 'deposit', 'outbound', '2033-04-10T11:00:00Z', null),
         ('${rptOrg}', '${rptRentalPaid}', '${rptCustomerA}', 99999, 'EUR', 'rental_charge', 'inbound', '2033-04-11T10:00:00Z', now()),
         ('${rptOrg}', '${rptRentalCancelled}', '${rptCustomerB}', 4000, 'EUR', 'rental_charge', 'inbound', '2033-04-12T10:00:00Z', null);`)
  return '7 payments, one of them voided'
})

await check(
  'costs are recorded: overhead, vehicle-direct, rental-direct, voided, and one in March',
  async () => {
    const category = rptRow(
      sql(`select id from public.expense_categories where organization_id = '${rptOrg}'
         order by case when name = 'Fuel' then 0 else 1 end, name limit 1;`),
    ).id

    sql(`insert into public.expenses
         (organization_id, category_id, allocation, status, amount_minor, tax_amount_minor,
          currency, incurred_on, vehicle_id, rental_id, voided_at)
       values
         ('${rptOrg}', '${category}', 'overhead', 'recorded', 10000, 0,    'EUR', '2033-04-03', null, null, null),
         ('${rptOrg}', '${category}', 'vehicle',  'recorded',  8000, 1333, 'EUR', '2033-04-06', '${rptVehicleA}', null, null),
         ('${rptOrg}', '${category}', 'rental',   'recorded',  4000, 0,    'EUR', '2033-04-08', null, '${rptRentalPaid}', null),
         ('${rptOrg}', '${category}', 'overhead', 'voided',   50000, 0,    'EUR', '2033-04-09', null, null, now()),
         ('${rptOrg}', '${category}', 'overhead', 'recorded',  7000, 0,    'EUR', '2033-03-31', null, null, null);`)
    return '5 costs, one voided, one dated in March'
  },
)

await check('financing is recorded: principal, interest, a fee and an unstated split', async () => {
  rptLender = rptRow(
    sql(
      `insert into public.lenders (organization_id, name) values ('${rptOrg}', 'Report Bank ${STAMP}') returning id;`,
    ),
  ).id

  rptAgreement = rptRow(
    sql(`insert into public.financing_agreements
           (organization_id, vehicle_id, lender_id, agreement_type, mode, currency, reference,
            financed_amount_minor, rate_bps, installments_count, payment_frequency,
            first_payment_on, schedule_anchor_day, starts_on, agreement_status, activated_at)
         values ('${rptOrg}', '${rptVehicleA}', '${rptLender}', 'loan', 'amortizing', 'EUR',
                 'RPT-FIN-${STAMP}', 1000000, 600, 12, 'monthly', '2033-04-01', 1, '2033-04-01',
                 'active', now())
         returning id;`),
  ).id

  sql(`insert into public.financing_payments
         (organization_id, agreement_id, paid_on, currency, amount_minor,
          principal_minor, interest_minor, fees_minor, unallocated_minor)
       values
         ('${rptOrg}', '${rptAgreement}', '2033-04-05', 'EUR', 500000, 500000, 0, 0, 0),
         ('${rptOrg}', '${rptAgreement}', '2033-04-06', 'EUR',  50000, 0, 50000, 0, 0),
         ('${rptOrg}', '${rptAgreement}', '2033-04-07', 'EUR',   1500, 0, 0, 1500, 0);`)
  return 'principal 5,000 · interest 500 · fee 15'
})

await check('revenue is rental-charge cash, net of refunds', async () => {
  const eur = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  // 60,000 + 30,000 + 4,000 in; 5,000 back out. The voided 99,999 is absent.
  assert(
    Number(eur.rental_charges_in_minor) === 94000,
    `charges were ${eur.rental_charges_in_minor}`,
  )
  assert(
    Number(eur.rental_refunds_out_minor) === 5000,
    `refunds were ${eur.rental_refunds_out_minor}`,
  )
  assert(Number(eur.rental_revenue_minor) === 89000, `revenue was ${eur.rental_revenue_minor}`)
  return '94,000 in less 5,000 out = 89,000'
})

await check('a deposit is never revenue, in either direction', async () => {
  const eur = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  assert(Number(eur.deposit_in_minor) === 30000, `deposit in was ${eur.deposit_in_minor}`)
  assert(Number(eur.deposit_out_minor) === 30000, `deposit out was ${eur.deposit_out_minor}`)
  // The customer's money passed through and touched nothing.
  assert(Number(eur.rental_revenue_minor) === 89000, 'a deposit moved revenue')
  return '300 in and 300 out, revenue unmoved'
})

await check('a voided payment and a voided cost count nowhere', async () => {
  const eur = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  assert(Number(eur.rental_payment_count) === 4, `${eur.rental_payment_count} payments counted`)
  assert(
    Number(eur.operating_expense_minor) === 22000,
    `expenses were ${eur.operating_expense_minor}`,
  )
  assert(Number(eur.expense_count) === 3, `${eur.expense_count} costs counted`)
  return '4 payments and 3 costs; the two voided rows are absent'
})

await check('a cost is filed by the day it happened, not the day it was entered', async () => {
  const april = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  const march = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: '2033-03-01',
      p_to: '2033-04-01',
    }),
    'EUR',
  )
  assert(
    Number(april.operating_expense_minor) === 22000,
    `April was ${april.operating_expense_minor}`,
  )
  assert(
    Number(march.operating_expense_minor) === 7000,
    `March was ${march.operating_expense_minor}`,
  )
  return '70 belongs to March even though every row was entered today'
})

await check('the operating result is revenue less recorded cost', async () => {
  const eur = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  assert(Number(eur.operating_result_minor) === 67000, `result was ${eur.operating_result_minor}`)
  return '89,000 − 22,000 = 67,000'
})

await check(
  'financing principal is cash, never a cost, and never moves the operating result',
  async () => {
    const eur = inCurrency(
      await report('report_business_summary', {
        p_organization_id: rptOrg,
        p_from: RPT_FROM,
        p_to: RPT_TO,
      }),
      'EUR',
    )
    assert(
      Number(eur.financing_principal_minor) === 500000,
      `principal was ${eur.financing_principal_minor}`,
    )
    // Interest 50,000 plus a 1,500 fee. The 500,000 principal is not in it.
    assert(Number(eur.financing_cost_minor) === 51500, `cost was ${eur.financing_cost_minor}`)
    assert(
      Number(eur.financing_cash_paid_minor) === 551500,
      `cash was ${eur.financing_cash_paid_minor}`,
    )
    // And the operating result is exactly what it was before any of it.
    assert(Number(eur.operating_result_minor) === 67000, 'financing moved the operating result')
    assert(Number(eur.operating_expense_minor) === 22000, 'financing entered operating expenses')
    return 'cash 5,515 · cost 515 · result unmoved'
  },
)

await check('the after-financing figure is separate and is not called a result', async () => {
  const eur = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  assert(
    Number(eur.after_financing_minor) === 67000 - 551500,
    `after-financing was ${eur.after_financing_minor}`,
  )
  assert(
    Number(eur.after_financing_minor) !== Number(eur.operating_result_minor),
    'the two figures collapsed into one',
  )
  return 'a cash figure, kept apart from the operating result'
})

await check(
  'money whose split nobody stated makes the cost incomplete, and invents nothing',
  async () => {
    const before = inCurrency(
      await report('report_business_summary', {
        p_organization_id: rptOrg,
        p_from: RPT_FROM,
        p_to: RPT_TO,
      }),
      'EUR',
    )
    assert(before.financing_cost_complete === true, 'the cost was already incomplete')

    sql(`insert into public.financing_payments
         (organization_id, agreement_id, paid_on, currency, amount_minor,
          principal_minor, interest_minor, fees_minor, unallocated_minor)
       values ('${rptOrg}', '${rptAgreement}', '2033-04-20', 'EUR', 430000, 0, 0, 0, 430000);`)

    const after = inCurrency(
      await report('report_business_summary', {
        p_organization_id: rptOrg,
        p_from: RPT_FROM,
        p_to: RPT_TO,
      }),
      'EUR',
    )
    assert(after.financing_cost_complete === false, 'the cost still claims to be complete')
    assert(
      Number(after.financing_unallocated_minor) === 430000,
      `unallocated was ${after.financing_unallocated_minor}`,
    )
    assert(
      Number(after.financing_cash_paid_minor) === 981500,
      `cash was ${after.financing_cash_paid_minor}`,
    )
    // No principal was invented and no interest was invented.
    assert(Number(after.financing_principal_minor) === 500000, 'principal was invented')
    assert(Number(after.financing_cost_minor) === 51500, 'interest was invented')
    return 'cash rose 4,300; cost and principal unchanged; completeness false'
  },
)

await check('two currencies stay two rows and never become one number', async () => {
  const usdRental = rptRow(
    sql(`insert into public.rentals
           (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
            currency, daily_rate_minor, subtotal_minor, total_minor, completed_at)
         values ('${rptOrg}', '${rptVehicleB}', '${rptCustomerA}', 'RPT-${STAMP}-USD', 'completed',
                 '2033-04-18T09:00:00Z', '2033-04-19T09:00:00Z', 'USD', 5000, 50000, 50000,
                 '2033-04-19T10:00:00Z')
         returning id;`),
  ).id
  sql(`insert into public.payments
         (organization_id, rental_id, customer_id, amount_minor, currency, purpose, paid_at)
       values ('${rptOrg}', '${usdRental}', '${rptCustomerA}', 50000, 'USD', 'rental_charge', '2033-04-19T10:00:00Z');`)

  const rows = await report('report_business_summary', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const currencies = rows.map((row) => row.currency).sort()
  assert(currencies.includes('EUR') && currencies.includes('USD'), `saw ${currencies.join(',')}`)
  assert(Number(inCurrency(rows, 'EUR').rental_revenue_minor) === 89000, 'EUR revenue moved')
  assert(Number(inCurrency(rows, 'USD').rental_revenue_minor) === 50000, 'USD revenue wrong')
  // The combined figure a naive implementation would print does not exist.
  assert(
    !rows.some((row) => Number(row.rental_revenue_minor) === 139000),
    '1,390 appeared — two currencies were added',
  )
  return '890 EUR and 500 USD, never 1,390 of anything'
})

await check('the trend refuses to draw without a currency', async () => {
  const { error } = await rptOwnerClient.rpc('report_financial_series', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
    p_granularity: 'day',
    p_currency: null,
  })
  assert(error, 'the series drew a chart across every currency')
  assert(/currency is required/i.test(error.message), `message was ${error.message}`)
  return 'refused, rather than summing'
})

await check('the trend zero-fills a quiet day and invents no bucket', async () => {
  const rows = await report('report_financial_series', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
    p_granularity: 'day',
    p_currency: 'EUR',
  })
  assert(rows.length === 30, `${rows.length} buckets for a 30-day April`)
  assert(Number(rows[0].rental_revenue_minor) === 0, 'the first of April was not zero')
  assert(
    rows.some((row) => Number(row.rental_revenue_minor) !== 0),
    'every bucket was zero',
  )
  return '30 buckets, zero-filled where nothing happened'
})

await check('Reports agrees with the dashboard on the same window', async () => {
  // A figure here that silently disagrees with the Overview tile is worse than
  // no figure at all.
  const [overview] = await report('organization_overview', {
    p_organization_id: rptOrg,
    p_from: '2033-04-01T00:00:00Z',
    p_to: '2033-05-01T00:00:00Z',
  })
  const eur = inCurrency(
    await report('report_business_summary', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
    }),
    'EUR',
  )
  assert(
    Number(overview.revenue_minor) === Number(eur.rental_revenue_minor),
    `dashboard ${overview.revenue_minor} vs report ${eur.rental_revenue_minor}`,
  )
  assert(
    Number(overview.expenses_minor) === Number(eur.operating_expense_minor),
    `dashboard ${overview.expenses_minor} vs report ${eur.operating_expense_minor}`,
  )
  assert(
    Number(overview.profit_minor) === Number(eur.operating_result_minor),
    'the operating result disagrees with the dashboard',
  )
  return 'revenue, cost and result all match'
})

await check('a rental-direct cost lands on its vehicle exactly once', async () => {
  const rows = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const one = rows.find(
    (row) => row.registration_plate === `RPT-${STAMP}-1` && row.currency === 'EUR',
  )
  assert(one, 'the vehicle is missing from the fleet report')
  assert(
    Number(one.vehicle_expense_minor) === 8000,
    `vehicle cost was ${one.vehicle_expense_minor}`,
  )
  assert(Number(one.rental_expense_minor) === 4000, `rental cost was ${one.rental_expense_minor}`)
  assert(Number(one.direct_expense_minor) === 12000, `direct cost was ${one.direct_expense_minor}`)
  return '80 on the car and 40 through the hire — 120 once'
})

await check('a vehicle report agrees with the vehicle page', async () => {
  const [existing] = await report('vehicle_operating_summary', {
    p_vehicle_id: rptVehicleA,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const rows = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const one = rows.find((row) => row.vehicle_id === rptVehicleA && row.currency === 'EUR')

  assert(
    Number(existing.rental_revenue_minor) === Number(one.rental_revenue_minor),
    `page ${existing.rental_revenue_minor} vs report ${one.rental_revenue_minor}`,
  )
  assert(
    Number(existing.operating_contribution_minor) === Number(one.operating_contribution_minor),
    'the contribution disagrees with the vehicle page',
  )
  return 'revenue and contribution both match'
})

await check('a vehicle that earned nothing is shown, not omitted', async () => {
  const rows = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const idle = rows.find((row) => row.vehicle_id === rptVehicleIdle)
  assert(idle, 'the idle vehicle was dropped from the report')
  assert(Number(idle.rental_revenue_minor) === 0, 'the idle vehicle reported revenue')
  assert(Number(idle.rented_days) === 0, 'the idle vehicle reported days on hire')
  assert(Number(idle.utilisation_bps) === 0, 'the idle vehicle reported utilisation')
  return 'the row a manager opened the report to find'
})

await check('a hire spanning two periods contributes only its overlap to each', async () => {
  const april = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const march = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: '2033-03-01',
    p_to: '2033-04-01',
  })
  const inApril = Number(april.find((row) => row.vehicle_id === rptVehicleB).rented_days)
  const inMarch = Number(march.find((row) => row.vehicle_id === rptVehicleB).rented_days)

  // The hire runs 29 March to 4 April: six days, split across the boundary.
  assert(inApril > 0 && inApril < 6, `April saw ${inApril} days`)
  assert(inMarch > 0 && inMarch < 6, `March saw ${inMarch} days`)
  // April also carries the one-day USD hire on the same car.
  assert(Math.abs(inApril + inMarch - 7) < 0.01, `the halves summed to ${inApril + inMarch}`)
  return `${inMarch.toFixed(2)} in March + ${inApril.toFixed(2)} in April`
})

await check('a cancelled booking creates no utilisation', async () => {
  const rows = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const one = rows.find((row) => row.vehicle_id === rptVehicleA && row.currency === 'EUR')
  // The 5–10 April hire is five days. The cancelled 20–22 April booking is not.
  assert(Math.abs(Number(one.rented_days) - 5) < 0.01, `saw ${one.rented_days} days`)
  return 'five days, not seven'
})

await check('utilisation never exceeds the time the vehicle existed', async () => {
  const rows = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  for (const row of rows) {
    if (row.utilisation_bps === null) continue
    assert(Number(row.utilisation_bps) >= 0, `${row.registration_plate} was negative`)
    assert(Number(row.utilisation_bps) <= 10000, `${row.registration_plate} exceeded 100%`)
  }
  return `${rows.length} rows, every one inside 0–100%`
})

await check('an archived vehicle keeps its history', async () => {
  sql(`update public.vehicles set archived_at = now() where id = '${rptVehicleIdle}';`)
  const rows = await report('report_fleet_performance', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  assert(
    rows.some((row) => row.vehicle_id === rptVehicleIdle),
    'the archived vehicle vanished from the historical report',
  )
  sql(`update public.vehicles set archived_at = null where id = '${rptVehicleIdle}';`)
  return 'a car sold in May still earned what it earned in April'
})

await check('costs break down by allocation using the recorded value', async () => {
  const rows = await report('report_expense_breakdown', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
    p_dimension: 'allocation',
  })
  const eur = rows.filter((row) => row.currency === 'EUR')
  const byKey = Object.fromEntries(eur.map((row) => [row.dimension_key, Number(row.gross_minor)]))
  assert(byKey.overhead === 10000, `overhead was ${byKey.overhead}`)
  assert(byKey.vehicle === 8000, `vehicle-direct was ${byKey.vehicle}`)
  assert(byKey.rental === 4000, `rental-direct was ${byKey.rental}`)
  return '100 overhead · 80 vehicle · 40 rental'
})

await check('every breakdown excludes a voided cost', async () => {
  for (const dimension of ['category', 'vendor', 'allocation']) {
    const rows = await report('report_expense_breakdown', {
      p_organization_id: rptOrg,
      p_from: RPT_FROM,
      p_to: RPT_TO,
      p_dimension: dimension,
    })
    const total = rows
      .filter((row) => row.currency === 'EUR')
      .reduce((sum, row) => sum + Number(row.gross_minor), 0)
    assert(total === 22000, `${dimension} totalled ${total}`)
  }
  return 'three dimensions, 220 each, the voided 500 nowhere'
})

await check('two suppliers with the same name stay two suppliers', async () => {
  const vendors = rptRows(
    sql(`insert into public.expense_vendors (organization_id, name)
         values ('${rptOrg}', 'Garage ${STAMP}'), ('${rptOrg}', 'Garage ${STAMP}')
         returning id;`),
  )
  const category = rptRow(
    sql(`select id from public.expense_categories where organization_id = '${rptOrg}' limit 1;`),
  ).id
  sql(`insert into public.expenses
         (organization_id, category_id, vendor_id, allocation, status, amount_minor, currency, incurred_on)
       values
         ('${rptOrg}', '${category}', '${vendors[0].id}', 'overhead', 'recorded', 1100, 'EUR', '2033-04-25'),
         ('${rptOrg}', '${category}', '${vendors[1].id}', 'overhead', 'recorded', 2200, 'EUR', '2033-04-25');`)

  const rows = await report('report_expense_breakdown', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
    p_dimension: 'vendor',
  })
  const matching = rows.filter((row) => row.dimension_label === `Garage ${STAMP}`)
  assert(matching.length === 2, `${matching.length} rows for two same-named suppliers`)

  sql(`delete from public.expenses where vendor_id in ('${vendors[0].id}', '${vendors[1].id}');`)
  sql(`delete from public.expense_vendors where id in ('${vendors[0].id}', '${vendors[1].id}');`)
  return 'grouped by identity, not by label'
})

await check('rental lifecycle counts use their own dates', async () => {
  const [row] = await report('report_rental_operations', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  // Two hires begin in April (5th and 18th); the 29 March one does not.
  assert(Number(row.started) === 2, `started was ${row.started}`)
  // Three completed in April: the 4th, the 10th and the 19th.
  assert(Number(row.completed) === 3, `completed was ${row.completed}`)
  assert(Number(row.cancelled) === 1, `cancelled was ${row.cancelled}`)
  // Everything was created today, not in 2033 — so "created" is zero while
  // "started" is not. A report filtering everything by created_at shows the
  // opposite.
  assert(Number(row.created) === 0, `created was ${row.created}`)
  return 'started 2 · completed 3 · cancelled 1 · created 0'
})

await check('the cancellation rate counts real bookings only', async () => {
  const [row] = await report('report_rental_operations', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  /*
   * Two bookings were confirmed in April and one of them was cancelled in
   * April too. Cancelling leaves `confirmed_at` in place, so a denominator of
   * "confirmed plus cancelled" would count that booking twice and could never
   * report more than half — a month in which every booking was cancelled would
   * read 50%. The denominator is distinct real bookings.
   */
  assert(Number(row.confirmed) === 2, `confirmed was ${row.confirmed}`)
  assert(Number(row.cancellation_bps) === 5000, `rate was ${row.cancellation_bps}`)
  return '1 of 2 real bookings = 50.00%'
})

await check('a value is never averaged across currencies', async () => {
  const rows = await report('report_rental_values', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  const usd = rows.find((row) => row.currency === 'USD')
  assert(usd, 'the USD row is missing')
  assert(
    Number(usd.avg_completed_value_minor) === 50000,
    `USD average was ${usd.avg_completed_value_minor}`,
  )
  const eur = rows.find((row) => row.currency === 'EUR')
  assert(
    Number(eur.avg_completed_value_minor) !== Number(usd.avg_completed_value_minor),
    'the averages merged',
  )
  return 'one average per currency'
})

await check('a first-time renter is defined by their first hire, not their record', async () => {
  const [april] = await report('report_customer_cohorts', {
    p_organization_id: rptOrg,
    p_from: RPT_FROM,
    p_to: RPT_TO,
  })
  assert(Number(april.renters_in_period) > 0, 'nobody rented in April')
  assert(
    Number(april.renters_in_period) ===
      Number(april.first_time_renters) + Number(april.returning_renters),
    'the cohorts do not add up to the renters',
  )

  // Both customers were created today. A cohort keyed on customers.created_at
  // would put every one of them in today's period, not April 2033.
  const [may] = await report('report_customer_cohorts', {
    p_organization_id: rptOrg,
    p_from: '2033-05-01',
    p_to: '2033-06-01',
  })
  assert(Number(may.renters_in_period) === 0, `May reported ${may.renters_in_period} renters`)

  // A hire in May by somebody who hired in April is a RETURNING renter.
  sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
          currency, daily_rate_minor, subtotal_minor, total_minor, completed_at)
       values ('${rptOrg}', '${rptVehicleIdle}', '${rptCustomerA}', 'RPT-${STAMP}-MAY', 'completed',
               '2033-05-10T09:00:00Z', '2033-05-11T09:00:00Z', 'EUR', 4000, 4000, 4000,
               '2033-05-11T10:00:00Z');`)

  const [mayAgain] = await report('report_customer_cohorts', {
    p_organization_id: rptOrg,
    p_from: '2033-05-01',
    p_to: '2033-06-01',
  })
  assert(Number(mayAgain.renters_in_period) === 1, `May had ${mayAgain.renters_in_period} renters`)
  assert(Number(mayAgain.first_time_renters) === 0, 'a returning renter was counted as new')
  assert(Number(mayAgain.returning_renters) === 1, 'the returning renter was not recognised')
  return 'first-ever hire found across all history, then compared to the window'
})

await check('a cancelled booking does not make somebody a renter', async () => {
  const ghost = rptRow(
    sql(`insert into public.customers (organization_id, first_name, last_name)
         values ('${rptOrg}', 'Ghost', 'Renter') returning id;`),
  ).id
  sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, reference, status, starts_at, ends_at,
          currency, daily_rate_minor, subtotal_minor, total_minor, cancelled_at)
       values ('${rptOrg}', '${rptVehicleIdle}', '${ghost}', 'RPT-${STAMP}-GHOST', 'cancelled',
               '2033-06-05T09:00:00Z', '2033-06-06T09:00:00Z', 'EUR', 4000, 4000, 4000,
               '2033-06-01T09:00:00Z');`)

  const [june] = await report('report_customer_cohorts', {
    p_organization_id: rptOrg,
    p_from: '2033-06-01',
    p_to: '2033-07-01',
  })
  assert(Number(june.renters_in_period) === 0, `June reported ${june.renters_in_period} renters`)
  return 'a booking that never happened creates no renter'
})

await check(
  'the balances report carries a name and money, and nothing else about a person',
  async () => {
    const rows = await report('report_customer_balances', {
      p_organization_id: rptOrg,
      p_currency: null,
      p_limit: 25,
      p_offset: 0,
    })
    assert(rows.length > 0, 'no balances were returned')

    const columns = Object.keys(rows[0])
    for (const forbidden of [
      'email',
      'phone',
      'secondary_phone',
      'phone_normalized',
      'email_normalized',
      'date_of_birth',
      'address_line1',
      'address_line2',
      'postal_code',
      'notes',
      'license_number',
      'national_id',
      'passport',
      'document_number',
    ]) {
      assert(!columns.includes(forbidden), `the report exposes ${forbidden}`)
    }
    assert(columns.includes('display_name'), 'the report has no name to act on')
    return `${columns.length} columns, none of them a contact detail`
  },
)

await check(
  'balances and deposits agree with the dashboard, and ignore the date picker',
  async () => {
    const [overview] = await report('organization_overview', {
      p_organization_id: rptOrg,
      p_from: '2033-04-01T00:00:00Z',
      p_to: '2033-05-01T00:00:00Z',
    })
    const positions = await report('report_position_summary', { p_organization_id: rptOrg })
    const eur = inCurrency(positions, 'EUR')

    assert(
      Number(eur.outstanding_minor) === Number(overview.outstanding_minor),
      `report ${eur.outstanding_minor} vs dashboard ${overview.outstanding_minor}`,
    )
    assert(
      Number(eur.deposits_held_minor) === Number(overview.deposits_held_minor),
      'deposits held disagree with the dashboard',
    )
    return 'positions match, and take no period'
  },
)

await check('a principal nobody can derive is counted, never printed as zero', async () => {
  const eur = inCurrency(
    await report('report_position_summary', { p_organization_id: rptOrg }),
    'EUR',
  )
  /*
   * The unallocated payment made THIS agreement's balance underivable. The
   * agency holds other agreements whose balances are derivable, so the org
   * figure sums those and reports the unknown one as a count rather than
   * folding a guess into the total.
   */
  assert(
    Number(eur.principal_unknown_count) >= 1,
    `${eur.principal_unknown_count} unknown agreements`,
  )
  const financing = await report('report_financing_position', { p_organization_id: rptOrg })
  const agreement = financing.find((row) => row.agreement_id === rptAgreement)
  assert(agreement, 'the active agreement is missing from the financing report')
  assert(agreement.principal_known === false, 'the balance claims to be known')
  assert(agreement.remaining_principal_minor === null, 'a balance was invented')
  assert(agreement.cost_complete === false, 'the cost claims to be complete')
  return 'unknown stayed unknown'
})

await check('tracking reports a stamped snapshot and counts untracked vehicles', async () => {
  const [row] = await report('report_gps_coverage', { p_organization_id: rptOrg })
  assert(row.computed_at, 'the snapshot carries no timestamp')
  assert(
    Number(row.vehicles_untracked) === Number(row.vehicles_total) - Number(row.vehicles_tracked),
    'the coverage arithmetic does not close',
  )
  // Three buckets, never two: a provider that says nothing has not said offline.
  assert('link_unreported' in row, 'connectivity was collapsed into two buckets')
  assert(Number(row.fresh_minutes) > 0, 'the freshness threshold was not echoed back')
  return `${row.vehicles_tracked} of ${row.vehicles_total} tracked, stamped`
})

await check('compliance counts a missing date apart from an expired one', async () => {
  const rows = await report('report_compliance_summary', {
    p_organization_id: rptOrg,
    p_lead_days: null,
  })
  assert(rows.length === 3, `${rows.length} document kinds`)
  const registration = rows.find((row) => row.document_kind === 'registration')
  assert(Number(registration.unrecorded) > 0, 'no unrecorded registration dates')
  assert(Number(registration.expired) === 0, 'a missing date was counted as expired')
  assert(Number(registration.lead_days) > 0, 'the agency threshold was not used')
  return 'a data gap is not a breach'
})

await check('a manager may read every report', async () => {
  for (const [name, args] of REPORT_CALLS(rptOrg)) {
    const { error } = await rptManagerClient.rpc(name, args)
    assert(!error, `${name} refused a manager: ${error?.message}`)
  }
  return `${REPORT_CALLS(rptOrg).length} reports, all readable`
})

await check('a member of staff may read no report at all', async () => {
  // Reports combine financial, customer and location data. Hiding a sidebar
  // entry is not a control.
  for (const [name, args] of REPORT_CALLS(rptOrg)) {
    const { error } = await rptStaffClient.rpc(name, args)
    assert(error, `${name} was readable by staff`)
    assert(/not permitted to view reports/i.test(error.message), `${name} said: ${error.message}`)
  }
  return 'fourteen refusals'
})

await check('another agency is refused every report, with the same sentence', async () => {
  // The same message staff get, so nobody learns whether an organization exists
  // by comparing error text.
  for (const [name, args] of REPORT_CALLS(rptOrg)) {
    const { error } = await clientB.rpc(name, args)
    assert(error, `${name} leaked to another agency`)
    assert(/not permitted to view reports/i.test(error.message), `${name} said: ${error.message}`)
  }
  return 'fourteen refusals, indistinguishable from a missing agency'
})

await check('the anonymous role has no reporting access at all', async () => {
  const anon = client()
  for (const [name, args] of REPORT_CALLS(rptOrg)) {
    const { error } = await anon.rpc(name, args)
    assert(error, `${name} was callable by anon`)
  }
  return 'fourteen functions, all refused'
})

await check('agency B sees none of agency A’s economics', async () => {
  // B's own report over the same window carries none of A's money. B took no
  // payments in April 2033, so the honest answer is no rows at all.
  const business = await report(
    'report_business_summary',
    { p_organization_id: orgB.id, p_from: RPT_FROM, p_to: RPT_TO },
    clientB,
  )
  assert(!business.some((row) => Number(row.rental_revenue_minor) === 89000), "B saw A's revenue")

  const fleet = await report(
    'report_fleet_performance',
    { p_organization_id: orgB.id, p_from: RPT_FROM, p_to: RPT_TO },
    clientB,
  )
  assert(
    !fleet.some((row) => String(row.registration_plate).startsWith(`RPT-${STAMP}`)),
    "B saw A's vehicles",
  )
  return `B's own figures only (${business.length} currency rows)`
})

await check('every report function is security invoker', async () => {
  const out = sql(
    `select string_agg(p.proname, ', ' order by p.proname) as names
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'report\\_%' and p.prosecdef;`,
  )
  const names = rptRow(out).names
  assert(names === null, `security definer report functions: ${names}`)
  return 'row-level security decides what each one sees'
})

await check('an inverted period is refused rather than silently empty', async () => {
  const { error } = await rptOwnerClient.rpc('report_business_summary', {
    p_organization_id: rptOrg,
    p_from: RPT_TO,
    p_to: RPT_FROM,
  })
  assert(error, 'an inverted period returned a result')
  assert(/must end after it starts/i.test(error.message), `message was ${error.message}`)
  return 'refused'
})

await check('the reporting fixture is removed', async () => {
  /*
   * Everything the reports were computed from goes, in dependency order.
   *
   * The financing agreement and its payments are cancelled rather than deleted.
   * The domain refuses to destroy a live agreement so its history survives a
   * correction — that is its rule, not something a test should work around. The
   * rows leave with the agency in the final cleanup, which verifies the
   * database is clean; the check below verifies the reporting fixture itself.
   */
  sql(`update public.financing_agreements
       set agreement_status = 'cancelled'
       where id = '${rptAgreement}' and agreement_status = 'active';`)
  /*
   * Recorded costs only. A voided cost is deliberately undeletable —
   * `expenses_guard_delete` keeps it as the record of a correction — so the
   * teardown does not fight the domain for it; it leaves with the agency.
   */
  sql(`delete from public.expenses where organization_id = '${rptOrg}'
       and status = 'recorded'
       and incurred_on between '2033-03-01' and '2033-05-01';`)
  sql(`delete from public.payments where organization_id = '${rptOrg}'
       and paid_at between '2033-03-01' and '2033-07-01';`)
  sql(`delete from public.rentals where reference like 'RPT-${STAMP}-%';`)
  sql(`delete from public.customers where organization_id = '${rptOrg}'
       and (last_name in ('Alpha', 'Beta') or (first_name = 'Ghost' and last_name = 'Renter'));`)
  /*
   * The unfinanced vehicles go. The financed one stays: `vehicles_delete`
   * refuses to destroy a car that still carries an agreement, which is the
   * rule the Financing module asserts for itself and not something a teardown
   * should route around. It leaves with the agency.
   */
  sql(`delete from public.vehicles v
       where v.registration_plate like 'RPT-${STAMP}-%'
         and not exists (select 1 from public.financing_agreements a where a.vehicle_id = v.id);`)

  const left = rptRow(
    sql(`select
           (select count(*)::int from public.rentals where reference like 'RPT-${STAMP}-%') as rentals,
           (select count(*)::int from public.vehicles v
              where v.registration_plate like 'RPT-${STAMP}-%'
                and not exists (select 1 from public.financing_agreements a where a.vehicle_id = v.id)) as vehicles,
           (select count(*)::int from public.expenses where organization_id = '${rptOrg}'
              and status = 'recorded' and incurred_on between '2033-03-01' and '2033-05-01') as costs,
           (select agreement_status::text from public.financing_agreements where id = '${rptAgreement}') as agreement;`),
  )
  assert(left.rentals === 0, `${left.rentals} fixture rentals survived`)
  assert(left.vehicles === 0, `${left.vehicles} fixture vehicles survived`)
  assert(left.costs === 0, `${left.costs} fixture costs survived`)
  assert(left.agreement === 'cancelled', `the agreement is ${left.agreement}`)
  return 'contracts, payments, recorded costs and unfinanced vehicles removed; the voided cost, the cancelled agreement and its vehicle leave with the agency'
})

let teamInvitationId, teamInvitationToken, teamOldToken
let teamRecruitId, teamRecruitClient, teamForcedId, teamInvitedFirstId
let teamWithdrawnId, teamDoomedId, teamRacerId

// =============================================================================
// Team, invitations & membership
//
// The module every other module's authorization rests on, so most of what
// follows is an attack rather than a workflow. Each one runs through PostgREST
// with a real session, which is the position a browser occupies — a refusal here
// is the database refusing, not a component declining to render a button.
//
// Two agencies, four roles, and genuinely concurrent requests where the
// invariant is about concurrency. Everything is prefixed with the run stamp and
// removed at the end.
// =============================================================================

const teamPassword = 'SmokeTest!2026'
const teamEmail = (who) => `smoke-team-${who}-${STAMP}@atlasloca.com`

let teamOrg, teamRivalOrg
let teamOwnerId, teamAdminId, teamManagerId, teamStaffId, teamRivalId
let teamOwnerClient, teamAdminClient, teamManagerClient, teamStaffClient, teamRivalClient

function teamRow(out) {
  return (out.result ?? out.rows ?? [])[0]
}

/** Signs a seeded user in and hands back a client carrying their session. */
async function teamSignIn(email) {
  // Returns only a client whose session is confirmed. A transport blip is retried
  // twice; an answer from Auth is reported as it arrived.
  const signedIn = await signInTestUser(client, { email, password: teamPassword })
  return signedIn.client
}

/** Creates an invitation as `who` and returns the one-time token. */
async function teamInvite(asClient, organizationId, email, role) {
  const { data, error } = await asClient.rpc('create_team_invitation', {
    p_organization_id: organizationId,
    p_email: email,
    p_role: role,
  })
  assert(!error, error?.message)
  return data?.[0]
}

/** Moves an invitation's issue clock back so a test is not fighting the throttle. */
function teamAgeInvitation(invitationId) {
  sql(`update public.organization_invitations
          set last_issued_at = now() - interval '10 minutes'
        where id = '${invitationId}';`)
}

await check('team: two agencies with a full cast', async () => {
  teamOwnerId = seedConfirmedUser(
    { email: teamEmail('owner'), password: teamPassword },
    { full_name: 'Team Owner' },
  )
  teamOrg = teamRow(
    sql(`select (app.provision_organization(
           '${teamOwnerId}'::uuid, 'Smoke Test Team ${STAMP}', 'MA', 'MAD', 'UTC', 'en'
         )).id as id;`),
  ).id

  teamRivalId = seedConfirmedUser(
    { email: teamEmail('rival'), password: teamPassword },
    { full_name: 'Rival Owner' },
  )
  teamRivalOrg = teamRow(
    sql(`select (app.provision_organization(
           '${teamRivalId}'::uuid, 'Smoke Test Rival ${STAMP}', 'MA', 'MAD', 'UTC', 'en'
         )).id as id;`),
  ).id

  for (const [who, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['staff', 'staff'],
  ]) {
    const id = seedConfirmedUser(
      { email: teamEmail(who), password: teamPassword },
      { full_name: `Team ${who}` },
    )
    sql(`insert into public.organization_members (organization_id, user_id, role, status)
         values ('${teamOrg}', '${id}', '${role}', 'active');`)
    if (who === 'admin') teamAdminId = id
    if (who === 'manager') teamManagerId = id
    if (who === 'staff') teamStaffId = id
  }

  teamOwnerClient = await teamSignIn(teamEmail('owner'))
  teamAdminClient = await teamSignIn(teamEmail('admin'))
  teamManagerClient = await teamSignIn(teamEmail('manager'))
  teamStaffClient = await teamSignIn(teamEmail('staff'))
  teamRivalClient = await teamSignIn(teamEmail('rival'))

  return 'owner, admin, manager, staff + a rival agency'
})

await check('team: the roster is readable by every member and by nobody else', async () => {
  for (const [name, asClient] of [
    ['owner', teamOwnerClient],
    ['admin', teamAdminClient],
    ['manager', teamManagerClient],
    ['staff', teamStaffClient],
  ]) {
    const { data, error } = await asClient.rpc('team_directory', { p_organization_id: teamOrg })
    assert(!error, `${name}: ${error?.message}`)
    assert(data.length === 4, `${name} saw ${data.length} members`)
    assert(data.filter((row) => row.is_self).length === 1, `${name} could not find themselves`)
  }

  const { error } = await teamRivalClient.rpc('team_directory', { p_organization_id: teamOrg })
  assert(error?.code === '42501', `the rival got ${error?.code ?? 'data'}`)
  return 'four members; the rival is refused'
})

await check('team: invitations and history are administrators-only', async () => {
  for (const [name, asClient] of [
    ['manager', teamManagerClient],
    ['staff', teamStaffClient],
    ['rival', teamRivalClient],
  ]) {
    for (const rpc of ['team_invitations', 'team_events']) {
      const { error } = await asClient.rpc(rpc, { p_organization_id: teamOrg })
      assert(error?.code === '42501', `${name} reached ${rpc}: ${error?.code ?? 'data'}`)
    }
  }
  return 'manager, staff and the rival all refused'
})

await check('team: an owner invites an administrator and gets one token', async () => {
  const row = await teamInvite(teamOwnerClient, teamOrg, teamEmail('recruit'), 'admin')
  assert(row.outcome === 'created', `outcome was ${row.outcome}`)
  assert(/^[A-Za-z0-9_-]{40,}$/.test(row.token), 'the token is not 256 bits of base64url')
  teamInvitationId = row.invitationId ?? row.invitation_id
  teamInvitationToken = row.token
  return `token of ${row.token.length} characters`
})

await check('team: the raw token is nowhere in the database', async () => {
  const found = teamRow(
    sql(`select count(*)::int as hits
         from public.organization_invitations
         where organization_id = '${teamOrg}'
           and (coalesce(delivery_detail, '') like '%${teamInvitationToken.slice(0, 20)}%'
                or coalesce(revoke_reason, '') like '%${teamInvitationToken.slice(0, 20)}%');`),
  ).hits
  assert(found === 0, 'the token appears in an invitation column')

  const digest = teamRow(
    sql(`select (token_digest = sha256(convert_to('${teamInvitationToken}', 'utf8'))) as matches
         from public.organization_invitations where id = '${teamInvitationId}';`),
  ).matches
  assert(digest === true, 'the stored digest is not the digest of the token')

  const audited = teamRow(
    sql(`select count(*)::int as hits from public.organization_team_events
         where organization_id = '${teamOrg}'
           and coalesce(detail, '') || coalesce(target_email, '') like '%${teamInvitationToken.slice(0, 20)}%';`),
  ).hits
  assert(audited === 0, 'the token appears in the audit trail')
  return 'only a SHA-256 digest is stored'
})

await check('team: the list read model never returns a token or a digest', async () => {
  const { data, error } = await teamOwnerClient.rpc('team_invitations', {
    p_organization_id: teamOrg,
    p_include_history: true,
  })
  assert(!error, error?.message)
  const serialised = JSON.stringify(data)
  assert(!serialised.includes(teamInvitationToken), 'the list returned the token')
  assert(!/token_digest/.test(serialised), 'the list returned the digest')
  assert(data[0].email === teamEmail('recruit'), 'the invitation is missing from the list')
  return 'email, role, state and delivery only'
})

await check('team: the invitation tables are unreachable by table access', async () => {
  for (const table of ['organization_invitations', 'organization_team_events']) {
    const { error } = await teamOwnerClient.from(table).select('*').limit(1)
    assert(error, `${table} returned rows to an owner`)
    assert(error.code === '42501', `${table} gave ${error.code}`)
  }
  return 'both refused, even to the owner'
})

await check('team: membership cannot be written directly at any role', async () => {
  const attempts = [
    teamAdminClient
      .from('organization_members')
      .update({ role: 'owner' })
      .eq('user_id', teamAdminId),
    teamAdminClient
      .from('organization_members')
      .insert({ organization_id: teamOrg, user_id: teamRivalId, role: 'admin' }),
    teamAdminClient.from('organization_members').delete().eq('user_id', teamStaffId),
    teamOwnerClient
      .from('organization_members')
      .update({ role: 'staff' })
      .eq('user_id', teamAdminId),
  ]
  for (const [index, attempt] of attempts.entries()) {
    const { error } = await attempt
    assert(error, `attempt ${index} succeeded`)
    assert(error.code === '42501', `attempt ${index} gave ${error.code}`)
  }

  const role = teamRow(
    sql(`select role::text as role from public.organization_members
         where organization_id = '${teamOrg}' and user_id = '${teamAdminId}';`),
  ).role
  assert(role === 'admin', `the administrator is now ${role}`)
  return 'four direct writes refused; nothing moved'
})

await check('team: a manager and a staff member cannot invite anybody', async () => {
  for (const [name, asClient] of [
    ['manager', teamManagerClient],
    ['staff', teamStaffClient],
  ]) {
    const { error } = await asClient.rpc('create_team_invitation', {
      p_organization_id: teamOrg,
      p_email: `escalate-${name}@atlasloca.com`,
      p_role: 'staff',
    })
    assert(error?.code === '42501', `${name} got ${error?.code ?? 'an invitation'}`)
  }
  return 'both refused'
})

await check('team: nobody can invite an owner', async () => {
  const { error } = await teamOwnerClient.rpc('create_team_invitation', {
    p_organization_id: teamOrg,
    p_email: teamEmail('heir'),
    p_role: 'owner',
  })
  assert(error, 'the owner minted an owner invitation')
  const constraint = sql(`select count(*)::int as n from pg_constraint
                          where conname = 'organization_invitations_never_owner';`)
  assert(teamRow(constraint).n === 1, 'the CHECK constraint is missing')
  return 'refused by the function and by a CHECK constraint'
})

await check('team: a rival cannot invite into, or touch, this agency', async () => {
  const invite = await teamRivalClient.rpc('create_team_invitation', {
    p_organization_id: teamOrg,
    p_email: 'wedge@rival.test',
    p_role: 'admin',
  })
  assert(invite.error?.code === '42501', `invite gave ${invite.error?.code}`)

  for (const [rpc, args] of [
    ['resend_team_invitation', { p_invitation_id: teamInvitationId }],
    ['revoke_team_invitation', { p_invitation_id: teamInvitationId }],
    ['team_invitation_message', { p_invitation_id: teamInvitationId }],
  ]) {
    const { error } = await teamRivalClient.rpc(rpc, args)
    assert(error?.code === 'P0002', `${rpc} gave ${error?.code}`)
  }

  const roleChange = await teamRivalClient.rpc('change_team_member_role', {
    p_organization_id: teamOrg,
    p_user_id: teamStaffId,
    p_role: 'admin',
  })
  assert(roleChange.error?.code === '42501', `role change gave ${roleChange.error?.code}`)

  const removal = await teamRivalClient.rpc('remove_team_member', {
    p_organization_id: teamOrg,
    p_user_id: teamStaffId,
  })
  assert(removal.error?.code === '42501', `removal gave ${removal.error?.code}`)

  const transfer = await teamRivalClient.rpc('transfer_organization_ownership', {
    p_organization_id: teamOrg,
    p_user_id: teamRivalId,
  })
  assert(transfer.error?.code === '42501', `transfer gave ${transfer.error?.code}`)
  return 'six cross-tenant attempts refused'
})

await check('team: inviting the same address again reissues rather than duplicating', async () => {
  teamAgeInvitation(teamInvitationId)
  const again = await teamInvite(
    teamAdminClient,
    teamOrg,
    teamEmail('recruit').toUpperCase(),
    'manager',
  )
  assert(again.outcome === 'reissued', `outcome was ${again.outcome}`)
  assert(again.token !== teamInvitationToken, 'the token was not rotated')

  const open = teamRow(
    sql(`select count(*)::int as n from public.organization_invitations
         where organization_id = '${teamOrg}'
           and email_normalized = '${teamEmail('recruit')}'
           and accepted_at is null and revoked_at is null;`),
  ).n
  assert(open === 1, `${open} open invitations for one address`)

  teamOldToken = teamInvitationToken
  teamInvitationToken = again.token
  return 'one row, rotated token, case and whitespace normalised'
})

await check('team: the resend floor is enforced without any delivery being reported', async () => {
  const { error } = await teamOwnerClient.rpc('resend_team_invitation', {
    p_invitation_id: teamInvitationId,
  })
  assert(error, 'an immediate resend was allowed')
  assert(/moments ago/i.test(error.message), `message was: ${error.message}`)

  const sent = teamRow(
    sql(`select last_sent_at is null as never_sent from public.organization_invitations
         where id = '${teamInvitationId}';`),
  ).never_sent
  assert(sent === true, 'last_sent_at was written by something other than delivery')
  return 'throttled from the mint, not from a delivery report the client may never make'
})

await check('team: the agency hourly invitation ceiling holds', async () => {
  sql(`insert into public.organization_invitations
         (organization_id, email, email_normalized, role, invited_by, expires_at, token_digest)
       select '${teamOrg}', 'ceiling' || n || '-${STAMP}@atlasloca.com',
              'ceiling' || n || '-${STAMP}@atlasloca.com', 'staff', '${teamOwnerId}',
              now() + interval '7 days', sha256(convert_to('ceiling-${STAMP}-' || n, 'utf8'))
       from generate_series(1, 25) as n;`)

  const { error } = await teamOwnerClient.rpc('create_team_invitation', {
    p_organization_id: teamOrg,
    p_email: `overflow-${STAMP}@atlasloca.com`,
    p_role: 'staff',
  })
  assert(error, 'the ceiling did not hold')
  assert(/a lot of invitations/i.test(error.message), `message was: ${error.message}`)

  // Per agency, not global: the rival is unaffected.
  const rival = await teamInvite(
    teamRivalClient,
    teamRivalOrg,
    `rival-ok-${STAMP}@atlasloca.com`,
    'staff',
  )
  assert(rival.outcome === 'created', 'the ceiling leaked across tenants')

  sql(`delete from public.organization_invitations
       where organization_id = '${teamOrg}' and email_normalized like 'ceiling%';`)
  return '25 in an hour is the ceiling, and it is per agency'
})

await check('team: the preview is unreachable by anon and by a signed-in user', async () => {
  const anon = client()
  const anonAttempt = await anon.rpc('preview_team_invitation', { p_token: teamInvitationToken })
  assert(anonAttempt.error, 'anon previewed an invitation')

  const memberAttempt = await teamOwnerClient.rpc('preview_team_invitation', {
    p_token: teamInvitationToken,
  })
  assert(memberAttempt.error, 'a signed-in member reached the preview directly')
  return 'only the Edge Function, through service_role, may ask'
})

await check('team: the preview endpoint answers with nothing identifying', async () => {
  const response = await fetch(`${URL}/functions/v1/team-invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({ action: 'preview', token: teamInvitationToken }),
  })
  assert(response.ok, `preview returned ${response.status}`)
  const body = await response.json()
  assert(body.invitation.organizationName.includes('Smoke Test Team'), 'no agency name came back')
  assert(body.invitation.role === 'manager', `role was ${body.invitation.role}`)
  assert(body.invitation.state === 'pending', `state was ${body.invitation.state}`)

  const serialised = JSON.stringify(body)
  assert(!serialised.includes(teamOrg), 'the preview returned the organization id')
  assert(!serialised.includes(teamEmail('recruit')), 'the preview returned the invited address')
  assert(!serialised.includes(teamInvitationId), 'the preview returned the invitation id')
  assert(/^[a-z]•+@/.test(body.invitation.emailMasked), `mask was ${body.invitation.emailMasked}`)
  return `agency, role, expiry and ${body.invitation.emailMasked}`
})

await check('team: an unknown token tells a stranger nothing', async () => {
  const response = await fetch(`${URL}/functions/v1/team-invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({ action: 'preview', token: 'z'.repeat(43) }),
  })
  assert(response.status === 404, `status was ${response.status}`)
  const body = await response.json()
  assert(/not valid/i.test(body.error.message), `message was ${body.error.message}`)
  assert(
    !/expired|revoked|agency|organization/i.test(body.error.message),
    'the message leaks state',
  )
  return 'one answer for every bad token'
})

await check('team: the Edge Function refuses to invite for an unauthenticated caller', async () => {
  const response = await fetch(`${URL}/functions/v1/team-invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({
      action: 'create',
      organization_id: teamOrg,
      email: `anon-${STAMP}@atlasloca.com`,
      role: 'admin',
    }),
  })
  assert(response.status === 401, `status was ${response.status}`)
  return 'no session, no invitation'
})

await check(
  'team: the Edge Function creates an invitation and reports delivery honestly',
  async () => {
    const token = (await teamOwnerClient.auth.getSession()).data.session.access_token
    const address = `edge-created-${STAMP}@atlasloca.com`

    const response = await fetch(`${URL}/functions/v1/team-invitations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: KEY,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        action: 'create',
        organization_id: teamOrg,
        email: address,
        role: 'manager',
      }),
    })
    assert(response.ok, `create returned ${response.status}`)
    const body = await response.json()
    assert(body.outcome === 'created', `outcome was ${body.outcome}`)

    /*
     * No email provider is configured for this project, so the honest answer is
     * `not_configured` — never `sent` — and the one-time link comes back to the
     * administrator to deliver by hand. If a provider is configured later this
     * flips to `accepted_by_provider` and the token stops coming back at all,
     * which is the assertion below in its other form.
     */
    const stored = teamRow(
      sql(`select delivery_state::text as state, delivery_detail, send_count
         from public.organization_invitations where id = '${body.invitationId}';`),
    )

    if (body.delivery === 'not_configured' || body.delivery === 'failed') {
      assert(
        typeof body.token === 'string' && body.token.length >= 40,
        'no fallback link was offered',
      )
      assert(
        stored.state === body.delivery,
        `the row says ${stored.state}, the response ${body.delivery}`,
      )
    } else {
      assert(body.delivery === 'accepted_by_provider', `delivery was ${body.delivery}`)
      assert(body.token === undefined, 'a token came back even though an email carried it')
      assert(/not confirmed/i.test(stored.delivery_detail), 'delivery claims more than it knows')
    }
    assert(
      !/\bdelivered\b|\breceived\b/i.test(body.deliveryDetail ?? ''),
      'delivery claims receipt',
    )

    // The digest stored is the digest of the token that came back, and nothing
    // in the row is the token itself.
    if (body.token) {
      const matches = teamRow(
        sql(`select (token_digest = sha256(convert_to('${body.token}', 'utf8'))) as ok
           from public.organization_invitations where id = '${body.invitationId}';`),
      ).ok
      assert(matches === true, 'the row does not hold the digest of the returned token')
    }

    sql(`delete from public.organization_invitations where id = '${body.invitationId}';`)
    return `created through the function; delivery reported as ${body.delivery}`
  },
)

await check('team: the Edge Function will not invite on a staff member’s behalf', async () => {
  const token = (await teamStaffClient.auth.getSession()).data.session.access_token
  const response = await fetch(`${URL}/functions/v1/team-invitations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      action: 'create',
      organization_id: teamOrg,
      email: `staff-escalation-${STAMP}@atlasloca.com`,
      role: 'admin',
    }),
  })
  assert(response.status === 403, `status was ${response.status}`)
  const body = await response.json()
  assert(/cannot invite/i.test(body.error.message), `message was ${body.error.message}`)

  const created = teamRow(
    sql(`select count(*)::int as n from public.organization_invitations
         where email_normalized = 'staff-escalation-${STAMP}@atlasloca.com';`),
  ).n
  assert(created === 0, 'an invitation was created anyway')
  return 'service-role bypass is not tenant bypass: the caller’s own token decided'
})

await check('team: the old link stops working the moment a new one is issued', async () => {
  const recruitId = seedConfirmedUser(
    { email: teamEmail('recruit'), password: teamPassword },
    { full_name: 'Team Recruit' },
  )
  teamRecruitId = recruitId
  teamRecruitClient = await teamSignIn(teamEmail('recruit'))

  const stale = await teamRecruitClient.rpc('accept_team_invitation', { p_token: teamOldToken })
  assert(stale.error, 'the rotated-out token still worked')
  assert(/not valid/i.test(stale.error.message), `message was ${stale.error.message}`)
  return 'the pre-resend link is dead'
})

await check('team: sign-up for an invited address provisions no agency', async () => {
  // The recruit was seeded above with no organization_name at all; this proves
  // the database refuses even when the metadata asks for one.
  const forced = seedConfirmedUser(
    { email: teamEmail('forced'), password: teamPassword },
    { full_name: 'Forced', organization_name: `Accidental ${STAMP}` },
  )
  teamForcedId = forced

  await teamInvite(teamOwnerClient, teamOrg, teamEmail('invited-first'), 'staff')
  const invitedFirst = seedConfirmedUser(
    { email: teamEmail('invited-first'), password: teamPassword },
    { full_name: 'Invited First', organization_name: `Should Not Exist ${STAMP}` },
  )
  teamInvitedFirstId = invitedFirst

  const rows = teamRow(
    sql(`select
           (select count(*)::int from public.organizations where name = 'Accidental ${STAMP}') as forced,
           (select count(*)::int from public.organizations where name = 'Should Not Exist ${STAMP}') as invited,
           (select count(*)::int from public.organization_members where user_id = '${invitedFirst}') as memberships;`),
  )
  // Somebody signing up independently still gets their agency.
  assert(rows.forced === 1, 'independent sign-up stopped provisioning an agency')
  assert(rows.invited === 0, 'an invited sign-up provisioned a second agency')
  assert(rows.memberships === 0, 'an invited sign-up joined something on its own')

  sql(`delete from public.organizations where name = 'Accidental ${STAMP}';`)
  return 'independent sign-up provisions; an invited one does not, whatever the browser sent'
})

await check('team: a wrong account cannot accept somebody else’s invitation', async () => {
  const { error } = await teamStaffClient.rpc('accept_team_invitation', {
    p_token: teamInvitationToken,
  })
  assert(error, 'the wrong account accepted')
  assert(/different account/i.test(error.message), `message was ${error.message}`)
  return 'the verified Auth email decides, not a claim from the browser'
})

await check('team: an unconfirmed account cannot accept', async () => {
  sql(`update auth.users set email_confirmed_at = null where id = '${teamRecruitId}';`)
  const { error } = await teamRecruitClient.rpc('accept_team_invitation', {
    p_token: teamInvitationToken,
  })
  assert(error, 'an unconfirmed account accepted')
  assert(/confirm your email/i.test(error.message), `message was ${error.message}`)
  sql(`update auth.users set email_confirmed_at = now() where id = '${teamRecruitId}';`)
  return 'possession of a link is not a verified address'
})

await check(
  'team: accepting creates exactly one membership and closes the invitation',
  async () => {
    const { data, error } = await teamRecruitClient.rpc('accept_team_invitation', {
      p_token: teamInvitationToken,
    })
    assert(!error, error?.message)
    assert(data[0].outcome === 'joined', `outcome was ${data[0].outcome}`)
    assert(data[0].role === 'manager', `role was ${data[0].role}`)

    const state = teamRow(
      sql(`select
           (select count(*)::int from public.organization_members
             where organization_id = '${teamOrg}' and user_id = '${teamRecruitId}') as memberships,
           (select accepted_by::text from public.organization_invitations where id = '${teamInvitationId}') as accepted_by,
           (select count(*)::int from public.organization_team_events
             where organization_id = '${teamOrg}' and event = 'invitation_accepted') as events;`),
    )
    assert(state.memberships === 1, `${state.memberships} memberships`)
    assert(state.accepted_by === teamRecruitId, 'the invitation records the wrong acceptor')
    assert(state.events === 1, `${state.events} acceptance events`)
    return 'one membership, one event, invitation closed'
  },
)

await check('team: the same link cannot be used a second time', async () => {
  const { data, error } = await teamRecruitClient.rpc('accept_team_invitation', {
    p_token: teamInvitationToken,
  })
  assert(!error, error?.message)
  assert(data[0].outcome === 'already_member', `outcome was ${data[0].outcome}`)

  const memberships = teamRow(
    sql(`select count(*)::int as n from public.organization_members
         where organization_id = '${teamOrg}' and user_id = '${teamRecruitId}';`),
  ).n
  assert(memberships === 1, `${memberships} memberships after a second acceptance`)
  return 'idempotent, and still one membership'
})

await check('team: one person can hold two agencies at once', async () => {
  const rival = await teamInvite(teamRivalClient, teamRivalOrg, teamEmail('recruit'), 'staff')
  const { data, error } = await teamRecruitClient.rpc('accept_team_invitation', {
    p_token: rival.token,
  })
  assert(!error, error?.message)
  assert(data[0].outcome === 'joined', `outcome was ${data[0].outcome}`)

  const both = teamRow(
    sql(
      `select count(*)::int as n from public.organization_members where user_id = '${teamRecruitId}';`,
    ),
  ).n
  assert(both === 2, `${both} memberships`)

  const { data: workspaces } = await teamRecruitClient.from('organizations').select('id')
  assert(workspaces.length === 2, `the workspace list shows ${workspaces.length}`)
  return 'manager of one agency and staff of another, both intact'
})

await check('team: a revoked invitation cannot be accepted', async () => {
  const invitation = await teamInvite(teamOwnerClient, teamOrg, teamEmail('withdrawn'), 'staff')
  const withdrawnId = seedConfirmedUser(
    { email: teamEmail('withdrawn'), password: teamPassword },
    { full_name: 'Withdrawn' },
  )
  const withdrawnClient = await teamSignIn(teamEmail('withdrawn'))

  const { error: revokeError } = await teamOwnerClient.rpc('revoke_team_invitation', {
    p_invitation_id: invitation.invitationId ?? invitation.invitation_id,
    p_reason: 'Withdrawn during the smoke test.',
  })
  assert(!revokeError, revokeError?.message)

  const { error } = await withdrawnClient.rpc('accept_team_invitation', {
    p_token: invitation.token,
  })
  assert(error, 'a revoked invitation was accepted')
  assert(/not valid|withdrawn/i.test(error.message), `message was ${error.message}`)

  const kept = teamRow(
    sql(`select revoke_reason from public.organization_invitations
         where email_normalized = '${teamEmail('withdrawn')}';`),
  ).revoke_reason
  assert(
    kept === 'Withdrawn during the smoke test.',
    'the evidence was destroyed with the capability',
  )
  teamWithdrawnId = withdrawnId
  return 'the token is dead; the record of it is not'
})

await check('team: an expired invitation cannot be accepted', async () => {
  const expiredToken = `smoke-expired-${STAMP}-${'x'.repeat(30)}`
  sql(`insert into public.organization_invitations
         (organization_id, email, email_normalized, role, invited_by, created_at, expires_at, token_digest)
       values ('${teamOrg}', '${teamEmail('expired')}', '${teamEmail('expired')}', 'staff',
               '${teamOwnerId}', now() - interval '10 days', now() - interval '3 days',
               sha256(convert_to('${expiredToken}', 'utf8')));`)
  seedConfirmedUser(
    { email: teamEmail('expired'), password: teamPassword },
    { full_name: 'Expired' },
  )
  const expiredClient = await teamSignIn(teamEmail('expired'))

  const { error } = await expiredClient.rpc('accept_team_invitation', { p_token: expiredToken })
  assert(error, 'an expired invitation was accepted')
  assert(/expired/i.test(error.message), `message was ${error.message}`)

  const { data } = await teamOwnerClient.rpc('team_invitations', {
    p_organization_id: teamOrg,
    p_include_history: true,
  })
  const listed = data.find((row) => row.email === teamEmail('expired'))
  assert(listed?.state === 'expired', `the list says ${listed?.state}`)
  return 'refused, and still legible in the interface'
})

await check(
  'team: a demoted administrator’s outstanding invitation dies with the demotion',
  async () => {
    const latent = await teamInvite(teamAdminClient, teamOrg, teamEmail('latent'), 'admin')
    seedConfirmedUser(
      { email: teamEmail('latent'), password: teamPassword },
      { full_name: 'Latent' },
    )
    const latentClient = await teamSignIn(teamEmail('latent'))

    const { error: demoteError } = await teamOwnerClient.rpc('change_team_member_role', {
      p_organization_id: teamOrg,
      p_user_id: teamAdminId,
      p_role: 'staff',
    })
    assert(!demoteError, demoteError?.message)

    const { error } = await latentClient.rpc('accept_team_invitation', { p_token: latent.token })
    assert(error, 'a latent grant survived the demotion')

    const revoked = teamRow(
      sql(`select revoked_at is not null as revoked from public.organization_invitations
         where email_normalized = '${teamEmail('latent')}';`),
    ).revoked
    assert(revoked === true, 'the invitation was not revoked')

    // Put the administrator back for the checks that follow.
    const { error: restore } = await teamOwnerClient.rpc('change_team_member_role', {
      p_organization_id: teamOrg,
      p_user_id: teamAdminId,
      p_role: 'admin',
    })
    assert(!restore, restore?.message)
    return 'a role they can no longer grant leaves nothing behind'
  },
)

await check('team: a demoted session immediately loses the authority it held', async () => {
  // Same client, same access token, no sign-out anywhere.
  const before = await teamAdminClient.rpc('team_invitations', { p_organization_id: teamOrg })
  assert(!before.error, `the administrator could not read invitations: ${before.error?.message}`)

  const { error: demote } = await teamOwnerClient.rpc('change_team_member_role', {
    p_organization_id: teamOrg,
    p_user_id: teamAdminId,
    p_role: 'staff',
  })
  assert(!demote, demote?.message)

  const after = await teamAdminClient.rpc('team_invitations', { p_organization_id: teamOrg })
  assert(
    after.error?.code === '42501',
    `after demotion the read gave ${after.error?.code ?? 'data'}`,
  )

  const invite = await teamAdminClient.rpc('create_team_invitation', {
    p_organization_id: teamOrg,
    p_email: `after-demotion-${STAMP}@atlasloca.com`,
    p_role: 'staff',
  })
  assert(invite.error?.code === '42501', `inviting gave ${invite.error?.code}`)

  /*
   * The whole authorization matrix, on the SAME session, with no sign-out.
   *
   * Membership is the authority; the access token is not. Every module below
   * reads the same membership row, so a demotion has to land in all of them at
   * once — which is exactly what a Team module can break for the entire product.
   */
  const vehicle = await teamAdminClient.from('vehicles').insert({
    organization_id: teamOrg,
    make: 'Escalation',
    model: 'Probe',
    registration_plate: `ESC-${STAMP}`,
    currency: 'MAD',
  })
  assert(vehicle.error, 'a demoted administrator could still add a vehicle')

  const financing = await teamAdminClient
    .from('financing_agreements')
    .insert({ organization_id: teamOrg, vehicle_id: null })
  assert(financing.error, 'a demoted administrator could still write financing')

  const expense = await teamAdminClient.from('expenses').insert({
    organization_id: teamOrg,
    amount_minor: 100,
    currency: 'MAD',
    incurred_on: '2026-08-01',
    allocation: 'overhead',
  })
  assert(expense.error, 'a demoted administrator could still record a cost')

  // Reports are a manager's; staff has none.
  const reports = await teamAdminClient.rpc('report_business_summary', {
    p_organization_id: teamOrg,
    p_from: '2026-01-01',
    p_to: '2027-01-01',
  })
  assert(reports.error?.code === '42501', `reports gave ${reports.error?.code ?? 'data'}`)

  // Tracking administration goes through the Edge Function, which resolves the
  // caller's role itself.
  const staffToken = (await teamAdminClient.auth.getSession()).data.session.access_token
  const gps = await fetch(`${URL}/functions/v1/gps-provider`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: KEY,
      Authorization: `Bearer ${staffToken}`,
    },
    body: JSON.stringify({
      action: 'save',
      organizationId: teamOrg,
      provider: 'wialon',
      token: 'x'.repeat(72),
    }),
  })
  assert(gps.status === 403 || gps.status === 400, `GPS admin gave ${gps.status}`)

  // And keeps what staff legitimately has.
  const customers = await teamAdminClient.from('customers').select('id').limit(1)
  assert(!customers.error, `staff lost customer access: ${customers.error?.message}`)
  const rentals = await teamAdminClient.from('rentals').select('id').limit(1)
  assert(!rentals.error, `staff lost rental access: ${rentals.error?.message}`)

  const { error: restore } = await teamOwnerClient.rpc('change_team_member_role', {
    p_organization_id: teamOrg,
    p_user_id: teamAdminId,
    p_role: 'admin',
  })
  assert(!restore, restore?.message)
  return 'authority is membership, not the token in the browser'
})

await check('team: self-promotion is refused at every rank', async () => {
  const attempts = [
    [teamStaffClient, teamStaffId, 'manager'],
    [teamManagerClient, teamManagerId, 'admin'],
    [teamAdminClient, teamAdminId, 'owner'],
    [teamAdminClient, teamAdminId, 'admin'],
  ]
  for (const [asClient, userId, role] of attempts) {
    const { error } = await asClient.rpc('change_team_member_role', {
      p_organization_id: teamOrg,
      p_user_id: userId,
      p_role: role,
    })
    assert(error, `a self-change to ${role} succeeded`)
  }

  const roles = teamRow(
    sql(`select
           (select role::text from public.organization_members where user_id = '${teamStaffId}') as staff,
           (select role::text from public.organization_members where user_id = '${teamManagerId}') as manager,
           (select role::text from public.organization_members where user_id = '${teamAdminId}') as admin;`),
  )
  assert(
    roles.staff === 'staff' && roles.manager === 'manager' && roles.admin === 'admin',
    JSON.stringify(roles),
  )
  return 'nobody edits their own row, in either direction'
})

await check('team: an administrator cannot reach the owner', async () => {
  const demote = await teamAdminClient.rpc('change_team_member_role', {
    p_organization_id: teamOrg,
    p_user_id: teamOwnerId,
    p_role: 'staff',
  })
  assert(demote.error?.code === '42501', `demotion gave ${demote.error?.code}`)

  const remove = await teamAdminClient.rpc('remove_team_member', {
    p_organization_id: teamOrg,
    p_user_id: teamOwnerId,
  })
  assert(remove.error?.code === '42501', `removal gave ${remove.error?.code}`)

  const transfer = await teamAdminClient.rpc('transfer_organization_ownership', {
    p_organization_id: teamOrg,
    p_user_id: teamAdminId,
  })
  assert(transfer.error?.code === '42501', `transfer gave ${transfer.error?.code}`)

  const role = teamRow(
    sql(
      `select role::text as role from public.organization_members where user_id = '${teamOwnerId}';`,
    ),
  ).role
  assert(role === 'owner', `the owner is now ${role}`)
  return 'demote, remove and transfer all refused'
})

await check('team: the last owner cannot leave, be removed or be demoted', async () => {
  const leave = await teamOwnerClient.rpc('leave_organization', { p_organization_id: teamOrg })
  assert(leave.error, 'the last owner left')
  assert(/transfer ownership/i.test(leave.error.message), `message was ${leave.error.message}`)

  const selfRemove = await teamOwnerClient.rpc('remove_team_member', {
    p_organization_id: teamOrg,
    p_user_id: teamOwnerId,
  })
  assert(selfRemove.error, 'the owner removed themselves through the generic path')

  const selfDemote = await teamOwnerClient.rpc('change_team_member_role', {
    p_organization_id: teamOrg,
    p_user_id: teamOwnerId,
    p_role: 'admin',
  })
  assert(selfDemote.error, 'the owner demoted themselves')

  const owners = teamRow(
    sql(`select count(*)::int as n from public.organization_members
         where organization_id = '${teamOrg}' and role = 'owner' and status = 'active';`),
  ).n
  assert(owners === 1, `${owners} owners`)
  return 'the agency still has exactly one owner'
})

await check('team: removal revokes access instantly for a live session', async () => {
  const doomed = seedConfirmedUser(
    { email: teamEmail('doomed'), password: teamPassword },
    { full_name: 'Doomed Member' },
  )
  teamDoomedId = doomed
  sql(`insert into public.organization_members (organization_id, user_id, role, status)
       values ('${teamOrg}', '${doomed}', 'manager', 'active');`)
  const doomedClient = await teamSignIn(teamEmail('doomed'))

  // Something they made, which must survive them.
  const plate = `TEAM-${STAMP}`
  sql(`insert into public.vehicles (organization_id, make, model, registration_plate, currency, created_by)
       values ('${teamOrg}', 'Renault', 'Clio', '${plate}', 'MAD', '${doomed}');`)

  const before = await doomedClient.from('vehicles').select('id').limit(1)
  assert(!before.error, `the member could not read vehicles: ${before.error?.message}`)

  const { error } = await teamOwnerClient.rpc('remove_team_member', {
    p_organization_id: teamOrg,
    p_user_id: doomed,
  })
  assert(!error, error?.message)

  // Same client, same access token, nothing refreshed. Every module that reads
  // membership, including the two read models the Calendar and Tracking use.
  for (const table of [
    'vehicles',
    'customers',
    'rentals',
    'rental_schedule',
    'expenses',
    'payments',
    'financing_agreements',
    'gps_fleet',
    'organizations',
    'organization_members',
  ]) {
    const { data } = await doomedClient.from(table).select('*').limit(1)
    assert((data ?? []).length === 0, `a removed member still read ${table}`)
  }
  for (const rpc of [
    'organization_overview',
    'report_business_summary',
    'report_fleet_performance',
    'team_directory',
  ]) {
    const args =
      rpc === 'team_directory'
        ? { p_organization_id: teamOrg }
        : rpc === 'organization_overview'
          ? { p_organization_id: teamOrg, p_from: '2026-01-01', p_to: '2027-01-01' }
          : { p_organization_id: teamOrg, p_from: '2026-01-01', p_to: '2027-01-01' }
    const { error: rpcError } = await doomedClient.rpc(rpc, args)
    assert(rpcError, `a removed member still called ${rpc}`)
  }

  const survived = teamRow(
    sql(`select
           (select created_by::text from public.vehicles where registration_plate = '${plate}') as created_by,
           (select count(*)::int from public.profiles where id = '${doomed}') as profile,
           (select count(*)::int from auth.users where id = '${doomed}') as account;`),
  )
  assert(survived.created_by === doomed, 'attribution was rewritten')
  assert(survived.profile === 1, 'the profile was deleted')
  assert(survived.account === 1, 'the Auth account was deleted')

  /*
   * And their OTHER agency still works, on the same session. Removal is scoped
   * to one membership; a person who consults for two fleets does not lose both
   * because one of them let them go.
   */
  sql(`insert into public.organization_members (organization_id, user_id, role, status)
       values ('${teamRivalOrg}', '${doomed}', 'manager', 'active')
       on conflict (organization_id, user_id) do nothing;`)

  const elsewhere = await doomedClient.from('organizations').select('id')
  assert(
    (elsewhere.data ?? []).some((row) => row.id === teamRivalOrg),
    'the removed member lost an unrelated agency too',
  )
  const elsewhereRoster = await doomedClient.rpc('team_directory', {
    p_organization_id: teamRivalOrg,
  })
  assert(!elsewhereRoster.error, `their other agency broke: ${elsewhereRoster.error?.message}`)

  return 'access gone here; the account, the profile, the work and their other agency all intact'
})

await check(
  'team: tracking still resolves a role once an agency has more than one member',
  async () => {
    /*
     * The defect this covers was pre-existing and latent, and Team is what made
     * it reachable: gps-provider resolved the caller's role with a query filtered
     * only by organization, so `.maybeSingle()` failed the moment a second person
     * joined and every tracking action answered "Only an administrator can do
     * that" — to the owner.
     *
     * This agency now has several members. A 403 with a permission category is
     * the symptom; anything else (including "connection not found") means the
     * role resolved.
     */
    const ownerToken = (await teamOwnerClient.auth.getSession()).data.session.access_token
    const response = await fetch(`${URL}/functions/v1/gps-provider`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: KEY,
        Authorization: `Bearer ${ownerToken}`,
      },
      body: JSON.stringify({
        action: 'disconnect',
        connectionId: '00000000-0000-0000-0000-000000000000',
      }),
    })
    const body = await response.json()

    const members = teamRow(
      sql(`select count(*)::int as n from public.organization_members
         where organization_id = '${teamOrg}' and status = 'active';`),
    ).n
    assert(members > 1, `the agency has ${members} members; this check needs more than one`)

    assert(
      body?.error?.category !== 'permission_denied',
      `the owner of a ${members}-member agency was refused tracking on role grounds`,
    )
    return `${members} members, and the owner's role still resolves (answer: ${body?.error?.category ?? 'ok'})`
  },
)

await check('team: the history names people who are no longer members', async () => {
  const { data, error } = await teamOwnerClient.rpc('team_events', { p_organization_id: teamOrg })
  assert(!error, error?.message)

  const removal = data.find((row) => row.event === 'member_removed')
  assert(removal, 'no removal event was recorded')
  assert(removal.target_name === 'Doomed Member', `target was "${removal.target_name}"`)
  assert(removal.actor_name === 'Team Owner', `actor was "${removal.actor_name}"`)
  assert(removal.previous_role === 'manager', `previous role was ${removal.previous_role}`)
  return 'snapshotted at the time, so it survives the departure it records'
})

await check('team: a non-owner can leave and keeps their other agency', async () => {
  const { error } = await teamRecruitClient.rpc('leave_organization', {
    p_organization_id: teamOrg,
  })
  assert(!error, error?.message)

  const remaining = teamRow(
    sql(`select
           (select count(*)::int from public.organization_members
             where organization_id = '${teamOrg}' and user_id = '${teamRecruitId}') as here,
           (select count(*)::int from public.organization_members
             where organization_id = '${teamRivalOrg}' and user_id = '${teamRecruitId}') as elsewhere;`),
  )
  assert(remaining.here === 0, 'they are still a member here')
  assert(remaining.elsewhere === 1, 'leaving one agency removed them from another')
  return 'one membership gone, the other untouched'
})

await check('team: ownership transfer is one transaction, and moves exactly once', async () => {
  const { error } = await teamOwnerClient.rpc('transfer_organization_ownership', {
    p_organization_id: teamOrg,
    p_user_id: teamAdminId,
    p_outgoing_role: 'admin',
  })
  assert(!error, error?.message)

  const after = teamRow(
    sql(`select
           (select role::text from public.organization_members where user_id = '${teamAdminId}') as heir,
           (select role::text from public.organization_members where user_id = '${teamOwnerId}') as previous,
           (select count(*)::int from public.organization_members
             where organization_id = '${teamOrg}' and role = 'owner' and status = 'active') as owners;`),
  )
  assert(after.heir === 'owner', `the heir is ${after.heir}`)
  assert(after.previous === 'admin', `the previous owner is ${after.previous}`)
  assert(after.owners === 1, `${after.owners} owners`)

  // The outgoing owner immediately loses owner-only authority on the same session.
  const again = await teamOwnerClient.rpc('transfer_organization_ownership', {
    p_organization_id: teamOrg,
    p_user_id: teamManagerId,
  })
  assert(again.error?.code === '42501', `a second transfer gave ${again.error?.code}`)

  // Hand it back so the rest of the run reads normally.
  const { error: back } = await teamAdminClient.rpc('transfer_organization_ownership', {
    p_organization_id: teamOrg,
    p_user_id: teamOwnerId,
    p_outgoing_role: 'admin',
  })
  assert(!back, back?.message)
  return 'one owner throughout, and the outgoing owner cannot transfer again'
})

await check('team: two administrators inviting the same address concurrently', async () => {
  const address = `race-invite-${STAMP}@atlasloca.com`
  const [first, second] = await Promise.all([
    teamOwnerClient.rpc('create_team_invitation', {
      p_organization_id: teamOrg,
      p_email: address,
      p_role: 'staff',
    }),
    teamAdminClient.rpc('create_team_invitation', {
      p_organization_id: teamOrg,
      p_email: address,
      p_role: 'manager',
    }),
  ])

  const succeeded = [first, second].filter((result) => !result.error)
  assert(succeeded.length >= 1, 'both concurrent invitations failed')

  const open = teamRow(
    sql(`select count(*)::int as n from public.organization_invitations
         where organization_id = '${teamOrg}' and email_normalized = '${address}'
           and accepted_at is null and revoked_at is null;`),
  ).n
  assert(open === 1, `${open} open invitations for one address after a race`)
  return `${succeeded.length} of 2 succeeded; exactly one open invitation`
})

await check('team: two tabs accepting the same invitation concurrently', async () => {
  const address = teamEmail('racer')
  const invitation = await teamInvite(teamOwnerClient, teamOrg, address, 'staff')
  const racerId = seedConfirmedUser(
    { email: address, password: teamPassword },
    { full_name: 'Racer' },
  )
  teamRacerId = racerId

  // Two independent sessions for the same person, which is what two tabs are.
  const tabOne = await teamSignIn(address)
  const tabTwo = await teamSignIn(address)

  const [a, b] = await Promise.all([
    tabOne.rpc('accept_team_invitation', { p_token: invitation.token }),
    tabTwo.rpc('accept_team_invitation', { p_token: invitation.token }),
  ])

  const outcomes = [a, b].filter((r) => !r.error).map((r) => r.data[0].outcome)
  assert(outcomes.length === 2, `one tab errored: ${a.error?.message ?? b.error?.message}`)
  assert(
    outcomes.filter((o) => o === 'joined').length === 1,
    `outcomes were ${outcomes.join(', ')}`,
  )

  const state = teamRow(
    sql(`select
           (select count(*)::int from public.organization_members
             where organization_id = '${teamOrg}' and user_id = '${racerId}') as memberships,
           (select count(*)::int from public.organization_team_events
             where organization_id = '${teamOrg}' and event = 'invitation_accepted'
               and target_user_id = '${racerId}') as events;`),
  )
  assert(state.memberships === 1, `${state.memberships} memberships from a double acceptance`)
  assert(state.events === 1, `${state.events} acceptance events`)
  return 'exactly one membership and one event; the loser was told it was already a member'
})

await check('team: a transfer and a removal racing cannot produce zero owners', async () => {
  const [transfer, removal] = await Promise.all([
    teamOwnerClient.rpc('transfer_organization_ownership', {
      p_organization_id: teamOrg,
      p_user_id: teamAdminId,
      p_outgoing_role: 'admin',
    }),
    teamOwnerClient.rpc('remove_team_member', {
      p_organization_id: teamOrg,
      p_user_id: teamAdminId,
    }),
  ])

  const owners = teamRow(
    sql(`select count(*)::int as n from public.organization_members
         where organization_id = '${teamOrg}' and role = 'owner' and status = 'active';`),
  ).n
  assert(owners === 1, `${owners} owners after a transfer racing a removal`)

  const outcome =
    transfer.error && removal.error
      ? 'both refused'
      : transfer.error
        ? 'the removal won'
        : removal.error
          ? 'the transfer won'
          : 'both applied in order'
  return `one owner survives — ${outcome}`
})

await check('team: two concurrent transfers leave one coherent owner', async () => {
  // Whoever holds ownership at this point does the asking; the other request is
  // the one that has to be refused or serialised.
  const ownerNow = teamRow(
    sql(`select user_id::text as id from public.organization_members
         where organization_id = '${teamOrg}' and role = 'owner' and status = 'active';`),
  ).id
  const asOwner = ownerNow === teamOwnerId ? teamOwnerClient : teamAdminClient

  const [a, b] = await Promise.all([
    asOwner.rpc('transfer_organization_ownership', {
      p_organization_id: teamOrg,
      p_user_id: teamManagerId,
      p_outgoing_role: 'admin',
    }),
    asOwner.rpc('transfer_organization_ownership', {
      p_organization_id: teamOrg,
      p_user_id: teamStaffId,
      p_outgoing_role: 'admin',
    }),
  ])

  const state = teamRow(
    sql(`select count(*)::int as owners,
                max(user_id::text) filter (where role = 'owner' and status = 'active') as owner
         from public.organization_members
         where organization_id = '${teamOrg}' and role = 'owner' and status = 'active';`),
  )
  assert(state.owners === 1, `${state.owners} owners after two concurrent transfers`)
  assert(
    [teamManagerId, teamStaffId].includes(state.owner),
    'ownership landed on somebody neither request named',
  )

  const won = [a, b].filter((r) => !r.error).length
  return `${won} of 2 applied; exactly one owner, and it is one of the two named targets`
})

await check('team: create, resend and accept race without deadlocking', async () => {
  /*
   * The regression this covers is one the review fixes INTRODUCED.
   *
   * Adding the per-agency advisory lock to the invitation paths left `create`
   * taking advisory-then-row while `resend` and `accept` took row-then-advisory.
   * That is a lock-order inversion: each holds what the other is waiting for and
   * PostgreSQL resolves it by aborting one with SQLSTATE 40P01.
   *
   * A domain refusal here is fine — these operations legitimately contend, and
   * one of them is meant to lose. A deadlock is not, and only real concurrent
   * connections can tell the two apart, which is why this lives here and not in
   * the single-connection schema suite.
   */
  // Named through teamEmail() so the final cleanup sweep matches it. Naming a
  // fixture outside that pattern is how two accounts survived a run.
  const address = teamEmail('lockrace')
  const seeded = await teamInvite(teamOwnerClient, teamOrg, address, 'staff')
  seedConfirmedUser({ email: address, password: teamPassword }, { full_name: 'Lock Racer' })
  const racerClient = await teamSignIn(address)
  teamAgeInvitation(seeded.invitationId ?? seeded.invitation_id)

  const deadlocks = []
  const record = (label, error) => {
    if (error && (error.code === '40P01' || /deadlock/i.test(error.message ?? ''))) {
      deadlocks.push(`${label}: ${error.message}`)
    }
  }

  // Three rounds, each pitting a different pair against each other on the same
  // agency and the same invitation row.
  for (let round = 0; round < 3; round += 1) {
    const [a, b, c] = await Promise.all([
      teamOwnerClient.rpc('create_team_invitation', {
        p_organization_id: teamOrg,
        p_email: teamEmail(`lockrace-${round}`),
        p_role: 'staff',
      }),
      teamAdminClient.rpc('resend_team_invitation', {
        p_invitation_id: seeded.invitationId ?? seeded.invitation_id,
      }),
      racerClient.rpc('accept_team_invitation', { p_token: seeded.token }),
    ])

    record('create', a.error)
    record('resend', b.error)
    record('accept', c.error)
  }

  assert(deadlocks.length === 0, `deadlock detected: ${deadlocks.join(' | ')}`)

  // Whatever the interleaving, the agency is left coherent: at most one
  // membership for the racer, and at most one open invitation for the address.
  const state = teamRow(
    sql(`select
           (select count(*)::int from public.organization_members
             where organization_id = '${teamOrg}'
               and user_id = (select id from auth.users where email = '${address}')) as memberships,
           (select count(*)::int from public.organization_invitations
             where organization_id = '${teamOrg}' and email_normalized = '${address}'
               and accepted_at is null and revoked_at is null) as open;`),
  )
  assert(state.memberships <= 1, `${state.memberships} memberships after the race`)
  assert(state.open <= 1, `${state.open} open invitations after the race`)

  sql(`delete from public.organization_invitations
        where organization_id = '${teamOrg}'
          and email_normalized like 'smoke-team-lockrace%';`)
  return `9 concurrent invitation operations, no deadlock; ${state.memberships} membership, ${state.open} open invitation`
})

await check('team: freeze_columns needs no auth.users privilege from a client', async () => {
  /*
   * The other regression the review fixes introduced. Teaching freeze_columns to
   * ask whether an Auth account still exists gave it a read of auth.users, which
   * no client role holds — so as a SECURITY INVOKER function it turned an
   * ordinary edit that echoed `created_by: null` back into "permission denied
   * for table users" and lost the whole update.
   */
  const plate = `FRZ-${STAMP}`
  sql(`insert into public.vehicles
         (organization_id, make, model, registration_plate, currency, created_by)
       values ('${teamOrg}', 'Renault', 'Kangoo', '${plate}', 'MAD', '${teamOwnerId}');`)

  // A manager editing a vehicle, echoing the frozen provenance column back as
  // null exactly as a full-row client would.
  const { error } = await teamManagerClient
    .from('vehicles')
    .update({ model: 'Kangoo Express', created_by: null })
    .eq('registration_plate', plate)

  assert(!error, `a legitimate manager edit was refused: ${error?.message}`)

  const row = teamRow(
    sql(`select model, created_by::text as created_by
         from public.vehicles where registration_plate = '${plate}';`),
  )
  assert(row.model === 'Kangoo Express', `the edit did not land: model is ${row.model}`)
  assert(row.created_by === teamOwnerId, 'the frozen provenance column was rewritten')

  // And the function is not a wider grant than it needs.
  const guard = teamRow(
    sql(`select p.prosecdef as definer,
                coalesce(array_to_string(p.proconfig, ','), '') as config,
                has_function_privilege('anon', p.oid, 'EXECUTE') as anon
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'app' and p.proname = 'freeze_columns';`),
  )
  assert(guard.definer === true, 'freeze_columns is not SECURITY DEFINER')
  assert(/search_path=/.test(guard.config), 'freeze_columns has no explicit search_path')
  assert(guard.anon === false, 'anon can execute freeze_columns')

  sql(`delete from public.vehicles where registration_plate = '${plate}';`)
  return 'the edit landed, the provenance held, and no client needs auth.users'
})

await check('team: audit events cannot be edited or deleted by anybody', async () => {
  const eventId = teamRow(
    sql(`select id::text as id from public.organization_team_events
         where organization_id = '${teamOrg}' limit 1;`),
  )?.id
  assert(eventId, 'no events to attack')

  for (const asClient of [teamOwnerClient, teamAdminClient]) {
    const update = await asClient
      .from('organization_team_events')
      .update({ detail: 'rewritten' })
      .eq('id', eventId)
    assert(update.error, 'a client updated a team event')

    const remove = await asClient.from('organization_team_events').delete().eq('id', eventId)
    assert(remove.error, 'a client deleted a team event')
  }

  // And the trigger holds even where the grants do not apply.
  let triggerHeld = false
  try {
    sql(`update public.organization_team_events set detail = 'rewritten' where id = '${eventId}';`)
  } catch {
    triggerHeld = true
  }
  assert(triggerHeld, 'a privileged update rewrote history')
  return 'no grant, and a trigger behind it'
})

await check('team: anon has no reach into membership at all', async () => {
  const anon = client()
  for (const table of [
    'organization_members',
    'organization_invitations',
    'organization_team_events',
  ]) {
    const { error } = await anon.from(table).select('*').limit(1)
    assert(error?.code === '42501', `${table} gave anon ${error?.code ?? 'data'}`)
  }
  for (const rpc of [
    'team_directory',
    'team_invitations',
    'team_events',
    'team_seat_summary',
    'create_team_invitation',
    'accept_team_invitation',
    'change_team_member_role',
    'remove_team_member',
    'leave_organization',
    'transfer_organization_ownership',
    'preview_team_invitation',
  ]) {
    const { error } = await anon.rpc(rpc, {})
    assert(error, `anon executed ${rpc}`)
  }
  return 'three tables and eleven functions, all refused'
})

await check('team: every new function carries its intended grants', async () => {
  const grants = sql(`
    select p.proname,
           has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
           has_function_privilege('service_role', p.oid, 'EXECUTE') as service
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'team\\_%' or p.proname in (
      'create_team_invitation','resend_team_invitation','revoke_team_invitation',
      'accept_team_invitation','change_team_member_role','remove_team_member',
      'leave_organization','transfer_organization_ownership','record_invitation_delivery',
      'preview_team_invitation');`)
  const rows = grants.result ?? grants.rows ?? []
  assert(rows.length >= 13, `only ${rows.length} functions found`)

  for (const row of rows) {
    assert(row.anon === false, `${row.proname} is reachable by anon`)
    if (row.proname === 'preview_team_invitation') {
      assert(row.authed === false, 'preview_team_invitation is reachable by a signed-in user')
      assert(row.service === true, 'preview_team_invitation is not reachable by service_role')
    } else {
      assert(row.authed === true, `${row.proname} is not reachable by a signed-in user`)
    }
  }
  return `${rows.length} functions: nothing anonymous, the preview service-role only`
})

await check('team: the seat summary names one trustworthy owner', async () => {
  const { data, error } = await teamOwnerClient.rpc('team_seat_summary', {
    p_organization_id: teamOrg,
  })
  assert(!error, error?.message)
  const summary = data[0]
  assert(summary.owners === 1, `${summary.owners} owners`)
  assert(summary.owner_user_id, 'no owner identified')
  assert(summary.active_members >= 3, `${summary.active_members} active members`)
  return `${summary.active_members} members, ${summary.open_invitations} open invitations, one owner`
})

await check('team teardown leaves nothing of its own behind', async () => {
  // Memberships, invitations and events all cascade with their agency; what has
  // to go explicitly is the vehicle a removed member created, because a fixture
  // car is not part of the record this run is proving.
  sql(`delete from public.vehicles where registration_plate = 'TEAM-${STAMP}';`)

  const left = teamRow(
    sql(`select
           (select count(*)::int from public.vehicles where registration_plate like 'TEAM-${STAMP}%') as vehicles,
           (select count(*)::int from public.organizations where name = 'Accidental ${STAMP}') as stray;`),
  )
  assert(left.vehicles === 0, `${left.vehicles} fixture vehicles survived`)
  assert(left.stray === 0, 'a stray agency survived')
  return 'fixture vehicles removed; everything else leaves with the agencies'
})

// =============================================================================
// Notifications & reminders
//
// The feed is derived from live domain records on every call, so almost every
// check here is the same shape: make something true in the database, ask the
// feed, make it untrue, ask again. Nothing is ever "closed" — a condition stops
// appearing because it stopped being the case.
//
// All of it runs through PostgREST with real sessions, because the interesting
// question is not whether the SQL works but whether the SAME SQL tells a staff
// member less than it tells an owner, and refuses a stranger entirely.
// =============================================================================

const notifyPassword = 'SmokeTest!2026'
const notifyEmail = (who) => `smoke-notify-${who}-${STAMP}@atlasloca.com`
const notifyRow = (out) => (out.result ?? out.rows ?? [])[0]

let notifyOrg, notifyRivalOrg
let notifyOwnerId, notifyManagerId, notifyStaffId, notifyRivalId, notifyLateId
let notifyOwner, notifyManager, notifyStaff, notifyRival
let notifyVehicle, notifyVehicleTwo, notifyCustomer

/** The feed, as a role, through PostgREST. */
async function feedFor(asClient, scope = 'active', organizationId = notifyOrg) {
  const { data, error } = await asClient.rpc('notification_feed', {
    p_organization_id: organizationId,
    p_scope: scope,
  })
  assert(!error, error?.message)
  return data ?? []
}

async function unreadFor(asClient, organizationId = notifyOrg) {
  const { data, error } = await asClient.rpc('notification_unread_count', {
    p_organization_id: organizationId,
  })
  assert(!error, error?.message)
  return data
}

const kindsOf = (rows) => rows.map((r) => r.kind)

/** Removes every fixture rental, so the next check starts from a known feed. */
function notifyClearRentals() {
  sql(`delete from public.rentals where organization_id = '${notifyOrg}';`)
}

await check('notify: an agency with an owner, a manager, a staff member and a rival', async () => {
  notifyOwnerId = seedConfirmedUser(
    { email: notifyEmail('owner'), password: notifyPassword },
    { full_name: 'Notify Owner' },
  )
  notifyOrg = notifyRow(
    sql(`select (app.provision_organization(
           '${notifyOwnerId}'::uuid, 'Smoke Test Notify ${STAMP}', 'MA', 'MAD', 'Africa/Casablanca', 'en'
         )).id as id;`),
  ).id

  notifyRivalId = seedConfirmedUser(
    { email: notifyEmail('rival'), password: notifyPassword },
    { full_name: 'Notify Rival' },
  )
  notifyRivalOrg = notifyRow(
    sql(`select (app.provision_organization(
           '${notifyRivalId}'::uuid, 'Smoke Test Notify Rival ${STAMP}', 'MA', 'MAD', 'Africa/Casablanca', 'en'
         )).id as id;`),
  ).id

  for (const [who, role] of [
    ['manager', 'manager'],
    ['staff', 'staff'],
  ]) {
    const id = seedConfirmedUser(
      { email: notifyEmail(who), password: notifyPassword },
      { full_name: `Notify ${who}` },
    )
    sql(`insert into public.organization_members (organization_id, user_id, role, status)
         values ('${notifyOrg}', '${id}', '${role}', 'active');`)
    if (who === 'manager') notifyManagerId = id
    if (who === 'staff') notifyStaffId = id
  }

  const inserted = sql(`insert into public.vehicles
           (organization_id, make, model, registration_plate, currency, daily_rate_minor)
         values
           ('${notifyOrg}', 'Renault', 'Clio', 'NTF-${STAMP}-1', 'MAD', 30000),
           ('${notifyOrg}', 'Dacia', 'Logan', 'NTF-${STAMP}-2', 'MAD', 25000)
         returning id, registration_plate;`)
  const fleet = (inserted.result ?? inserted.rows ?? []).sort((a, b) =>
    a.registration_plate.localeCompare(b.registration_plate),
  )
  notifyVehicle = fleet[0].id
  notifyVehicleTwo = fleet[1].id

  notifyCustomer = notifyRow(
    sql(`insert into public.customers (organization_id, first_name, last_name)
         values ('${notifyOrg}', 'Nadia', 'Fassi') returning id;`),
  ).id

  notifyOwner = await teamSignIn(notifyEmail('owner'))
  notifyManager = await teamSignIn(notifyEmail('manager'))
  notifyStaff = await teamSignIn(notifyEmail('staff'))
  notifyRival = await teamSignIn(notifyEmail('rival'))

  return 'owner, manager, staff, a rival agency, two cars and a customer'
})

await check('notify: an empty agency has an empty feed and a zero badge', async () => {
  const rows = await feedFor(notifyOwner)
  assert(rows.length === 0, `${rows.length} notifications with nothing going on`)
  assert((await unreadFor(notifyOwner)) === 0, 'a badge above zero with nothing going on')
  return 'nothing invented out of an empty agency'
})

await check('notify: anon cannot call a single notification function', async () => {
  const anon = client()
  for (const [rpc, args] of [
    ['notification_feed', { p_organization_id: notifyOrg }],
    ['notification_unread_count', { p_organization_id: notifyOrg }],
    ['notification_mark_read', { p_organization_id: notifyOrg, p_fingerprint: 'x' }],
    ['notification_mark_all_read', { p_organization_id: notifyOrg }],
    ['notification_dismiss', { p_organization_id: notifyOrg, p_fingerprint: 'x' }],
    ['notification_snooze', { p_organization_id: notifyOrg, p_fingerprint: 'x', p_until: null }],
    ['notification_preferences_for', { p_organization_id: notifyOrg }],
    [
      'notification_preference_set',
      { p_organization_id: notifyOrg, p_category: 'rentals', p_muted: true },
    ],
  ]) {
    const { error } = await anon.rpc(rpc, args)
    assert(error, `${rpc} answered anon`)
  }
  return '8 functions, 8 refusals'
})

await check('notify: no client role can read or write a notification table', async () => {
  const tables = [
    'notification_states',
    'notification_preferences',
    'notification_events',
    'notification_event_recipients',
  ]
  for (const [name, asClient] of [
    ['anon', client()],
    ['owner', notifyOwner],
    ['manager', notifyManager],
  ]) {
    for (const table of tables) {
      const read = await asClient.from(table).select('*').limit(1)
      assert(read.error, `${name} could read ${table}`)
      const write = await asClient.from(table).insert({ organization_id: notifyOrg })
      assert(write.error, `${name} could write ${table}`)
    }
  }
  return '4 tables × 3 roles, no read and no write'
})

await check('notify: there is no way for a client to create a notification', async () => {
  /*
   * The rule this protects is the whole architecture: a notification is derived
   * from a domain fact, never posted. If any of these ever answers, somebody has
   * added a message bus and called it a notification system.
   */
  for (const rpc of [
    'create_notification',
    'notification_create',
    'send_notification',
    'notify_user',
    'notification_broadcast',
    'notification_push',
  ]) {
    const { error } = await notifyOwner.rpc(rpc, {})
    assert(error, `${rpc} exists and was callable`)
  }
  const found = notifyRow(
    sql(`select count(*)::int as n from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'app')
            and (p.proname like '%create%notification%' or p.proname like '%notification%create%'
                 or p.proname like 'send_%' or p.proname like 'notify_%');`),
  ).n
  assert(found === 0, `${found} creation-shaped functions exist`)
  return 'no creation surface, by name or by call'
})

await check('notify: a stranger is refused the feed, the badge and the preferences', async () => {
  for (const [rpc, args] of [
    ['notification_feed', { p_organization_id: notifyOrg }],
    ['notification_unread_count', { p_organization_id: notifyOrg }],
    ['notification_preferences_for', { p_organization_id: notifyOrg }],
    ['notification_mark_all_read', { p_organization_id: notifyOrg }],
  ]) {
    const { error } = await notifyRival.rpc(rpc, args)
    assert(error, `${rpc} answered a stranger`)
    assert(/not a member/i.test(error.message), `${rpc} said: ${error.message}`)
  }
  return 'refused by membership, not by a filter that returned nothing'
})

await check(
  'notify: an unknown scope is refused rather than quietly showing everything',
  async () => {
    const { error } = await notifyOwner.rpc('notification_feed', {
      p_organization_id: notifyOrg,
      p_scope: 'everything',
    })
    assert(error, 'an invented scope was accepted')
    assert(/unknown notification scope/i.test(error.message), error.message)
    return 'refused: ' + error.message.slice(0, 60)
  },
)

// ------------------------------------------------------------------ rentals

await check('notify: a confirmed pickup inside the window appears, with its record', async () => {
  const id = notifyRow(
    sql(`insert into public.rentals
           (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
            total_minor, confirmed_at)
         values ('${notifyOrg}', '${notifyVehicle}', '${notifyCustomer}',
                 now() + interval '6 hours', now() + interval '3 days', 'MAD', 'reserved', 90000, now())
         returning id;`),
  ).id

  const rows = await feedFor(notifyOwner)
  const pickup = rows.find((r) => r.kind === 'rental_pickup_due')
  assert(pickup, `no pickup notification: ${kindsOf(rows).join(',')}`)
  assert(pickup.action_path === `/rentals/${id}`, `points at ${pickup.action_path}`)
  assert(pickup.severity === 'attention', `severity ${pickup.severity}`)
  assert(pickup.category === 'rentals', `category ${pickup.category}`)
  return `${pickup.subject_label} → ${pickup.action_path}`
})

await check('notify: a booking beyond the window says nothing yet', async () => {
  notifyClearRentals()
  sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          total_minor, confirmed_at)
       values ('${notifyOrg}', '${notifyVehicle}', '${notifyCustomer}',
               now() + interval '9 days', now() + interval '11 days', 'MAD', 'reserved', 90000, now());`)
  const rows = await feedFor(notifyOwner)
  assert(!kindsOf(rows).includes('rental_pickup_due'), 'a pickup nine days out was announced')
  return 'the 48-hour window is a window'
})

await check('notify: a draft and a cancellation are not commitments', async () => {
  notifyClearRentals()
  sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values
         ('${notifyOrg}', '${notifyVehicle}', '${notifyCustomer}',
          now() + interval '5 hours', now() + interval '2 days', 'MAD', 'draft', 90000),
         ('${notifyOrg}', '${notifyVehicleTwo}', '${notifyCustomer}',
          now() + interval '5 hours', now() + interval '2 days', 'MAD', 'cancelled', 90000);`)
  const rows = await feedFor(notifyOwner)
  assert(rows.filter((r) => r.category === 'rentals').length === 0, 'a draft or cancellation spoke')
  return 'neither a draft nor a cancellation is a pickup'
})

await check('notify: an overdue return is urgent and matches rental_is_overdue', async () => {
  notifyClearRentals()
  const id = notifyRow(
    sql(`insert into public.rentals
           (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
         values ('${notifyOrg}', '${notifyVehicle}', '${notifyCustomer}',
                 now() - interval '4 days', now() - interval '5 hours', 'MAD', 'active', 90000)
         returning id;`),
  ).id

  // The database's own opinion, asked separately, must agree with the feed.
  const domain = notifyRow(
    sql(`select public.rental_is_overdue(status, ends_at, returned_at) as overdue
           from public.rentals where id = '${id}';`),
  ).overdue
  const rows = await feedFor(notifyOwner)
  const overdue = rows.find((r) => r.kind === 'rental_return_overdue')
  assert(domain === true, 'rental_is_overdue disagrees with the fixture')
  assert(overdue, 'the feed did not report an overdue return')
  assert(overdue.severity === 'urgent', `severity ${overdue.severity}`)
  return 'one formula, two callers, same answer'
})

await check('notify: bringing the car back resolves it, with nobody closing anything', async () => {
  const before = kindsOf(await feedFor(notifyOwner))
  assert(before.includes('rental_return_overdue'), 'nothing to resolve')

  sql(`update public.rentals set returned_at = now(), return_odometer = 41200
        where organization_id = '${notifyOrg}' and status = 'active';`)
  sql(`update public.rentals set status = 'completed', completed_at = now()
        where organization_id = '${notifyOrg}' and returned_at is not null;`)

  const after = kindsOf(await feedFor(notifyOwner))
  assert(!after.includes('rental_return_overdue'), 'the alert outlived the condition')
  return 'the condition stopped being true, so the notification stopped existing'
})

await check(
  'notify: an unpaid completed hire is a balance, and the deposit is not in it',
  async () => {
    notifyClearRentals()
    sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          total_minor, deposit_minor, deposit_held_minor, returned_at, return_odometer, completed_at)
       values ('${notifyOrg}', '${notifyVehicle}', '${notifyCustomer}',
               now() - interval '9 days', now() - interval '7 days', 'MAD', 'completed',
               80000, 50000, 50000, now() - interval '7 days', 41500, now() - interval '7 days');`)

    const rows = await feedFor(notifyOwner)
    const balance = rows.find((r) => r.kind === 'rental_balance_outstanding')
    assert(balance, 'no outstanding balance reported')
    assert(Number(balance.amount_minor) === 80000, `reported ${balance.amount_minor}, not 80000`)
    assert(balance.currency === 'MAD', `currency ${balance.currency}`)
    return `${balance.amount_minor} ${balance.currency} — the hire, not the hire plus the deposit`
  },
)

await check('notify: a held deposit on a paid hire says nothing at all', async () => {
  notifyClearRentals()
  sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status,
          total_minor, amount_paid_minor, deposit_minor, deposit_held_minor)
       values ('${notifyOrg}', '${notifyVehicle}', '${notifyCustomer}',
               now() - interval '1 day', now() + interval '6 days', 'MAD', 'active',
               80000, 80000, 50000, 50000);`)
  const rows = await feedFor(notifyOwner)
  assert(rows.filter((r) => r.category === 'rentals').length === 0, 'a deposit was called revenue')
  notifyClearRentals()
  return 'money being held is not money owed'
})

// --------------------------------------------------------------- compliance

await check('notify: compliance uses the agency’s own lead time', async () => {
  sql(`update public.organization_settings set compliance_reminder_lead_days = 10
        where organization_id = '${notifyOrg}';`)
  sql(`update public.vehicles
          set insurance_expires_on = (app.organization_today('${notifyOrg}') + 20)
        where id = '${notifyVehicle}';`)

  const quiet = await feedFor(notifyOwner)
  assert(
    !kindsOf(quiet).includes('vehicle_compliance_due'),
    'a 20-day expiry spoke under a 10-day threshold',
  )

  sql(`update public.organization_settings set compliance_reminder_lead_days = 30
        where organization_id = '${notifyOrg}';`)
  const loud = await feedFor(notifyOwner)
  assert(
    kindsOf(loud).includes('vehicle_compliance_due'),
    'a 20-day expiry stayed quiet at 30 days',
  )
  return 'the threshold the fleet list uses, not a number of its own'
})

await check('notify: due escalates to expired as a new episode', async () => {
  const due = (await feedFor(notifyOwner)).find((r) => r.kind === 'vehicle_compliance_due')
  assert(due, 'nothing was due')

  sql(`update public.vehicles
          set insurance_expires_on = (app.organization_today('${notifyOrg}') - 1)
        where id = '${notifyVehicle}';`)

  const rows = await feedFor(notifyOwner)
  const expired = rows.find((r) => r.kind === 'vehicle_compliance_expired')
  assert(expired, 'an expired document did not escalate')
  assert(expired.severity === 'urgent', `severity ${expired.severity}`)
  assert(expired.fingerprint !== due.fingerprint, 'the escalation reused the old episode')
  assert(!kindsOf(rows).includes('vehicle_compliance_due'), 'both episodes are showing')
  return 'a different fingerprint, so a dismissal of the warning cannot silence it'
})

await check('notify: correcting the date resolves it', async () => {
  sql(`update public.vehicles
          set insurance_expires_on = (app.organization_today('${notifyOrg}') + 400)
        where id = '${notifyVehicle}';`)
  const rows = await feedFor(notifyOwner)
  assert(
    rows.filter((r) => r.category === 'compliance').length === 0,
    'a renewed policy still spoke',
  )
  return 'renewed, and therefore silent'
})

await check('notify: a date nobody entered is not a vehicle driving uninsured', async () => {
  sql(`update public.vehicles set insurance_expires_on = null, inspection_expires_on = null,
                                  registration_expires_on = null
        where organization_id = '${notifyOrg}';`)
  const rows = await feedFor(notifyOwner)
  assert(
    rows.filter((r) => r.category === 'compliance').length === 0,
    'a missing date was an alert',
  )
  return 'a data-entry gap is not a compliance failure'
})

await check('notify: an archived vehicle is not the fleet’s problem', async () => {
  // Availability is derived, never stored — writing a status here is refused by
  // the fleet's own guard, which is exactly what makes archived_at the fact.
  sql(`update public.vehicles
          set insurance_expires_on = (app.organization_today('${notifyOrg}') - 5),
              archived_at = now()
        where id = '${notifyVehicleTwo}';`)
  const rows = await feedFor(notifyOwner)
  assert(rows.filter((r) => r.category === 'compliance').length === 0, 'an archived car spoke')
  sql(`update public.vehicles set archived_at = null, insurance_expires_on = null
        where id = '${notifyVehicleTwo}';`)
  return 'archived is out of service, not out of compliance'
})

// ---------------------------------------------------------------- financing

await check('notify: an overdue instalment reaches a manager', async () => {
  const lender = notifyRow(
    sql(`insert into public.lenders (organization_id, name)
         values ('${notifyOrg}', 'Notify Bank ${STAMP}') returning id;`),
  ).id
  const agreement = notifyRow(
    sql(`insert into public.financing_agreements
           (organization_id, vehicle_id, lender_id, agreement_type, mode, currency,
            financed_amount_minor, rate_bps, installment_amount_minor, installments_count,
            payment_frequency, first_payment_on, schedule_anchor_day, starts_on, reference)
         values ('${notifyOrg}', '${notifyVehicle}', '${lender}', 'loan', 'simple', 'MAD',
                 1200000, 500, 110000, 12, 'monthly',
                 app.organization_today('${notifyOrg}') - 40, 1,
                 app.organization_today('${notifyOrg}') - 40, 'NTF-FIN-${STAMP}')
         returning id;`),
  ).id
  // Activated the way the product does it: by an owner, through PostgREST. The
  // function checks the caller's role, so service-role SQL cannot activate one.
  const activated = await notifyOwner.rpc('financing_activate_agreement', {
    p_agreement_id: agreement,
  })
  assert(!activated.error, activated.error?.message)

  const rows = await feedFor(notifyManager)
  const late = rows.find((r) => r.kind === 'financing_overdue')
  assert(late, `no overdue instalment: ${kindsOf(rows).join(',')}`)
  assert(late.severity === 'urgent', `severity ${late.severity}`)
  assert(late.action_path === `/financing/${agreement}`, `points at ${late.action_path}`)
  return `${late.subject_label} — ${late.amount_minor} ${late.currency}`
})

await check(
  'notify: the figure is financing_due_obligations, not a second calculation',
  async () => {
    /*
     * Asked through the same session that asked for the feed. The obligations
     * function refuses a caller it cannot identify, so service-role SQL is the
     * wrong instrument for this comparison — it would be asking a different
     * question of a different reader.
     */
    const { data, error } = await notifyManager.rpc('financing_due_obligations', {
      p_organization_id: notifyOrg,
      p_within_days: 30,
    })
    assert(!error, error?.message)
    const authoritative = data.reduce((sum, row) => sum + Number(row.outstanding_minor), 0)

    const rows = (await feedFor(notifyManager)).filter((r) => r.category === 'financing')
    const fromFeed = rows.reduce((sum, r) => sum + Number(r.amount_minor), 0)
    assert(
      authoritative === fromFeed,
      `the feed says ${fromFeed}, the obligations say ${authoritative}`,
    )
    assert(
      rows.length === data.length,
      `${rows.length} notifications for ${data.length} obligations`,
    )
    return `${fromFeed} minor units across ${rows.length}, from one source`
  },
)

await check(
  'notify: staff receive no financing notification, not even a redacted one',
  async () => {
    const rows = await feedFor(notifyStaff)
    assert(rows.filter((r) => r.category === 'financing').length === 0, 'staff saw financing')
    const serialised = JSON.stringify(rows)
    assert(!serialised.includes('Notify Bank'), 'the lender leaked to staff')
    assert(!serialised.includes('NTF-FIN-'), 'the agreement reference leaked to staff')
    return 'nothing, rather than a row with the numbers removed'
  },
)

await check('notify: the staff feed still works while financing is refusing them', async () => {
  /*
   * The mechanical half of the rule above. financing_due_obligations() RAISES
   * for an unauthorised caller, so a candidate helper that reached it before
   * checking the role would turn "no financing notifications" into a broken
   * feed for every staff member in the product.
   */
  sql(`insert into public.rentals
         (organization_id, vehicle_id, customer_id, starts_at, ends_at, currency, status, total_minor)
       values ('${notifyOrg}', '${notifyVehicleTwo}', '${notifyCustomer}',
               now() - interval '3 days', now() - interval '2 hours', 'MAD', 'active', 60000);`)
  const rows = await feedFor(notifyStaff)
  assert(kindsOf(rows).includes('rental_return_overdue'), 'the staff feed lost its own rows')
  return 'staff see rentals while financing quietly declines'
})

// --------------------------------------------------------------------- GPS

await check('notify: an unhealthy connection is reported as a connection fact', async () => {
  const connection = notifyRow(
    sql(`insert into public.gps_provider_connections
           (organization_id, provider, label, base_url, status, last_error_category,
            last_error_message, last_error_at)
         values ('${notifyOrg}', 'wialon', 'Smoke ${STAMP}', 'https://hst-api.wialon.com',
                 'auth_error', 'auth', 'The provider refused the token.', now())
         returning id;`),
  ).id

  const rows = await feedFor(notifyManager)
  const gps = rows.find((r) => r.kind === 'gps_connection_unhealthy')
  assert(gps, `no tracking notification: ${kindsOf(rows).join(',')}`)
  assert(gps.context.signal === 'connection_unhealthy', `signal ${gps.context.signal}`)
  assert(gps.severity === 'urgent', `severity ${gps.severity}`)
  assert(gps.action_path === '/gps-tracking', `points at ${gps.action_path}`)
  // A connection fact names no vehicle and claims nothing about one.
  assert(gps.subject_label === 'Tracking', `named a vehicle: ${gps.subject_label}`)
  assert(gps.secondary_id === connection, 'the connection was not identified')
  return 'the provider connection, not "a vehicle is offline"'
})

await check('notify: tracking is a manager’s notification, not the front desk’s', async () => {
  const rows = await feedFor(notifyStaff)
  assert(rows.filter((r) => r.category === 'gps').length === 0, 'staff were sent tracking alerts')
  return 'nothing tracking-shaped below manager'
})

await check('notify: a healthy connection stops speaking', async () => {
  sql(`update public.gps_provider_connections set status = 'healthy', last_error_at = null,
                                                  last_error_message = null, last_error_category = null
        where organization_id = '${notifyOrg}';`)
  const rows = await feedFor(notifyManager)
  assert(
    !kindsOf(rows).includes('gps_connection_unhealthy'),
    'a recovered connection was still unhealthy in the feed',
  )
  return 'recovered, and therefore silent'
})

// -------------------------------------------------------------- per-user state

await check('notify: reading moves one person’s badge and nobody else’s', async () => {
  const ownerBefore = await unreadFor(notifyOwner)
  const staffBefore = await unreadFor(notifyStaff)
  assert(ownerBefore > 0, 'nothing unread to read')

  const target = (await feedFor(notifyOwner, 'unread'))[0]
  const { error } = await notifyOwner.rpc('notification_mark_read', {
    p_organization_id: notifyOrg,
    p_fingerprint: target.fingerprint,
  })
  assert(!error, error?.message)

  const ownerAfter = await unreadFor(notifyOwner)
  const staffAfter = await unreadFor(notifyStaff)
  assert(ownerAfter === ownerBefore - 1, `owner went ${ownerBefore} → ${ownerAfter}`)
  assert(staffAfter === staffBefore, `staff went ${staffBefore} → ${staffAfter}`)
  return `owner ${ownerBefore} → ${ownerAfter}, staff unchanged at ${staffAfter}`
})

await check('notify: reading the same thing twice changes nothing', async () => {
  const target = (await feedFor(notifyOwner, 'active')).find((r) => r.read_at)
  const before = await unreadFor(notifyOwner)
  await notifyOwner.rpc('notification_mark_read', {
    p_organization_id: notifyOrg,
    p_fingerprint: target.fingerprint,
  })
  const rows = await feedFor(notifyOwner, 'all')
  const again = rows.find((r) => r.fingerprint === target.fingerprint)
  assert((await unreadFor(notifyOwner)) === before, 'the count moved on a repeat read')
  assert(again.read_at === target.read_at, 'the original read time was overwritten')
  return 'idempotent, and the first read time is the one kept'
})

await check('notify: the badge and the drawer tell the same story', async () => {
  const unread = await unreadFor(notifyOwner)
  const rows = await feedFor(notifyOwner, 'unread')
  assert(unread === rows.length, `badge ${unread}, drawer ${rows.length}`)
  return `${unread} on both`
})

await check('notify: a read notification stays in the feed, quieter', async () => {
  const rows = await feedFor(notifyOwner, 'active')
  assert(
    rows.some((r) => r.read_at),
    'reading removed it from the drawer',
  )
  return 'read is not dismissed'
})

await check('notify: dismissing hides it for one person and resolves nothing', async () => {
  const target = (await feedFor(notifyOwner, 'active')).find(
    (r) => r.kind === 'rental_return_overdue',
  )
  assert(target, 'nothing overdue to dismiss')

  const { error } = await notifyOwner.rpc('notification_dismiss', {
    p_organization_id: notifyOrg,
    p_fingerprint: target.fingerprint,
  })
  assert(!error, error?.message)

  const owner = await feedFor(notifyOwner, 'active')
  const staff = await feedFor(notifyStaff, 'active')
  assert(!owner.some((r) => r.fingerprint === target.fingerprint), 'the dismissal did not hide it')
  assert(
    staff.some((r) => r.fingerprint === target.fingerprint),
    'a dismissal silenced a colleague',
  )

  // And the rental is exactly as late as it was.
  const stillLate = notifyRow(
    sql(`select count(*)::int as n from public.rentals
          where organization_id = '${notifyOrg}'
            and public.rental_is_overdue(status, ends_at, returned_at);`),
  ).n
  assert(stillLate === 1, 'dismissing changed the domain')
  return 'hidden for one reader; the car is still out'
})

await check('notify: a dismissed item is still there in history', async () => {
  const all = await feedFor(notifyOwner, 'all')
  assert(
    all.some((r) => r.dismissed_at),
    'the dismissed item vanished from history too',
  )
  return 'the inbox remembers what the drawer stopped showing'
})

await check('notify: a dismissal cannot silence the escalation that follows', async () => {
  sql(`update public.vehicles
          set insurance_expires_on = (app.organization_today('${notifyOrg}') + 3)
        where id = '${notifyVehicle}';`)
  const due = (await feedFor(notifyOwner)).find((r) => r.kind === 'vehicle_compliance_due')
  assert(due, 'nothing became due')
  await notifyOwner.rpc('notification_dismiss', {
    p_organization_id: notifyOrg,
    p_fingerprint: due.fingerprint,
  })
  assert(
    !kindsOf(await feedFor(notifyOwner)).includes('vehicle_compliance_due'),
    'the dismissal did nothing',
  )

  sql(`update public.vehicles
          set insurance_expires_on = (app.organization_today('${notifyOrg}') - 2)
        where id = '${notifyVehicle}';`)
  const after = await feedFor(notifyOwner)
  assert(
    kindsOf(after).includes('vehicle_compliance_expired'),
    'dismissing the warning silenced the expiry',
  )
  return 'the warning was dismissed; the expiry is a different episode'
})

await check('notify: snoozing hides until its time', async () => {
  const target = (await feedFor(notifyOwner)).find((r) => r.kind === 'vehicle_compliance_expired')
  const until = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  const { error } = await notifyOwner.rpc('notification_snooze', {
    p_organization_id: notifyOrg,
    p_fingerprint: target.fingerprint,
    p_until: until,
  })
  assert(!error, error?.message)

  const active = await feedFor(notifyOwner, 'active')
  assert(!active.some((r) => r.fingerprint === target.fingerprint), 'the snooze did nothing')

  // And it comes back on its own, without anybody touching the domain.
  sql(`update public.notification_states set snoozed_until = now() - interval '1 minute'
        where organization_id = '${notifyOrg}' and user_id = '${notifyOwnerId}'
          and fingerprint = '${target.fingerprint.replace(/'/g, "''")}';`)
  const back = await feedFor(notifyOwner, 'active')
  assert(
    back.some((r) => r.fingerprint === target.fingerprint),
    'it never came back',
  )
  return 'hidden, then back when the time passed'
})

await check('notify: snooze refuses the past and refuses forever', async () => {
  const target = (await feedFor(notifyOwner))[0]
  for (const [when, description] of [
    [new Date(Date.now() - 60_000).toISOString(), 'the past'],
    [new Date(Date.now() + 90 * 86400_000).toISOString(), 'three months out'],
    [null, 'nothing at all'],
  ]) {
    const { error } = await notifyOwner.rpc('notification_snooze', {
      p_organization_id: notifyOrg,
      p_fingerprint: target.fingerprint,
      p_until: when,
    })
    assert(error, `${description} was accepted`)
  }
  return 'the past, forever and nothing are all refused'
})

await check('notify: mark-all-read reports what it read and leaves colleagues alone', async () => {
  const before = await unreadFor(notifyOwner)
  const staffBefore = await unreadFor(notifyStaff)
  const { data, error } = await notifyOwner.rpc('notification_mark_all_read', {
    p_organization_id: notifyOrg,
  })
  assert(!error, error?.message)
  assert(data === before, `read ${data}, ${before} were unread`)
  assert((await unreadFor(notifyOwner)) === 0, 'something stayed unread')
  assert((await unreadFor(notifyStaff)) === staffBefore, 'it read a colleague’s notifications')
  return `${data} read; staff still at ${staffBefore}`
})

await check('notify: state cannot be written into an agency the caller is not in', async () => {
  for (const [rpc, args] of [
    ['notification_mark_read', { p_organization_id: notifyOrg, p_fingerprint: 'x' }],
    ['notification_dismiss', { p_organization_id: notifyOrg, p_fingerprint: 'x' }],
    [
      'notification_snooze',
      {
        p_organization_id: notifyOrg,
        p_fingerprint: 'x',
        p_until: new Date(Date.now() + 3600_000).toISOString(),
      },
    ],
  ]) {
    const { error } = await notifyRival.rpc(rpc, args)
    assert(error, `${rpc} wrote into another agency`)
    assert(/not a member/i.test(error.message), error.message)
  }
  const leaked = notifyRow(
    sql(`select count(*)::int as n from public.notification_states
          where organization_id = '${notifyOrg}' and user_id = '${notifyRivalId}';`),
  ).n
  assert(leaked === 0, `${leaked} rows written by a stranger`)
  return 'refused, and nothing was written'
})

await check('notify: a fingerprint from another agency writes nothing readable', async () => {
  /*
   * The fingerprint is a string a caller can invent. Writing state for one that
   * matches nothing is harmless by construction — the feed is derived from
   * domain records and joins state onto it, so an orphan state row can never
   * become a notification.
   */
  const invented =
    'vehicle_compliance_expired:00000000-0000-0000-0000-000000000000:insurance:2020-01-01'
  const { error } = await notifyStaff.rpc('notification_mark_read', {
    p_organization_id: notifyOrg,
    p_fingerprint: invented,
  })
  assert(!error, error?.message)
  const rows = await feedFor(notifyStaff, 'all')
  assert(!rows.some((r) => r.fingerprint === invented), 'an invented fingerprint became a row')
  return 'state without a condition is not a notification'
})

// -------------------------------------------------------------------- events

await check('notify: accepting an invitation tells the administrators who were there', async () => {
  const invitation = await teamInvite(notifyOwner, notifyOrg, notifyEmail('late'), 'manager')
  notifyLateId = seedConfirmedUser(
    { email: notifyEmail('late'), password: notifyPassword },
    { full_name: 'Notify Late' },
  )
  const joiner = await teamSignIn(notifyEmail('late'))
  const { error } = await joiner.rpc('accept_team_invitation', { p_token: invitation.token })
  assert(!error, error?.message)

  const owner = await feedFor(notifyOwner, 'all')
  const event = owner.find((r) => r.kind === 'team_invitation_accepted')
  assert(event, `the owner was not told: ${kindsOf(owner).join(',')}`)
  assert(event.category === 'team', `category ${event.category}`)
  assert(event.action_path === '/team', `points at ${event.action_path}`)
  return `${event.subject_label} joined; the owner was told`
})

await check('notify: nobody is told about their own action', async () => {
  const actor = await feedFor(notifyOwner, 'all')
  // The owner did not accept anything — the joiner did — so the owner IS told.
  // The joiner accepted, so the joiner is not.
  const joiner = await teamSignIn(notifyEmail('late'))
  const theirs = await feedFor(joiner, 'all')
  assert(
    actor.some((r) => r.kind === 'team_invitation_accepted'),
    'the owner was not told after all',
  )
  assert(
    !theirs.some((r) => r.kind === 'team_invitation_accepted'),
    'somebody was notified about their own action',
  )
  return 'the actor is excluded from the audience'
})

await check('notify: a manager is not sent team events at all', async () => {
  const rows = await feedFor(notifyManager, 'all')
  assert(rows.filter((r) => r.category === 'team').length === 0, 'a manager received team events')
  return 'team notifications are an administrator’s, by category'
})

await check('notify: somebody who joins afterwards is not told about history', async () => {
  const newcomer = seedConfirmedUser(
    { email: notifyEmail('newcomer'), password: notifyPassword },
    { full_name: 'Notify Newcomer' },
  )
  sql(`insert into public.organization_members (organization_id, user_id, role, status)
       values ('${notifyOrg}', '${newcomer}', 'admin', 'active');`)
  const theirs = await teamSignIn(notifyEmail('newcomer'))

  const rows = await feedFor(theirs, 'all')
  assert(
    rows.filter((r) => r.category === 'team').length === 0,
    'history was replayed to somebody who was not there',
  )
  return 'an audience is fixed when the event happens'
})

await check('notify: one audit row is one notification, however often it is retried', async () => {
  const source = notifyRow(
    sql(`select e.id from public.organization_team_events e
          where e.organization_id = '${notifyOrg}' and e.event = 'invitation_accepted'
          limit 1;`),
  ).id
  sql(`insert into public.notification_events
         (organization_id, kind, severity, occurred_at, actor_label, subject_label,
          source_table, source_id)
       values ('${notifyOrg}', 'team_invitation_accepted', 'info', now(), 'x', 'y',
               'organization_team_events', '${source}')
       on conflict (organization_id, source_table, source_id) do nothing;`)

  const count = notifyRow(
    sql(`select count(*)::int as n from public.notification_events
          where organization_id = '${notifyOrg}' and source_id = '${source}';`),
  ).n
  assert(count === 1, `${count} notifications for one audit row`)
  return 'idempotent on the authoritative row'
})

await check('notify: a written event cannot be edited or deleted by anybody', async () => {
  const forged = await notifyOwner
    .from('notification_events')
    .update({ actor_label: 'forged' })
    .eq('organization_id', notifyOrg)
  assert(forged.error, 'an owner rewrote history through PostgREST')

  let refusedUpdate = false
  try {
    sql(`update public.notification_events set actor_label = 'forged'
          where organization_id = '${notifyOrg}';`)
  } catch (error) {
    refusedUpdate = /written by the domain/i.test(String(error.message))
  }
  assert(refusedUpdate, 'service-role rewrote a notification event')

  let refusedDelete = false
  try {
    sql(`delete from public.notification_events where organization_id = '${notifyOrg}';`)
  } catch (error) {
    refusedDelete = /written by the domain/i.test(String(error.message))
  }
  assert(refusedDelete, 'service-role deleted a notification event')
  return 'refused through PostgREST and refused underneath it'
})

await check('notify: removal cuts somebody off entirely, event rows or not', async () => {
  const before = await feedFor(await teamSignIn(notifyEmail('late')), 'all')
  assert(before.length >= 0, 'unreadable')

  await notifyOwner.rpc('remove_team_member', {
    p_organization_id: notifyOrg,
    p_user_id: notifyLateId,
  })

  const removed = await teamSignIn(notifyEmail('late'))
  const { error } = await removed.rpc('notification_feed', { p_organization_id: notifyOrg })
  assert(error, 'a removed member still had a feed')
  assert(/not a member/i.test(error.message), error.message)

  const rowsKept = notifyRow(
    sql(`select count(*)::int as n from public.notification_event_recipients r
           join public.notification_events e on e.id = r.event_id
          where e.organization_id = '${notifyOrg}' and r.user_id = '${notifyLateId}';`),
  ).n
  return `access ends at membership; ${rowsKept} recipient rows still exist and grant nothing`
})

// --------------------------------------------------- permissions, live changes

await check('notify: a demotion mid-session stops a category immediately', async () => {
  const before = await feedFor(notifyManager)
  assert(
    before.some((r) => r.category === 'financing'),
    'the manager saw no financing to lose',
  )

  await notifyOwner.rpc('change_team_member_role', {
    p_organization_id: notifyOrg,
    p_user_id: notifyManagerId,
    p_role: 'staff',
  })

  // The SAME session, no new token, no sign-in.
  const after = await feedFor(notifyManager)
  assert(!after.some((r) => r.category === 'financing'), 'financing survived the demotion')
  assert(!after.some((r) => r.category === 'gps'), 'tracking survived the demotion')
  return 'the token did not change; the answer did'
})

await check('notify: the promotion back restores it, on the same session', async () => {
  await notifyOwner.rpc('change_team_member_role', {
    p_organization_id: notifyOrg,
    p_user_id: notifyManagerId,
    p_role: 'manager',
  })
  const rows = await feedFor(notifyManager)
  assert(
    rows.some((r) => r.category === 'financing'),
    'financing did not come back',
  )
  return 'current permissions, asked every time'
})

await check('notify: preferences list only what this person can receive', async () => {
  const owner = await notifyOwner.rpc('notification_preferences_for', {
    p_organization_id: notifyOrg,
  })
  const staff = await notifyStaff.rpc('notification_preferences_for', {
    p_organization_id: notifyOrg,
  })
  assert(!owner.error, owner.error?.message)
  assert(!staff.error, staff.error?.message)

  const ownerCategories = owner.data.map((p) => p.category).sort()
  const staffCategories = staff.data.map((p) => p.category).sort()
  assert(
    JSON.stringify(ownerCategories) ===
      JSON.stringify(['billing', 'compliance', 'financing', 'gps', 'rentals', 'team']),
    `owner: ${ownerCategories.join(',')}`,
  )
  assert(
    JSON.stringify(staffCategories) === JSON.stringify(['compliance', 'rentals']),
    `staff: ${staffCategories.join(',')}`,
  )
  return `owner ${ownerCategories.length}, staff ${staffCategories.length}`
})

await check('notify: muting something you never receive is refused', async () => {
  const { error } = await notifyStaff.rpc('notification_preference_set', {
    p_organization_id: notifyOrg,
    p_category: 'financing',
    p_muted: true,
  })
  assert(error, 'a staff member muted financing')
  assert(/do not receive/i.test(error.message), error.message)
  return 'refused: ' + error.message.slice(0, 50)
})

await check('notify: muting silences a category for one person only', async () => {
  const before = (await feedFor(notifyManager)).filter((r) => r.category === 'financing')
  assert(before.length > 0, 'nothing to mute')

  const { error } = await notifyManager.rpc('notification_preference_set', {
    p_organization_id: notifyOrg,
    p_category: 'financing',
    p_muted: true,
  })
  assert(!error, error?.message)

  const manager = (await feedFor(notifyManager)).filter((r) => r.category === 'financing')
  const owner = (await feedFor(notifyOwner)).filter((r) => r.category === 'financing')
  assert(manager.length === 0, 'the mute did nothing')
  assert(owner.length > 0, 'one person’s mute silenced another')
  return `manager 0, owner ${owner.length}`
})

await check('notify: unmuting brings it straight back', async () => {
  await notifyManager.rpc('notification_preference_set', {
    p_organization_id: notifyOrg,
    p_category: 'financing',
    p_muted: false,
  })
  const rows = (await feedFor(notifyManager)).filter((r) => r.category === 'financing')
  assert(rows.length > 0, 'unmuting did not restore it')
  return `${rows.length} back`
})

await check('notify: a mute is not a preference for a whole agency', async () => {
  const stored = notifyRow(
    sql(`select count(distinct user_id)::int as people
           from public.notification_preferences where organization_id = '${notifyOrg}';`),
  ).people
  const columns = notifyRow(
    sql(`select count(*)::int as n from information_schema.columns
          where table_schema = 'public' and table_name = 'notification_preferences'
            and column_name = 'user_id';`),
  ).n
  assert(columns === 1, 'preferences are not keyed by person')
  return `preferences are per person (${stored} so far), never per agency`
})

// --------------------------------------------------- ordering, paging, clock

await check('notify: urgent comes before attention comes before informational', async () => {
  const rows = await feedFor(notifyOwner, 'all')
  const rank = { urgent: 0, attention: 1, info: 2 }
  const ranks = rows.map((r) => rank[r.severity])
  assert(
    ranks.every((value, index) => index === 0 || ranks[index - 1] <= value),
    `out of order: ${rows.map((r) => r.severity).join(',')}`,
  )
  return `${rows.length} rows, sorted by urgency then by when it matters`
})

await check('notify: the attention scope is actionable only', async () => {
  const rows = await feedFor(notifyOwner, 'attention')
  assert(rows.length > 0, 'nothing actionable')
  assert(!rows.some((r) => r.severity === 'info'), 'informational rows in the attention scope')
  assert(!rows.some((r) => r.dismissed_at), 'dismissed rows in the attention scope')
  return `${rows.length} actionable`
})

await check('notify: the total is independent of the page size', async () => {
  const all = await feedFor(notifyOwner, 'all')
  const { data, error } = await notifyOwner.rpc('notification_feed', {
    p_organization_id: notifyOrg,
    p_scope: 'all',
    p_limit: 1,
    p_offset: 0,
  })
  assert(!error, error?.message)
  assert(data.length === 1, `asked for 1, got ${data.length}`)
  assert(
    Number(data[0].total_count) === all.length,
    `page says ${data[0].total_count}, the feed has ${all.length}`,
  )
  return `1 of ${data[0].total_count}`
})

await check('notify: paging never repeats and never skips', async () => {
  const all = (await feedFor(notifyOwner, 'all')).map((r) => r.fingerprint)
  const paged = []
  for (let offset = 0; offset < all.length; offset += 2) {
    const { data } = await notifyOwner.rpc('notification_feed', {
      p_organization_id: notifyOrg,
      p_scope: 'all',
      p_limit: 2,
      p_offset: offset,
    })
    paged.push(...data.map((r) => r.fingerprint))
  }
  assert(JSON.stringify(paged) === JSON.stringify(all), 'the pages do not reassemble the feed')
  return `${all.length} rows across ${Math.ceil(all.length / 2)} pages, in the same order`
})

await check('notify: expiry is decided by the agency’s date, not the server’s', async () => {
  /*
   * Casablanca is ahead of UTC, so there is an hour each night when the two
   * disagree about what day it is. The agency's date is the one that decides,
   * and app.organization_today() is where it comes from.
   */
  const today = notifyRow(sql(`select app.organization_today('${notifyOrg}')::text as d;`)).d
  sql(`update public.vehicles set insurance_expires_on = '${today}'::date
        where id = '${notifyVehicleTwo}';`)
  const onTheDay = await feedFor(notifyOwner)
  assert(
    onTheDay.some((r) => r.kind === 'vehicle_compliance_due' && r.due_on === today),
    'a document expiring today was not due today',
  )
  assert(
    !onTheDay.some((r) => r.kind === 'vehicle_compliance_expired' && r.due_on === today),
    'a document expiring today was already expired',
  )

  sql(`update public.vehicles set insurance_expires_on = ('${today}'::date - 1)
        where id = '${notifyVehicleTwo}';`)
  const dayAfter = await feedFor(notifyOwner)
  assert(
    dayAfter.some((r) => r.kind === 'vehicle_compliance_expired'),
    'yesterday’s expiry had not expired',
  )
  return `the agency's today is ${today}`
})

await check('notify: nothing in this module schedules anything', async () => {
  const scheduler = notifyRow(
    sql(`select
           (select count(*)::int from pg_extension where extname in ('pg_cron', 'pg_net')) as extensions,
           (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname in ('public', 'app')
               and (p.prosrc ilike '%cron.schedule%' or p.prosrc ilike '%net.http_post%')) as callers;`),
  )
  assert(scheduler.extensions === 0, `${scheduler.extensions} scheduling extensions installed`)
  assert(scheduler.callers === 0, `${scheduler.callers} functions call a scheduler`)
  return 'no pg_cron, no pg_net, no background claim'
})

await check('notify: the feed answers a realistic agency quickly', async () => {
  const started = Date.now()
  for (let i = 0; i < 5; i += 1) await feedFor(notifyOwner, 'active')
  const perCall = Math.round((Date.now() - started) / 5)
  assert(perCall < 1500, `${perCall}ms per feed call`)

  const badge = Date.now()
  for (let i = 0; i < 5; i += 1) await unreadFor(notifyOwner)
  const perBadge = Math.round((Date.now() - badge) / 5)
  assert(perBadge < 1500, `${perBadge}ms per badge call`)
  return `feed ${perCall}ms, badge ${perBadge}ms, over the network`
})

await check('notify teardown leaves nothing of its own behind', async () => {
  /*
   * Everything this section made hangs off its two agencies and cascades with
   * them, including the notification events, their recipients, every per-user
   * state row and every preference. The check is that nothing was created
   * outside them.
   */
  const stray = notifyRow(
    sql(`select
           (select count(*)::int from public.vehicles
             where registration_plate like 'NTF-${STAMP}%'
               and organization_id <> '${notifyOrg}') as vehicles,
           (select count(*)::int from public.lenders
             where name like 'Notify Bank ${STAMP}%' and organization_id <> '${notifyOrg}') as lenders,
           (select count(*)::int from public.notification_states
             where organization_id not in (select id from public.organizations)) as orphan_states;`),
  )
  assert(stray.vehicles === 0, `${stray.vehicles} stray vehicles`)
  assert(stray.lenders === 0, `${stray.lenders} stray lenders`)
  assert(stray.orphan_states === 0, `${stray.orphan_states} orphaned state rows`)
  return 'everything hangs off the two fixture agencies'
})


// =============================================================================
// SaaS Billing & Subscriptions
//
// What an agency pays US. Every check here runs against the real project, and
// none of them talks to Stripe: no Stripe credential is configured in this
// deployment, which is itself the first thing the section proves.
//
// The two questions are whether an unconfigured deployment is honest and calm,
// and whether the billing surface can be reached by anybody it should not be.
// =============================================================================

const billingPassword = 'SmokeTest!2026'
const billingEmail = (who) => `smoke-billing-${who}-${STAMP}@atlasloca.com`
const billingRow = (out) => (out.result ?? out.rows ?? [])[0]

let billingOrg, billingRivalOrg
let billingOwnerId, billingAdminId, billingManagerId, billingStaffId, billingRivalId
let billingOwner, billingAdmin, billingManager, billingStaff, billingRival

/** Calls the deployed billing function as a given client. */
async function callBilling(asClient, body) {
  const { data, error } = await asClient.functions.invoke('billing', { body })
  if (error) {
    const context = error.context
    let parsed = null
    if (context && typeof context.json === 'function') {
      try {
        parsed = await context.clone().json()
      } catch {
        parsed = null
      }
    }
    return { status: context?.status ?? 0, body: parsed }
  }
  return { status: 200, body: data }
}

/** The webhook endpoint, called directly with whatever headers we like. */
async function callWebhook(payload, headers = {}) {
  const response = await fetch(`${URL}/functions/v1/billing-webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: payload,
  })
  let body = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  return { status: response.status, body }
}

await check('billing: an agency with a full cast and a rival', async () => {
  billingOwnerId = seedConfirmedUser(
    { email: billingEmail('owner'), password: billingPassword },
    { full_name: 'Billing Owner' },
  )
  billingOrg = billingRow(
    sql(`select (app.provision_organization(
           '${billingOwnerId}'::uuid, 'Smoke Test Billing ${STAMP}', 'MA', 'MAD', 'Africa/Casablanca', 'en'
         )).id as id;`),
  ).id

  billingRivalId = seedConfirmedUser(
    { email: billingEmail('rival'), password: billingPassword },
    { full_name: 'Billing Rival' },
  )
  billingRivalOrg = billingRow(
    sql(`select (app.provision_organization(
           '${billingRivalId}'::uuid, 'Smoke Test Billing Rival ${STAMP}', 'MA', 'MAD', 'Africa/Casablanca', 'en'
         )).id as id;`),
  ).id

  for (const [who, role] of [
    ['admin', 'admin'],
    ['manager', 'manager'],
    ['staff', 'staff'],
  ]) {
    const id = seedConfirmedUser(
      { email: billingEmail(who), password: billingPassword },
      { full_name: `Billing ${who}` },
    )
    sql(`insert into public.organization_members (organization_id, user_id, role, status)
         values ('${billingOrg}', '${id}', '${role}', 'active');`)
    if (who === 'admin') billingAdminId = id
    if (who === 'manager') billingManagerId = id
    if (who === 'staff') billingStaffId = id
  }

  billingOwner = await teamSignIn(billingEmail('owner'))
  billingAdmin = await teamSignIn(billingEmail('admin'))
  billingManager = await teamSignIn(billingEmail('manager'))
  billingStaff = await teamSignIn(billingEmail('staff'))
  billingRival = await teamSignIn(billingEmail('rival'))

  return 'owner, admin, manager, staff and a rival agency'
})

await check('billing: this deployment has no Stripe configuration, and says so', async () => {
  const state = billingRow(
    sql(`select stripe_configured, stripe_mode, reported_reason,
                app.billing_platform_configured() as configured
           from public.billing_platform_state where id;`),
  )
  assert(state.stripe_configured === false, 'the platform reports Stripe as configured')
  assert(state.stripe_mode === null, `a mode is set: ${state.stripe_mode}`)
  assert(state.configured === false, 'billing reports itself configured')
  return state.reported_reason
})

await check('billing: no plan, customer or subscription was created by a migration', async () => {
  const counts = billingRow(
    sql(`select (select count(*)::int from public.billing_plans) as plans,
                (select count(*)::int from public.billing_customers) as customers,
                (select count(*)::int from public.billing_subscriptions) as subscriptions,
                (select count(*)::int from public.billing_checkout_sessions) as sessions;`),
  )
  assert(counts.plans === 0, `${counts.plans} plans exist`)
  assert(counts.customers === 0, `${counts.customers} customers exist`)
  assert(counts.subscriptions === 0, `${counts.subscriptions} subscriptions exist`)
  assert(counts.sessions === 0, `${counts.sessions} checkout sessions exist`)
  return 'nothing invented: no fake subscription, no exemption, no grandfathered plan'
})

await check('billing: the real organization keeps normal access', async () => {
  /*
   * The check that matters most on the day Billing ships: deploying it must not
   * lock the existing agency out of its own product.
   */
  const states = sql(`select o.name, app.billing_access_state_of(o.id)::text as state
                        from public.organizations o order by o.created_at;`)
  const rows = states.result ?? states.rows ?? []
  assert(rows.length > 0, 'no organizations found')
  for (const row of rows) {
    assert(row.state === 'platform_unconfigured', `${row.name} resolved to ${row.state}`)
  }
  return `${rows.length} agencies, all platform_unconfigured — not a subscription`
})

await check('billing: an owner sees a truthful unconfigured page', async () => {
  const { data, error } = await billingOwner.rpc('billing_overview', {
    p_organization_id: billingOrg,
  })
  assert(!error, error?.message)
  const row = data[0]

  assert(row.access_state === 'platform_unconfigured', `state ${row.access_state}`)
  assert(row.stripe_configured === false, 'stripe reported configured')
  assert(row.catalog_configured === false, 'a catalogue is reported')
  assert(row.status === null, `a subscription status was returned: ${row.status}`)
  assert(row.plan_key === null, 'a plan was returned')
  assert(row.amount_minor === null, 'an amount was returned')
  assert(row.has_customer === false, 'a Stripe customer was reported')
  return 'no plan, no price, no renewal date, no customer'
})

await check('billing: only the owner may read it', async () => {
  for (const [name, asClient] of [
    ['admin', billingAdmin],
    ['manager', billingManager],
    ['staff', billingStaff],
  ]) {
    for (const rpc of ['billing_overview', 'billing_available_plans', 'billing_history']) {
      const { error } = await asClient.rpc(rpc, { p_organization_id: billingOrg })
      assert(error, `${name} could call ${rpc}`)
      assert(/only an owner/i.test(error.message), `${name}/${rpc}: ${error.message}`)
    }
  }
  return '3 roles × 3 reads, all refused by the database'
})

await check('billing: every member may read the generic state, and only that', async () => {
  for (const [name, asClient] of [
    ['manager', billingManager],
    ['staff', billingStaff],
  ]) {
    const { data, error } = await asClient.rpc('billing_access', { p_organization_id: billingOrg })
    assert(!error, `${name}: ${error?.message}`)
    assert(data === 'platform_unconfigured', `${name} saw ${data}`)
  }
  return 'a four-value enum, no money and no identifiers'
})

await check('billing: a stranger is refused everything', async () => {
  for (const rpc of ['billing_overview', 'billing_available_plans', 'billing_history', 'billing_access']) {
    const { error } = await billingRival.rpc(rpc, { p_organization_id: billingOrg })
    assert(error, `${rpc} answered a stranger`)
  }
  const { error: writeError } = await billingRival.rpc('billing_set_email', {
    p_organization_id: billingOrg,
    p_email: 'attacker@example.test',
  })
  assert(writeError, 'a stranger changed another agency’s billing address')
  return 'reads and the one write, all refused'
})

await check('billing: anon can reach nothing', async () => {
  const anon = client()
  for (const rpc of [
    'billing_overview',
    'billing_available_plans',
    'billing_history',
    'billing_access',
    'billing_set_email',
  ]) {
    const { error } = await anon.rpc(rpc, { p_organization_id: billingOrg })
    assert(error, `${rpc} answered anon`)
  }
  for (const table of [
    'billing_platform_state',
    'billing_plans',
    'billing_customers',
    'billing_subscriptions',
    'billing_checkout_sessions',
    'billing_webhook_events',
    'billing_events',
  ]) {
    const { error } = await anon.from(table).select('*').limit(1)
    assert(error, `${table} answered anon`)
  }
  return '5 functions and 7 tables, nothing anonymous'
})

await check('billing: no client role holds a table privilege', async () => {
  const grants = sql(`select count(*)::int as n from information_schema.role_table_grants
                       where table_schema = 'public' and table_name like 'billing%'
                         and grantee in ('anon', 'authenticated');`)
  assert(billingRow(grants).n === 0, `${billingRow(grants).n} grants exist`)

  for (const [name, asClient] of [
    ['owner', billingOwner],
    ['admin', billingAdmin],
  ]) {
    for (const table of ['billing_subscriptions', 'billing_customers', 'billing_webhook_events']) {
      const read = await asClient.from(table).select('*').limit(1)
      assert(read.error, `${name} read ${table} directly`)
      const write = await asClient.from(table).insert({ organization_id: billingOrg })
      assert(write.error, `${name} wrote ${table} directly`)
    }
  }
  return 'no privilege, no direct read, no direct write'
})

await check('billing: no signed-in user can execute a billing service function', async () => {
  const reachable = sql(`select count(*)::int as n from pg_proc p
                           join pg_namespace n on n.oid = p.pronamespace
                          where n.nspname = 'app' and p.proname like 'billing%'
                            and has_function_privilege('authenticated', p.oid, 'EXECUTE');`)
  assert(billingRow(reachable).n === 0, `${billingRow(reachable).n} are reachable`)
  return 'every writer is service_role only'
})

await check('billing: there is no test backdoor in production', async () => {
  /*
   * The functions that set a subscription status or inject an event exist — they
   * must, something has to write the projection — and none of them is reachable
   * by a browser at any role. This is the assertion that keeps a deterministic
   * test fixture from becoming a production mutation surface.
   */
  const named = sql(`select string_agg(p.proname, ', ' order by p.proname) as names
                       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                      where n.nspname in ('public', 'app')
                        and (p.proname ilike '%set_subscription%'
                             or p.proname ilike '%inject%'
                             or p.proname ilike '%force_%billing%')
                        and has_function_privilege('authenticated', p.oid, 'EXECUTE');`)
  assert(billingRow(named).names === null, `reachable: ${billingRow(named).names}`)
  return 'no status setter, no event injector, nothing forcible'
})

await check('billing: the deployed function refuses a caller with no session', async () => {
  const response = await fetch(`${URL}/functions/v1/billing`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY },
    body: JSON.stringify({ action: 'status', organizationId: billingOrg }),
  })
  assert(response.status === 401, `answered ${response.status}`)
  const body = await response.json()
  assert(body?.error?.category === 'auth_error', `category ${body?.error?.category}`)
  return '401 auth_error'
})

await check('billing: the deployed function answers another tenant with not_found', async () => {
  const result = await callBilling(billingRival, { action: 'status', organizationId: billingOrg })
  assert(result.status === 404, `answered ${result.status}`)
  assert(result.body?.error?.category === 'not_found', `category ${result.body?.error?.category}`)
  // The same answer a nonexistent agency gets: confirming it exists is a leak.
  return '404 not_found — indistinguishable from an agency that does not exist'
})

await check('billing: the deployed function refuses a non-owner member', async () => {
  for (const [name, asClient] of [
    ['admin', billingAdmin],
    ['manager', billingManager],
    ['staff', billingStaff],
  ]) {
    const result = await callBilling(asClient, { action: 'status', organizationId: billingOrg })
    assert(result.status === 403, `${name} got ${result.status}`)
    assert(
      result.body?.error?.category === 'permission_denied',
      `${name}: ${result.body?.error?.category}`,
    )
  }
  return '403 permission_denied for admin, manager and staff'
})

await check('billing: an unconfigured deployment answers a named state, not an error', async () => {
  for (const action of ['status', 'checkout', 'portal', 'reconcile']) {
    const result = await callBilling(billingOwner, {
      action,
      organizationId: billingOrg,
      planKey: 'standard',
      attempt: 'smoke',
    })
    assert(result.status === 200, `${action} answered ${result.status}`)
    assert(
      result.body?.state === 'billing_not_configured',
      `${action} answered ${JSON.stringify(result.body).slice(0, 120)}`,
    )
    // And says nothing about which secret is missing.
    const said = JSON.stringify(result.body)
    assert(!/STRIPE|SECRET|whsec|sk_/i.test(said), `${action} named a secret: ${said}`)
  }
  return 'four actions, four calm billing_not_configured answers'
})

await check('billing: nothing was written by those refusals', async () => {
  const counts = billingRow(
    sql(`select (select count(*)::int from public.billing_customers) as customers,
                (select count(*)::int from public.billing_checkout_sessions) as sessions,
                (select count(*)::int from public.billing_subscriptions) as subscriptions;`),
  )
  assert(counts.customers === 0, `${counts.customers} customers`)
  assert(counts.sessions === 0, `${counts.sessions} sessions`)
  assert(counts.subscriptions === 0, `${counts.subscriptions} subscriptions`)
  return 'no partial state from an unconfigured call'
})

await check('billing: the webhook fails closed with no configuration', async () => {
  const payload = JSON.stringify({
    id: 'evt_smoke_1',
    type: 'customer.subscription.updated',
    created: Math.floor(Date.now() / 1000),
    livemode: false,
    data: { object: { id: 'sub_smoke', customer: 'cus_smoke' } },
  })

  // No signature at all.
  const unsigned = await callWebhook(payload)
  assert(unsigned.status >= 400, `an unsigned event answered ${unsigned.status}`)

  // A plausible but fabricated signature.
  const forged = await callWebhook(payload, {
    'Stripe-Signature': `t=${Math.floor(Date.now() / 1000)},v1=${'a'.repeat(64)}`,
  })
  assert(forged.status >= 400, `a forged signature answered ${forged.status}`)

  // And no ledger row appeared from either.
  const ledger = billingRow(
    sql(`select count(*)::int as n from public.billing_webhook_events
          where stripe_event_id = 'evt_smoke_1';`),
  ).n
  assert(ledger === 0, `${ledger} ledger rows were written by a refused request`)
  return `unsigned ${unsigned.status}, forged ${forged.status}, nothing recorded`
})

await check('billing: the webhook requires POST', async () => {
  const response = await fetch(`${URL}/functions/v1/billing-webhook`, { method: 'GET' })
  assert(response.status === 405 || response.status === 401, `answered ${response.status}`)
  return `GET answered ${response.status}`
})

await check('billing: the projection cannot be written from a browser', async () => {
  for (const [name, asClient] of [
    ['owner', billingOwner],
    ['admin', billingAdmin],
  ]) {
    const insert = await asClient.from('billing_subscriptions').insert({
      organization_id: billingOrg,
      stripe_subscription_id: 'sub_forged',
      stripe_customer_id: 'cus_forged',
      mode: 'test',
      status: 'active',
      stripe_event_at: new Date().toISOString(),
    })
    assert(insert.error, `${name} inserted a subscription`)

    const update = await asClient
      .from('billing_subscriptions')
      .update({ status: 'active' })
      .eq('organization_id', billingOrg)
    assert(update.error, `${name} updated a subscription`)
  }
  return 'no insert and no update, at any role'
})

await check('billing: ownership transfer leaves billing with the agency', async () => {
  // A mapping exists only through the service path, which is the point: the
  // customer belongs to the organization, not to whoever created it.
  sql(`select app.billing_claim_customer('${billingOrg}', 'cus_smoke_${STAMP}', 'test', null);`)

  const before = billingRow(
    sql(`select stripe_customer_id from public.billing_customers
          where organization_id = '${billingOrg}';`),
  ).stripe_customer_id

  const { error } = await billingOwner.rpc('transfer_organization_ownership', {
    p_organization_id: billingOrg,
    p_user_id: billingAdminId,
  })
  assert(!error, error?.message)

  const after = billingRow(
    sql(`select stripe_customer_id from public.billing_customers
          where organization_id = '${billingOrg}';`),
  ).stripe_customer_id
  assert(after === before, `the customer changed: ${before} -> ${after}`)

  // The new owner manages billing; the old one no longer can.
  const { error: newOwnerError } = await billingAdmin.rpc('billing_overview', {
    p_organization_id: billingOrg,
  })
  assert(!newOwnerError, `the new owner was refused: ${newOwnerError?.message}`)

  const { error: oldOwnerError } = await billingOwner.rpc('billing_overview', {
    p_organization_id: billingOrg,
  })
  assert(oldOwnerError, 'the previous owner still manages billing')
  return `same Stripe customer (${before.slice(0, 12)}…), authority moved`
})

await check('billing: an agency with a live subscription cannot be deleted', async () => {
  sql(`select app.billing_apply_subscription(
         'sub_smoke_${STAMP}', 'cus_smoke_${STAMP}', 'test', 'active', 'price_smoke',
         'EUR', 4900, 'month', 1, 1, now(), now() + interval '30 days',
         false, null, null, null, null, null, now(), 'evt_smoke_apply');`)

  let refused = false
  try {
    sql(`delete from public.organizations where id = '${billingOrg}';`)
  } catch (error) {
    refused = /live subscription/i.test(String(error.message))
  }
  assert(refused, 'an agency with a live subscription was deleted')
  return 'refused, so no paid subscription is left unmanaged'
})

await check('billing: the owner is told about the subscription, and nobody else is', async () => {
  const { data: ownerFeed, error } = await billingAdmin.rpc('notification_feed', {
    p_organization_id: billingOrg,
    p_scope: 'all',
  })
  assert(!error, error?.message)
  const billingRows = (ownerFeed ?? []).filter((r) => r.category === 'billing')
  assert(billingRows.length > 0, 'the owner was told nothing about their subscription')
  assert(
    billingRows.every((r) => r.action_path === '/billing'),
    'a billing notification points somewhere else',
  )

  for (const [name, asClient] of [
    ['manager', billingManager],
    ['staff', billingStaff],
  ]) {
    const { data } = await asClient.rpc('notification_feed', {
      p_organization_id: billingOrg,
      p_scope: 'all',
    })
    const seen = (data ?? []).filter((r) => r.category === 'billing')
    assert(seen.length === 0, `${name} received ${seen.length} billing notifications`)
  }
  return `${billingRows.length} for the owner, none for anybody else`
})

await check('billing: a replayed event produces one notification', async () => {
  for (let i = 0; i < 4; i += 1) {
    sql(`select app.billing_apply_subscription(
           'sub_smoke_${STAMP}', 'cus_smoke_${STAMP}', 'test', 'active', 'price_smoke',
           'EUR', 4900, 'month', 1, 1, now(), now() + interval '30 days',
           false, null, null, null, null, null, now() - interval '1 minute', 'evt_smoke_apply');`)
  }
  const count = billingRow(
    sql(`select count(*)::int as n from public.notification_events
          where organization_id = '${billingOrg}' and kind = 'billing_subscription_activated';`),
  ).n
  assert(count === 1, `${count} notifications for one activation`)
  return 'idempotent on the authoritative row'
})

await check('billing: SaaS billing changes no agency figure', async () => {
  const overview = await billingManager.rpc('organization_overview', {
    p_organization_id: billingOrg,
    p_from: new Date(Date.now() - 30 * 86400_000).toISOString(),
    p_to: new Date().toISOString(),
  })
  assert(!overview.error, overview.error?.message)
  const row = overview.data[0]

  // A whole subscription exists at this point, at our expense, not theirs.
  assert(Number(row.revenue_minor) === 0, `revenue moved to ${row.revenue_minor}`)
  assert(Number(row.expenses_minor) === 0, `expenses moved to ${row.expenses_minor}`)

  const expenses = billingRow(
    sql(`select count(*)::int as n from public.expenses where organization_id = '${billingOrg}';`),
  ).n
  assert(expenses === 0, `${expenses} expenses were created by billing`)
  return 'revenue 0, expenses 0, no operating cost invented'
})

await check('billing teardown closes its subscription and leaves nothing behind', async () => {
  /*
   * The guard above is doing its job, so the fixture has to close its billing
   * before its agency can go — which is exactly the operational sequence a real
   * account closure would follow.
   */
  sql(`select app.billing_apply_subscription(
         'sub_smoke_${STAMP}', 'cus_smoke_${STAMP}', 'test', 'canceled', 'price_smoke',
         'EUR', 4900, 'month', 1, 1, now(), now() + interval '30 days',
         false, null, now(), now(), null, null, now() + interval '1 minute', 'evt_smoke_close');`)

  const state = billingRow(
    sql(`select status::text as status from public.billing_subscriptions
          where stripe_subscription_id = 'sub_smoke_${STAMP}';`),
  ).status
  assert(state === 'canceled', `the subscription is ${state}`)

  const stray = billingRow(
    sql(`select (select count(*)::int from public.billing_plans) as plans,
                (select count(*)::int from public.billing_platform_state
                  where stripe_configured) as configured;`),
  )
  assert(stray.plans === 0, `${stray.plans} plans were left behind`)
  assert(stray.configured === 0, 'the platform was left reporting Stripe as configured')
  return 'subscription closed; the deployment is still unconfigured'
})

// ---------------------------------------------------------------- cleanup
await check('cleanup', async () => {
  /*
   * Three statements, in this order, and not one statement with three CTEs.
   *
   * Deleting an agency cascades to its invitations and team events; deleting an
   * Auth user nulls the actor, target and inviter columns on those same rows.
   * Run together they read one snapshot and fight over the rows in between.
   * Agencies go first so the rows are gone before anything tries to null them.
   */
  const removedOrgs = sql(
    `delete from public.organizations where name like 'Smoke Test %${STAMP}' returning 1;`,
  )
  const removedUsers = sql(
    `delete from auth.users
      where email like 'smoke-%${STAMP}@atlasloca.com'
         or email like 'smoke-team-%-${STAMP}@atlasloca.com' returning 1;`,
  )
  // Belt and braces: a Vault secret whose owning row is gone would be invisible
  // and permanent. Nothing this run created may survive it.
  const removedSecrets = sql(
    `delete from vault.secrets where name like 'gps_provider_%'
       and id not in (select secret_ref from public.gps_provider_credentials) returning 1;`,
  )
  const count = (out) => (out.result ?? out.rows ?? []).length
  const out = {
    result: [
      {
        orgs: count(removedOrgs),
        users: count(removedUsers),
        secrets: count(removedSecrets),
      },
    ],
  }
  const cleaned = (out.result ?? out.rows ?? [])[0]
  return `${cleaned.orgs} agencies, ${cleaned.users} users, ${cleaned.secrets} orphaned secrets removed`
})

if (viteServer) await viteServer.close()

console.table(results)
console.log(
  failures === 0
    ? `\nALL ${results.length} LIVE CHECKS PASSED`
    : `\n${failures} of ${results.length} LIVE CHECKS FAILED`,
)
process.exit(failures === 0 ? 0 : 1)
