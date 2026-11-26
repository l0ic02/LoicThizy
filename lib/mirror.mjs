// Miroir agenda Google « RDV Coach » (lien GOOGLE_ICS_URL) -> calendrier iCloud de Loïc (CalDAV).
// A) Sheet -> iCloud : chaque événement de RDV Coach est recopié dans iCloud avec un UID
//    « sheet-<hash>@l0ic02.github.io ». Seuls ces événements sont créés, modifiés ou supprimés :
//    tout autre événement iCloud (RDV à la main, réservations « site-… ») n'est JAMAIS touché.
// B) iCloud -> Sheet (voir IMPORT_ACTIF) : les événements iCloud dont le titre commence
//    par « Bilan » (hors sheet-/site-) seraient envoyés au Sheet par SHEET_WEBHOOK_URL.
// Aucun nom ni URL dans les logs ou la réponse : uniquement des compteurs et des hachages.
import crypto from "node:crypto"
import ical from "node-ical"
import { DUR_MIN } from "./agenda.mjs"

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

// Objets iCloud de la fenêtre -> { ours: Map(clé -> {obj, start, end, summary}), foreign: [{uid, start, summary}] }
export function splitIcloud(objs, from, to) {
  const ours = new Map(), foreign = []
  for (const o of objs) {
    if (!o || !o.data) continue
    const uidLine = /^UID:(.+)$/m.exec(o.data.replace(/\r\n[ \t]/g, ""))
    const uid = uidLine ? uidLine[1].trim() : ""
    let evs = []
    try { evs = eventsFromICS(o.data, from, to) } catch { evs = [] }
    if (uid.startsWith(PREFIX) && uid.endsWith(DOMAIN)) {
      const key = uid.slice(PREFIX.length, -DOMAIN.length)
      const ev = evs[0]
      ours.set(key, { obj: o, start: ev ? ev.start : NaN, end: ev ? ev.end : NaN, summary: ev ? ev.summary : "" })
    } else {
      for (const ev of evs) foreign.push({ uid, start: ev.start, summary: ev.summary })
    }
  }
  return { ours, foreign }
}

// ---------- A) RDV Coach -> iCloud ----------
export async function mirrorToIcloud({ icsText, client, cal, now = Date.now(), maxWrites = MAX_WRITES }) {
  const from = new Date(now - WINDOW_BEFORE), to = new Date(now + WINDOW_AFTER)
  const stats = { source: 0, crees: 0, modifies: 0, supprimes: 0, inchanges: 0, doublons: 0, reportes: 0, erreurs: 0 }
  if (!/BEGIN:VCALENDAR/.test(icsText || "")) throw new Error("flux RDV Coach invalide")
  const wanted = new Map()
  for (const ev of eventsFromICS(icsText, from, to)) wanted.set(sheetKey(ev), ev)
  stats.source = wanted.size

  const objs = await client.fetchCalendarObjects({ calendar: cal, timeRange: { start: from.toISOString(), end: to.toISOString() } })
  const { ours, foreign } = splitIcloud(objs, from, to)
  const dupe = (start) => foreign.some((f) => Math.abs(f.start - start) <= DOUBLON_MS)
  let writes = 0
  const canWrite = () => (writes < maxWrites ? (writes++, true) : (stats.reportes++, false))
  const ok = (r) => r && (r.ok || r.status === 201 || r.status === 204)

  for (const [key, ev] of wanted) {
    const cur = ours.get(key)
    if (dupe(ev.start)) {                       // déjà un autre RDV à ±15 min dans iCloud
      stats.doublons++
      if (cur && canWrite()) {
        const r = await client.deleteCalendarObject({ calendarObject: cur.obj })
        ok(r) || r.status === 404 ? stats.supprimes++ : stats.erreurs++
      }
      continue
    }
    if (!cur) {
      if (!canWrite()) continue
      const r = await client.createCalendarObject({ calendar: cal, filename: `${PREFIX}${key}.ics`, iCalString: sheetIcs(key, ev, now) })
      ok(r) ? stats.crees++ : stats.erreurs++
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
    ok(r) || (r && r.status === 404) ? stats.supprimes++ : stats.erreurs++
  }
  return { stats, foreign }
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

function parisDateHeure(ms) {
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
