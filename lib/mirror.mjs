// Miroir agenda Google « RDV Coach » (lien GOOGLE_ICS_URL) -> calendrier iCloud de Loïc (CalDAV).
// A) Sheet -> iCloud : chaque événement de RDV Coach est recopié dans iCloud avec un UID
//    « sheet-<hash>@l0ic02.github.io ». Seuls ces événements sont créés, modifiés ou supprimés :
//    tout autre événement iCloud (RDV à la main, réservations « site-… ») n'est JAMAIS touché.
// B) iCloud -> Sheet (voir IMPORT_ACTIF) : les événements iCloud dont le titre commence
//    par « Bilan » (hors sheet-/site-) seraient envoyés au Sheet par SHEET_WEBHOOK_URL.
// Aucun nom ni URL dans les logs ou la réponse : uniquement des compteurs et des hachages.
import crypto from "node:crypto"
import ical from "node-ical"
const DUR_MIN = 45

// B actif : le doPost de RdvSite.gs a été vérifié (payload page/prenom/nom/tel/date/heure/format).
export const IMPORT_ACTIF = true

export const PREFIX = "sheet-"
const DOMAIN = "@l0ic02.github.io"
const DAY = 86400000
export const WINDOW_BEFORE = 1 * DAY
export const WINDOW_AFTER = 120 * DAY
export const DOUBLON_MS = 15 * 60000
export const MAX_WRITES = 20
export const MAX_IMPORTS = 5
export const MAX_SKEW_S = 300

const env = (k) => (process.env[k] || "").trim()
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex")
const text = (v) => (v && typeof v === "object" && "val" in v ? String(v.val) : String(v || "")).trim()

// ---------- Authentification : HMAC-SHA256(clé = GOOGLE_ICS_URL, message = "mirror:" + horodatage) ----------
export function sign(key, ts) {
  return crypto.createHmac("sha256", key).update("mirror:" + ts).digest("hex")
}

export function verify(key, ts, sig, nowMs = Date.now()) {
  if (!key || !/^\d{9,11}$/.test(String(ts || "")) || !/^[0-9a-f]{64}$/.test(String(sig || ""))) return false
  if (Math.abs(nowMs / 1000 - Number(ts)) > MAX_SKEW_S) return false
  const a = Buffer.from(sign(key, String(ts)), "hex"), b = Buffer.from(String(sig), "hex")
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// ---------- Lecture ICS : événements avec heure, dans la fenêtre ----------
export function eventsFromICS(raw, from, to) {
  const data = ical.sync.parseICS(raw), out = []
  for (const k in data) {
    const ev = data[k]
    if (!ev || ev.type !== "VEVENT" || ev.recurrenceid) continue
    if (String(ev.status || "").toUpperCase() === "CANCELLED") continue
    let inst
    try { inst = ical.expandRecurringEvent(ev, { from, to }) } catch { inst = [] }
    for (const i of inst) {
      if (i.isFullDay) continue
      const s = new Date(i.start), e = i.end ? new Date(i.end) : new Date(+s + DUR_MIN * 60000)
      if (+s < +from || +s > +to) continue
      out.push({
        uid: String(ev.uid || k),
        rid: i.isRecurring ? s.toISOString() : "",
        start: +s, end: +e > +s ? +e : +s + DUR_MIN * 60000,
        summary: text(i.summary || ev.summary),
      })
    }
  }
  return out
}

export const sheetKey = (ev) => sha("rdvcoach|" + ev.uid + "|" + ev.rid).slice(0, 24)

const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
const esc = (s) => s.replace(/[\\,;]/g, (m) => "\\" + m).replace(/\r?\n/g, "\\n")

export function sheetIcs(key, ev, stamp = Date.now()) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Loic Thizy//Miroir RDV Coach//FR", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${PREFIX}${key}${DOMAIN}`, `DTSTAMP:${z(stamp)}`, `DTSTART:${z(ev.start)}`, `DTEND:${z(ev.end)}`,
    `SUMMARY:${esc(ev.summary || "Bilan")}`,
    `DESCRIPTION:${esc("Copie automatique de l'agenda « RDV Coach » (Google Sheet). Pour changer ce RDV, modifie le Sheet.")}`,
    "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", "DESCRIPTION:Bilan dans 1 h", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n")
}

// Objets iCloud -> { ours: Map(clé -> {obj, start, end, summary}) (fenêtre seulement),
//                    foreign: [{uid, start, summary}] (fenêtre), uids: Set de TOUS les UID reçus }
export function splitIcloud(objs, from, to) {
  const ours = new Map(), foreign = [], uids = new Set()
  for (const o of objs) {
    if (!o || !o.data) continue
    const uidLine = /^UID:(.+)$/m.exec(o.data.replace(/\r\n[ \t]/g, ""))
    const uid = uidLine ? uidLine[1].trim() : ""
    if (uid) uids.add(uid)
    let evs = []
    try { evs = eventsFromICS(o.data, from, to) } catch { evs = [] }
    if (uid.startsWith(PREFIX) && uid.endsWith(DOMAIN)) {
      const ev = evs[0]
      if (!ev) continue                         // copie hors fenêtre (ex. passée) : on n'y touche pas
      ours.set(uid.slice(PREFIX.length, -DOMAIN.length), { obj: o, start: ev.start, end: ev.end, summary: ev.summary })
    } else {
      for (const ev of evs) foreign.push({ uid, start: ev.start, summary: ev.summary })
    }
  }
  return { ours, foreign, uids }
}

// ---------- Annulation depuis iCloud (sécurités) ----------
export const MAX_ANNULATIONS = 3
const PRESENCE_BEFORE = 30 * DAY, PRESENCE_AFTER = 400 * DAY   // un RDV déplacé loin n'est pas « supprimé »
const GARDE_MS = 2 * DAY
const isBilan = (f) => /^bilan\b/i.test(f.summary || "") || String(f.uid || "").startsWith("site-")
export const stateHash = (key, x) => crypto.createHmac("sha256", key).update("state|" + x).digest("hex").slice(0, 24)

export function cleanState(st) {
  const ok = (h) => typeof h === "string" && /^[0-9a-f]{24}$/.test(h)
  const s = st && typeof st === "object" ? st : {}
  return {
    v: 1, n: Number.isFinite(s.n) ? s.n : 0,
    pairs: (Array.isArray(s.pairs) ? s.pairs : []).filter((p) => Array.isArray(p) && ok(p[0]) && ok(p[1])).slice(0, 2000),
    annules: (Array.isArray(s.annules) ? s.annules : []).filter((p) => Array.isArray(p) && ok(p[0]) && Number.isFinite(p[1])).slice(0, 2000),
    attente: (Array.isArray(s.attente) ? s.attente : []).filter((p) => Array.isArray(p) && ok(p[0]) && Number.isFinite(p[1])).slice(0, 2000),
  }
}


// ---------- A) RDV Coach -> iCloud (+ détection des suppressions faites dans iCloud) ----------
// webhook (optionnel) : { ping: async () => bool (RdvSite v2 ?), annuler: async ({qui,date,heure}) => {ok, error} }
// Source : events = [{key, start, end, summary}] (lecture directe du Sheet), sinon icsText (flux Google « RDV Coach »).
export async function mirrorToIcloud({ icsText, events = null, client, cal, now = Date.now(), maxWrites = MAX_WRITES, state, hmacKey = "", webhook = null }) {
  const from = new Date(now - WINDOW_BEFORE), to = new Date(now + WINDOW_AFTER)
  const stats = { source: 0, crees: 0, modifies: 0, supprimes: 0, inchanges: 0, doublons: 0, reportes: 0, erreurs: 0,
    annul_detectees: 0, annul_envoyees: 0, annul_echecs: 0, annul_inactives: 0, gel: 0 }
  const wanted = new Map()
  if (events) {
    for (const ev of events) if (ev.key && ev.start >= +from && ev.start <= +to) wanted.set(ev.key, ev)
  } else {
    if (!/BEGIN:VCALENDAR/.test(icsText || "")) throw new Error("flux RDV Coach invalide")
    for (const ev of eventsFromICS(icsText, from, to)) wanted.set(sheetKey(ev), ev)
  }
  stats.source = wanted.size

  const objs = await client.fetchCalendarObjects({ calendar: cal, timeRange: {
    start: new Date(now - PRESENCE_BEFORE).toISOString(), end: new Date(now + PRESENCE_AFTER).toISOString() } })
  if (!Array.isArray(objs)) throw new Error("iCloud illisible")
  const { ours, foreign, uids } = splitIcloud(objs, from, to)
  const H = (x) => stateHash(hmacKey, x)
  const presentH = new Set([...uids].map(H))
  const dupe = (start) => foreign.some((f) => Math.abs(f.start - start) <= DOUBLON_MS)
  const bilanNear = (start) => foreign.filter((f) => isBilan(f) && Math.abs(f.start - start) <= DOUBLON_MS)
    .sort((a, b) => Math.abs(a.start - start) - Math.abs(b.start - start))[0]

  // --- suppressions faites dans iCloud ---
  const prev = cleanState(state)
  const prevPair = new Map(prev.pairs)
  const annules = new Map(prev.annules), attente = new Map(prev.attente)
  const cand = []
  for (const [key, ev] of wanted) {
    const hk = H(key)
    if (annules.has(hk) || ev.start <= now) continue                 // déjà annulé / passé : jamais
    if (ours.has(key) || bilanNear(ev.start)) continue               // un équivalent existe encore (ou a été déplacé ici)
    const c = prevPair.get(hk)
    if ((c && !presentH.has(c)) || attente.has(hk)) cand.push([key, ev])   // disparu (pas seulement déplacé) ou à réessayer
  }
  stats.annul_detectees = cand.length
  // Gel (aucune annulation, aucune recréation, mémoire inchangée) seulement s'il y a des annulations en jeu et que
  // iCloud paraît vide / anormalement court, ou qu'il y en a plus de 3 d'un coup.
  let gel = false
  if (cand.length && (objs.length === 0 || (prev.n >= 4 && objs.length < prev.n / 2))) gel = true
  if (cand.length > MAX_ANNULATIONS) gel = true
  if (gel) {
    stats.gel = 1
    console.error("mirror gel", JSON.stringify({ objets: objs.length, avant: prev.n, detectees: cand.length }))
  }
  const skip = new Set()                                             // clés à ne pas (re)créer ce passage
  for (const [key] of wanted) if (annules.has(H(key))) skip.add(key)
  if (gel) { for (const [key] of wanted) if (prevPair.has(H(key)) && !ours.has(key)) skip.add(key) }
  else if (cand.length) {
    const actif = webhook ? await webhook.ping().catch(() => false) : false
    if (!actif) stats.annul_inactives = cand.length                  // RdvSite pas encore à jour : comportement d'avant (copie recréée)
    else for (const [key, ev] of cand) {
      skip.add(key)
      const qui = (ev.summary || "").replace(/^bilan\b\s*/i, "").trim()
      const res = await webhook.annuler({ qui, ...parisDateHeure(ev.start) }).catch(() => ({ ok: false }))
      if (res && res.ok) { stats.annul_envoyees++; annules.set(H(key), now); attente.delete(H(key)) }
      else { stats.annul_echecs++; attente.set(H(key), attente.get(H(key)) || now) }
    }
  }

  // --- recopie ---
  let writes = 0
  const canWrite = () => (writes < maxWrites ? (writes++, true) : (stats.reportes++, false))
  const ok = (r) => r && (r.ok || r.status === 201 || r.status === 204)
  const after = new Set(ours.keys())                                 // nos copies après ce passage

  for (const [key, ev] of wanted) {
    const cur = ours.get(key)
    if (dupe(ev.start)) {                       // déjà un autre RDV à ±15 min dans iCloud
      stats.doublons++
      if (cur && canWrite()) {
        const r = await client.deleteCalendarObject({ calendarObject: cur.obj })
        if (ok(r) || (r && r.status === 404)) { stats.supprimes++; after.delete(key) } else stats.erreurs++
      }
      continue
    }
    if (!cur) {
      if (skip.has(key) || !canWrite()) continue
      const r = await client.createCalendarObject({ calendar: cal, filename: `${PREFIX}${key}.ics`, iCalString: sheetIcs(key, ev, now) })
      if (ok(r)) { stats.crees++; after.add(key) } else stats.erreurs++
      continue
    }
    if (cur.start === ev.start && cur.end === ev.end && cur.summary === (ev.summary || "Bilan")) { stats.inchanges++; continue }
    if (!canWrite()) continue
    const r = await client.updateCalendarObject({ calendarObject: { url: cur.obj.url, etag: cur.obj.etag, data: sheetIcs(key, ev, now) } })
    ok(r) ? stats.modifies++ : stats.erreurs++
  }
  for (const [key, cur] of ours) {
    if (wanted.has(key)) continue
    if (!canWrite()) continue
    const r = await client.deleteCalendarObject({ calendarObject: cur.obj })
    if (ok(r) || (r && r.status === 404)) { stats.supprimes++; after.delete(key) } else stats.erreurs++
  }

  // --- nouvel état (uniquement des HMAC) ---
  let next
  if (gel) next = { ...prev, annules: [...annules], attente: [...attente] }
  else {
    const pairs = []
    for (const [key, ev] of wanted) {
      const hk = H(key)
      if (annules.has(hk) || attente.has(hk)) continue
      if (after.has(key)) pairs.push([hk, H(PREFIX + key + DOMAIN)])
      else { const f = bilanNear(ev.start); if (f) pairs.push([hk, H(f.uid)]) }
    }
    const wantedH = new Set([...wanted.keys()].map(H))
    const garde = ([hk, t]) => wantedH.has(hk) || now - t < GARDE_MS
    next = { v: 1, n: objs.length, pairs, annules: [...annules].filter(garde), attente: [...attente].filter(garde) }
  }
  return { stats, foreign, state: next }
}

// ---------- Appels signés au doPost (RdvSite v2) ----------
// sig = HMAC-SHA256(clé = GOOGLE_ICS_URL, "action|ts|qui|date|heure") ; RdvSite lit la même clé dans ses propriétés.
export function webhookSig(key, action, ts, qui = "", date = "", heure = "") {
  return crypto.createHmac("sha256", key).update([action, ts, qui, date, heure].join("|")).digest("hex")
}

export function makeWebhook(key, url = env("SHEET_WEBHOOK_URL"), doFetch = fetch) {
  if (!key || !url) return null
  const call = async (action, f = {}) => {
    const ts = String(Math.floor(Date.now() / 1000))
    const body = { action, ts, qui: f.qui || "", date: f.date || "", heure: f.heure || "" }
    body.sig = webhookSig(key, action, ts, body.qui, body.date, body.heure)
    const r = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "follow", signal: AbortSignal.timeout(15000) })
    try { return JSON.parse(await r.text()) } catch { return { ok: false } }
  }
  return {
    ping: async () => { const j = await call("ping"); return !!(j && j.ok === true && Number(j.version) >= 2) },
    annuler: async (f) => { const j = await call("annuler", f); return { ok: !!(j && j.ok === true), error: j && j.error } },
  }
}

// ---------- B) iCloud -> Sheet (préparé, désactivé) ----------
// Clé anti-renvoi : HMAC de l'UID (clé = GOOGLE_ICS_URL) -> impossible d'y retrouver un nom ou un UID.
// Basée sur l'UID seul : déplacer ensuite l'événement iCloud ne crée pas de 2e ligne (on modifie le Sheet).
export const importHash = (key, uid) => crypto.createHmac("sha256", key).update("import|" + uid).digest("hex").slice(0, 32)

// « Téléphone » envoyé au doPost : obligatoire pour lui, mais un RDV iCloud n'en a pas. On met un
// repère court, propre à l'événement, avec 6 chiffres : le doPost compare les chiffres du téléphone
// + la date pour ses doublons, donc deux bilans iCloud le même jour ne se bloquent pas entre eux,
// et 6 chiffres ne peuvent pas être confondus avec un vrai numéro (10 chiffres).
export const importTel = (key, uid) => "iCloud " + String(parseInt(importHash(key, "tel|" + uid).slice(0, 8), 16) % 1000000).padStart(6, "0")

export function splitName(summary) {
  const rest = summary.replace(/^bilan\b\s*(ebe\b)?\s*[-–—:]?\s*/i, "").trim()
  const [prenom = "", ...nom] = rest.split(/\s+/).filter(Boolean)
  return { prenom, nom: nom.join(" ") }
}

export function parisDateHeure(ms) {
  const o = {}
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(ms))) o[p.type] = p.value
  return { date: `${o.year}-${o.month}-${o.day}`, heure: `${String(+o.hour % 24).padStart(2, "0")}:${o.minute}` }
}

export async function importToSheet({ foreign, wantedStarts, sent, hmacKey, post, now = Date.now(), actif = IMPORT_ACTIF, max = MAX_IMPORTS }) {
  const stats = { candidats: 0, envoyes: 0, deja: 0, erreurs: 0, reportes: 0 }
  const nouveaux = []
  const known = new Set(sent || [])
  for (const f of foreign) {
    if (!/^bilan\b/i.test(f.summary) || /\(site\)|à confirmer/i.test(f.summary)) continue
    if (f.uid.startsWith(PREFIX) || f.uid.startsWith("site-")) continue
    if (f.start < now) continue                                   // seulement les RDV à venir
    stats.candidats++
    const h = importHash(hmacKey, f.uid)
    if (known.has(h)) { stats.deja++; continue }
    if (wantedStarts.some((s) => Math.abs(s - f.start) <= DOUBLON_MS)) { stats.deja++; continue } // déjà dans RDV Coach
    if (!actif) continue
    if (stats.envoyes + stats.erreurs >= max) { stats.reportes++; continue }
    const { prenom, nom } = splitName(f.summary)
    if (!prenom) continue                                         // « Bilan » seul : le doPost exige un prénom
    const okSent = await post({ page: "client", prenom, nom, tel: importTel(hmacKey, f.uid), format: "ajouté depuis iCloud", ...parisDateHeure(f.start) })
    if (okSent) { stats.envoyes++; nouveaux.push(h); known.add(h) } else stats.erreurs++
  }
  return { stats, nouveaux }
}

export async function postToSheet(row) {
  const url = env("SHEET_WEBHOOK_URL")
  if (!url) return false
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row), redirect: "follow", signal: AbortSignal.timeout(10000) })
    return r.ok && /"ok":\s*true/.test(await r.text())
  } catch { return false }
}
