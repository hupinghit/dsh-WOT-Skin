/**
 * @local/dsh-wot-wallpaper — host half.
 *
 * Downloads official World of Tanks (worldoftanks.eu) wallpapers at most once
 * every 30 days into `$DSH_HOME/cache/wot-wallpaper/images`, then serves them
 * plus a small state document to the client half over the DSH web server.
 *
 * Routes (unauthenticated, same origin as the GUI):
 *   GET  /wot-wallpaper/state        -> JSON state (+ today's pick)
 *   GET  /wot-wallpaper/img/<id>     -> JPEG/PNG bytes (long cache)
 *   POST /wot-wallpaper/action       -> {action: next|prev|refresh|enable|disable|reset}
 */
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const name = 'wot-wallpaper'
export const inject = ['webServer']

const PREFIX = '/wot-wallpaper'
const DAY_MS = 24 * 60 * 60 * 1000
const REFRESH_DAYS = 30
const DEFAULT_COUNT = 10
const RETRY_AFTER_MS = 60 * 60 * 1000
const REFRESH_BUDGET_MS = 8 * 60 * 1000
/** `access.log` is trimmed back to nothing once it grows past this many bytes. */

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Official World of Tanks wallpaper listing (tag 9 = wallpapers / art). */
const LISTING_URLS = [
  'https://worldoftanks.eu/en/media/tag/9/',
  'https://worldoftanks.eu/en/media/1/tag/9/',
]

/** Preferred source sizes, best first. */
const SIZE_ORDER = [
  '1920x1080',
  '2560x1440',
  '3840x1080',
  '1920x1280',
  '1680x1050',
  '1366x768',
  '1280x1024',
  '2560x1600',
]

/** Battle/vehicle art — what the theme is about. */
const GOOD_HINTS =
  /(prokhorovka|erlenberg|tundra|himmelsdorf|karelia|malinovka|murovanka|ensk|siegfried|mirny|kv-?2|battle|frontline|steel|arctic|desert|winter|siege|camo|tank|tanks)/i

/** Promo collages and character portraits: still WoT, but not tank scenery. */
const BAD_HINTS = /(halloween|anniversary|new-?year|holiday|birthday|snowball|marathon)/i

const EMPTY_STATE = {
  version: 1,
  enabled: true,
  offset: 0,
  count: DEFAULT_COUNT,
  updatedAt: 0,
  lastAttemptAt: 0,
  lastError: null,
  images: [],
}

/* ------------------------------------------------------------------ paths */

function homeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

function dataDir() {
  return path.join(homeDir(), 'cache', 'wot-wallpaper')
}

function imageDir() {
  return path.join(dataDir(), 'images')
}

function statePath() {
  return path.join(dataDir(), 'state.json')
}

function targetCount(config) {
  const raw = Number(config?.count ?? config?.imageCount)
  if (Number.isFinite(raw) && raw >= 1 && raw <= 60) return Math.round(raw)
  return DEFAULT_COUNT
}

/* ------------------------------------------------------------------ state */

function normalizeState(raw) {
  const state = { ...EMPTY_STATE, images: [] }
  if (!raw || typeof raw !== 'object') return state
  state.enabled = raw.enabled !== false
  state.offset = Number.isFinite(raw.offset) ? Math.round(raw.offset) : 0
  state.count = Number.isFinite(raw.count) ? Math.round(raw.count) : DEFAULT_COUNT
  state.updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0
  state.lastAttemptAt = Number.isFinite(raw.lastAttemptAt) ? raw.lastAttemptAt : 0
  state.lastError = typeof raw.lastError === 'string' ? raw.lastError : null
  if (Array.isArray(raw.images)) {
    state.images = raw.images
      .filter(
        (image) =>
          image &&
          typeof image.id === 'string' &&
          /^[a-z0-9][a-z0-9-]*$/.test(image.id) &&
          typeof image.file === 'string' &&
          /^[a-z0-9][a-z0-9-]*\.(?:jpg|jpeg|png)$/.test(image.file),
      )
      .map((image) => ({
        id: image.id,
        title: typeof image.title === 'string' ? image.title : image.id,
        file: image.file,
        mime: typeof image.mime === 'string' ? image.mime : 'image/jpeg',
        bytes: Number.isFinite(image.bytes) ? image.bytes : 0,
        width: Number.isFinite(image.width) ? image.width : 0,
        height: Number.isFinite(image.height) ? image.height : 0,
        remote: typeof image.remote === 'string' ? image.remote : null,
        source: typeof image.source === 'string' ? image.source : null,
        addedAt: Number.isFinite(image.addedAt) ? image.addedAt : 0,
      }))
  }
  return state
}

async function loadState() {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8'))
    return normalizeState(raw)
  } catch {
    return normalizeState(null)
  }
}

async function saveState(state) {
  const dir = dataDir()
  await mkdir(dir, { recursive: true })
  const file = statePath()
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

/* ------------------------------------------------------------------ utils */

async function fileExists(file) {
  try {
    await readFile(file)
    return true
  } catch {
    return false
  }
}

function localDaySerial(now = Date.now()) {
  const shift = new Date(now).getTimezoneOffset() * 60 * 1000
  return Math.floor((now - shift) / DAY_MS)
}

function sniffImage(buffer) {
  if (buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: 'jpg', mime: 'image/jpeg' }
  }
  if (buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { ext: 'png', mime: 'image/png' }
  }
  return null
}

function sizeFromUrl(url) {
  const match = /(\d{3,5})x(\d{3,5})/.exec(url || '')
  if (!match) return { width: 0, height: 0 }
  return { width: Number(match[1]), height: Number(match[2]) }
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readJsonBody(req, limit = 8192) {
  return await new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`))
      }
    })
    req.on('error', reject)
  })
}

/* ------------------------------------------------------------------- HTTP */

async function requestText(url, timeoutMs) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
      referer: 'https://worldoftanks.eu/',
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return await response.text()
}

async function requestBinary(url, timeoutMs) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'user-agent': USER_AGENT,
      accept: 'image/avif,image/webp,image/jpeg,image/png,*/*;q=0.8',
      referer: 'https://worldoftanks.eu/',
    },
  })
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`)
  return Buffer.from(await response.arrayBuffer())
}

/* --------------------------------------------------------------- scraping */

function extractCandidates(html) {
  const seen = new Set()
  const out = []
  const pattern = /\/en\/media\/1\/([a-z0-9][a-z0-9-]*)\/?/g
  let match
  while ((match = pattern.exec(html)) !== null) {
    const slug = match[1]
    if (seen.has(slug)) continue
    seen.add(slug)
    out.push({ slug, page: `https://worldoftanks.eu/en/media/1/${slug}/` })
  }
  return out
}

function rankCandidate(candidate, index) {
  let score = 0
  if (GOOD_HINTS.test(candidate.slug)) score += 5
  if (BAD_HINTS.test(candidate.slug)) score -= 10
  return { candidate, index, score }
}

function pickTitle(html, slug) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html)
  if (og && og[1].trim()) return decodeEntities(og[1].trim())
  const title = /<title>([^<]+)<\/title>/i.exec(html)
  if (title && title[1].trim()) return decodeEntities(title[1].trim()).replace(/\s*\|\s*World of Tanks.*$/i, '')
  return slug
}

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function pickImageUrl(html) {
  const found = html.match(/https:\/\/[a-z0-9.-]*wgcdn\.co\/[^"'\s)<>\]]+\.(?:jpg|jpeg|png)/gi) || []
  const urls = []
  const seen = new Set()
  for (const raw of found) {
    const url = raw.replace(/\\\//g, '/')
    if (!/\/dcont\/fb\/image\//i.test(url)) continue
    if (seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  for (const size of SIZE_ORDER) {
    const hit = urls.find((url) => url.toLowerCase().includes(size))
    if (hit) return hit
  }
  return urls[0] ?? null
}

/* --------------------------------------------------------------- download */

let running = null

function isRefreshing() {
  return running !== null
}

function refresh(force) {
  if (running) return running
  running = doRefresh(force === true).finally(() => {
    running = null
  })
  return running
}

async function doRefresh(force) {
  const state = await loadState()
  const now = Date.now()
  const stale = now - state.updatedAt > REFRESH_DAYS * DAY_MS
  const empty = state.images.length === 0
  if (!force) {
    if (!stale && !empty) return state
    if (state.lastError && now - state.lastAttemptAt < RETRY_AFTER_MS) return state
  }

  const started = now
  const next = { ...state, lastAttemptAt: now }
  const failures = []

  try {
    let html = null
    let listingError = null
    for (const url of LISTING_URLS) {
      try {
        html = await requestText(url, 25000)
        break
      } catch (error) {
        listingError = error
      }
    }
    if (!html) throw listingError ?? new Error('no listing page reachable')

    const candidates = extractCandidates(html)
    if (!candidates.length) throw new Error('no wallpaper articles found on the official listing page')

    const ranked = candidates
      .map((candidate, index) => rankCandidate(candidate, index))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.candidate)

    const wanted = targetCount({ count: state.count })
    // Look at more pages than we keep, so a page without a usable image can be skipped.
    const picks = ranked.slice(0, Math.max(wanted * 2, 20))
    const images = []

    for (const candidate of picks) {
      if (images.length >= wanted) break
      if (Date.now() - started > REFRESH_BUDGET_MS) break
      try {
        const detail = await requestText(candidate.page, 25000)
        const title = pickTitle(detail, candidate.slug)
        const remote = pickImageUrl(detail)
        if (!remote) {
          failures.push(`${candidate.slug}: no wallpaper image on page`)
          continue
        }

        const known = state.images.find((image) => image.id === candidate.slug)
        let entry = null
        if (known && (await fileExists(path.join(imageDir(), known.file)))) {
          entry = { ...known, title, remote }
        } else {
          const buffer = await requestBinary(remote, 60000)
          const kind = sniffImage(buffer)
          if (!kind) {
            failures.push(`${candidate.slug}: downloaded bytes are not an image`)
            continue
          }
          const file = `${candidate.slug}.${kind.ext}`
          await mkdir(imageDir(), { recursive: true })
          const target = path.join(imageDir(), file)
          const tmp = `${target}.${process.pid}.tmp`
          await writeFile(tmp, buffer)
          await rename(tmp, target)
          const size = sizeFromUrl(remote)
          entry = {
            id: candidate.slug,
            title,
            file,
            mime: kind.mime,
            bytes: buffer.length,
            width: size.width,
            height: size.height,
            remote,
            source: candidate.page,
            addedAt: Date.now(),
          }
        }

        images.push(entry)
        next.images = images.slice()
        await saveState(next)
      } catch (error) {
        failures.push(`${candidate.slug}: ${error?.message ?? error}`)
      }
    }

    if (!images.length) {
      next.lastError = failures[0] ?? 'no wallpaper could be downloaded'
      await saveState(next)
      return next
    }

    next.images = images
    next.updatedAt = Date.now()
    next.lastError = failures.length ? failures.slice(0, 3).join('; ') : null
    await saveState(next)
    await pruneImages(images)
    return next
  } catch (error) {
    next.lastError = error?.message ?? String(error)
    await saveState(next)
    return next
  }
}

async function pruneImages(keep) {
  try {
    const keepFiles = new Set(keep.map((image) => image.file))
    const files = await readdir(imageDir())
    for (const file of files) {
      if (keepFiles.has(file)) continue
      if (!/\.(?:jpg|jpeg|png)$/i.test(file)) continue
      await unlink(path.join(imageDir(), file)).catch(() => {})
    }
  } catch {
    /* nothing to prune */
  }
}

/* ---------------------------------------------------------------- serving */

function publicState(state) {
  const count = state.images.length
  const offset = count ? ((state.offset % count) + count) % count : 0
  const today = localDaySerial()
  const index = count ? (((today + offset) % count) + count) % count : -1
  return {
    enabled: state.enabled !== false,
    offset: state.offset,
    count,
    today,
    index,
    intervalDays: REFRESH_DAYS,
    updatedAt: state.updatedAt,
    refreshAt: state.updatedAt ? state.updatedAt + REFRESH_DAYS * DAY_MS : 0,
    lastError: state.lastError ?? null,
    busy: isRefreshing(),
    source: 'worldoftanks.eu',
    images: state.images.map((image) => ({
      id: image.id,
      title: image.title,
      url: `${PREFIX}/img/${encodeURIComponent(image.id)}`,
      remote: image.remote,
      source: image.source,
      width: image.width,
      height: image.height,
    })),
  }
}

function kickRefreshIfDue(state) {
  const due = !state.images.length || Date.now() - state.updatedAt > REFRESH_DAYS * DAY_MS
  if (!due || isRefreshing()) return
  if (state.lastError && Date.now() - state.lastAttemptAt < RETRY_AFTER_MS) return
  refresh(false).catch(() => {})
}

async function handleState(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' })
  }
  const state = await loadState()
  kickRefreshIfDue(state)
  return sendJson(res, 200, publicState(state))
}

async function handleImage(req, res, target) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return sendJson(res, 405, { error: 'method not allowed' })
  }
  const raw = target.pathname.slice(`${PREFIX}/img/`.length)
  let id = ''
  try {
    id = decodeURIComponent(raw)
  } catch {
    return sendJson(res, 400, { error: 'bad id' })
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return sendJson(res, 400, { error: 'bad id' })

  const state = await loadState()
  const entry = state.images.find((image) => image.id === id)
  if (!entry) return sendJson(res, 404, { error: 'unknown wallpaper' })

  const file = path.join(imageDir(), entry.file)
  if (path.dirname(file) !== imageDir()) return sendJson(res, 400, { error: 'bad path' })

  let buffer
  try {
    buffer = await readFile(file)
  } catch {
    return sendJson(res, 404, { error: 'file missing' })
  }
  res.writeHead(200, {
    'content-type': entry.mime || 'image/jpeg',
    'content-length': String(buffer.length),
    'cache-control': 'public, max-age=604800',
    'x-content-type-options': 'nosniff',
  })
  res.end(req.method === 'HEAD' ? undefined : buffer)
}

async function handleAction(req, res) {
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
  let body
  try {
    body = await readJsonBody(req, 128 * 1024)
  } catch (error) {
    return sendJson(res, 400, { error: error.message })
  }

  const action = typeof body?.action === 'string' ? body.action : ''
  const state = await loadState()

  switch (action) {
    case 'next':
      state.offset = (state.offset || 0) + 1
      break
    case 'prev':
      state.offset = (state.offset || 0) - 1
      break
    case 'reset':
      state.offset = 0
      break
    case 'enable':
      state.enabled = true
      break
    case 'disable':
      state.enabled = false
      break
    case 'refresh':
      refresh(true).catch(() => {})
      break
    default:
      return sendJson(res, 400, { error: `unknown action: ${action || '(none)'}` })
  }

  await saveState(state)
  return sendJson(res, 200, publicState(state))
}

/* ----------------------------------------------------------------- plugin */

/** Remove files that earlier (debug) builds of this plugin wrote into the cache. */
async function tidyLegacyFiles() {
  for (const stale of ['access.log', 'diag.json']) {
    await unlink(path.join(dataDir(), stale)).catch(() => {})
  }
}

export function apply(ctx, config) {
  tidyLegacyFiles().catch(() => {})
  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: `${PREFIX}/state`,
        handler: (req, res) => {
          handleState(req, res).catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
        },
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: `${PREFIX}/action`,
        handler: (req, res) => {
          handleAction(req, res).catch((error) => sendJson(res, 500, { error: String(error?.message ?? error) }))
        },
      }),
      ctx.webServer.register({
        kind: 'prefix',
        // No trailing slash: the server matches `prefix` exactly or `prefix/…`,
        // so `'/wot-wallpaper/img/'` would never match `'/wot-wallpaper/img/x'`.
        path: `${PREFIX}/img`,
        handler: (req, res) => {
          const target = new URL(String(req.url ?? '/'), 'http://localhost')
          handleImage(req, res, target).catch((error) =>
            sendJson(res, 500, { error: String(error?.message ?? error) }),
          )
        },
      }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already gone */
        }
      }
    }
  }, 'wot-wallpaper: routes')

  ctx.effect(() => {
    let disposed = false
    loadState()
      .then((state) => {
        if (disposed) return
        if (targetCount(config) !== state.count) {
          state.count = targetCount(config)
          saveState(state).catch(() => {})
        }
        kickRefreshIfDue(state)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, 'wot-wallpaper: bootstrap')
}

/** Exposed for local testing only. */
export const internals = {
  apply,
  doRefresh,
  extractCandidates,
  loadState,
  pickImageUrl,
  pickTitle,
  publicState,
  refresh,
  saveState,
  dataDir,
  imageDir,
}
