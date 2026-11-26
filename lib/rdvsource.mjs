// Source des RDV notés dans le Google Sheet, la plus fraîche possible :
//  1) lecture directe du Sheet par le webhook Apps Script (action « liste », RdvAnnuler v3, appel signé) ;
//  2) sinon (webhook indisponible ou pas encore en v3) : flux iCal Google « RDV Coach », d'où l'on retire
//     les RDV que la mémoire du miroir (dépôt public, HMAC uniquement) a déjà marqués comme annulés.
// Rien ici n'est renvoyé au public : /api/busy n'en garde que les horaires.
import { eventsFromICS, sheetKey, stateHash, webhookSig } from "./mirror.mjs"

const env = (k) => (process.env[k] || "").trim()
const DAY = 86400000
const STATE_URL = "https://raw.githubusercontent.com/l0ic02/loicthizy/main/.github/state/mirror-state.json"
const CACHE_MS = 30000
let cache = { t: 0, v: null }, stateCache = { t: 0, v: null }

// Lecture directe du Sheet. Renvoie [{key, uid, start, end, summary}] ou null (indisponible / pas v3).
export async function sheetList(key = env("GOOGLE_ICS_URL"), url = env("SHEET_WEBHOOK_URL"), doFetch = fetch, timeoutMs = 8000) {
  if (!key || !url) return null
  try {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = { action: "liste", ts, qui: "", date: "", heure: "", sig: webhookSig(key, "liste", ts) }
    const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
    const j = JSON.parse(await r.text())
    if (!j || j.ok !== true || Number(j.version) < 3 || !Array.isArray(j.rdv)) return null
    const out = []
    for (const x of j.rdv) {
      const start = Date.parse(x && x.debut), end = Date.parse(x && x.fin)
      if (!Number.isFinite(start)) continue
      const uid = typeof x.uid === "string" ? x.uid : ""
      out.push({
        // même clé que le miroir a toujours utilisée (UID Google de l'événement RDV Coach) : copies iCloud stables
        key: uid ? sheetKey({ uid, rid: "" }) : "",
        uid, start, end: Number.isFinite(end) && end > start ? end : start + 45 * 60000,
        summary: String(x.titre || "Bilan").trim(),
      })
    }
    return out
  } catch {
    return null
  }
}

// Mémoire du miroir (publique, HMAC seulement) : hachages des RDV annulés.
export async function annulesSet(doFetch = fetch) {
  if (stateCache.v && Date.now() - stateCache.t < 60000) return stateCache.v
  try {
    const r = await doFetch(STATE_URL, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(4000) })
    const j = await r.json()
    stateCache = { t: Date.now(), v: new Set((j.annules || []).map((a) => a[0])) }
  } catch {
    stateCache = { t: Date.now(), v: stateCache.v || new Set() }
  }
  return stateCache.v
}

export async function googleList(key = env("GOOGLE_ICS_URL"), doFetch = fetch) {
  if (!key) return []
  const r = await doFetch(key.replace(/^webcal:\/\//, "https://"), { headers: { "cache-control": "no-cache" } })
  if (!r.ok) throw new Error("ICS " + r.status)
  const now = Date.now()
  const evs = eventsFromICS(await r.text(), new Date(now - DAY), new Date(now + 120 * DAY))
  const annules = await annulesSet(doFetch)
  return evs.filter((e) => !annules.has(stateHash(key, sheetKey(e)))).map((e) => ({ key: sheetKey(e), uid: e.uid, start: e.start, end: e.end, summary: e.summary }))
}

// { source: "sheet" | "google" | "aucune", events }
export async function rdvSource({ fresh = false, doFetch = fetch } = {}) {
  if (!fresh && cache.v && Date.now() - cache.t < CACHE_MS) return cache.v
  const list = await sheetList(undefined, undefined, doFetch)
  let v
  if (list) v = { source: "sheet", events: list }
  else if (env("GOOGLE_ICS_URL")) v = { source: "google", events: await googleList(undefined, doFetch) }
  else v = { source: "aucune", events: [] }
  cache = { t: Date.now(), v }
  return v
}

export function _resetCache() { cache = { t: 0, v: null }; stateCache = { t: 0, v: null } }
