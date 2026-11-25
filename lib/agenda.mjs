// Service agenda (Vercel) : synchro temps réel entre l'agenda iCloud de Loïc et le site.
// Lecture : lien ICS publié + lecture directe CalDAV (sans délai). Écriture : CalDAV iCloud.
import ical from "node-ical"
import { createDAVClient } from "tsdav"

// Mêmes règles que le calendrier du site (index.html, « prise de RDV »).
export const DUR_MIN = 45
export const SLOTS = {
  4: ["17:30", "18:15", "19:00"],
  5: ["17:30", "18:15", "19:00"],
  6: ["09:00", "09:45", "10:30", "11:15", "12:00", "12:45", "13:30", "14:15", "15:00", "15:45", "16:30", "17:15", "18:00", "18:45"],
}
export const OFF = ["2026-11-21"]
const DAYS_AHEAD = 75
const TZ = "Europe/Paris"
const ORIGINS = ["https://l0ic02.github.io"]
const env = (k) => (process.env[k] || "").trim()

export function cors(req) {
  const o = req.headers.get("origin") || ""
  const ok = ORIGINS.includes(o) || /^http:\/\/localhost(:\d+)?$/.test(o)
  return ok
    ? { "access-control-allow-origin": o, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" }
    : { vary: "origin" }
}

function parisParts(d) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
  const o = {}
  for (const p of f.formatToParts(d)) o[p.type] = p.value
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday) }
}

export function parisToUTC(y, m, d, h = 0, mi = 0) {
  const g = Date.UTC(y, m - 1, d, h, mi)
  const p = parisParts(new Date(g))
  return new Date(g - (Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - g))
}

// Transforme un texte ICS en créneaux occupés [début, fin] (ms).
export function busyFromICS(text, from, to) {
  const data = ical.sync.parseICS(text), out = []
  for (const k in data) {
    const ev = data[k]
    if (!ev || ev.type !== "VEVENT" || ev.recurrenceid) continue
    if (String(ev.transparency || "").toUpperCase() === "TRANSPARENT") continue
    if (String(ev.status || "").toUpperCase() === "CANCELLED") continue
    let inst
    try { inst = ical.expandRecurringEvent(ev, { from, to }) } catch { inst = [] }
    for (const i of inst) {
      let s = i.start, e = i.end || new Date(+i.start + 3600000)
      if (i.isFullDay) {
        const a = new Date(s), b = new Date(e)
        s = parisToUTC(a.getUTCFullYear(), a.getUTCMonth() + 1, a.getUTCDate())
        e = parisToUTC(b.getUTCFullYear(), b.getUTCMonth() + 1, b.getUTCDate())
        if (+e <= +s) e = new Date(+s + 86400000)
      }
      if (+e < +from || +s > +to) continue
      out.push([+s, +e])
    }
  }
  return out
}

const range = () => [new Date(Date.now() - 86400000), new Date(Date.now() + DAYS_AHEAD * 86400000)]

async function icsBusy() {
  const url = env("ICLOUD_ICS_URL").replace(/^webcal:\/\//, "https://")
  if (!url) return []
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } })
  if (!res.ok) throw new Error("ICS " + res.status)
  const [from, to] = range()
  return busyFromICS(await res.text(), from, to)
}

// Connexion CalDAV iCloud et calendrier cible.
export async function icloud() {
  const username = env("ICLOUD_USERNAME"), password = env("ICLOUD_APP_PASSWORD")
  if (!username || !password) return null
  const client = await createDAVClient({ serverUrl: "https://caldav.icloud.com", credentials: { username, password }, authMethod: "Basic", defaultAccountType: "caldav" })
  const cals = await client.fetchCalendars()
  const want = env("ICLOUD_CALENDAR").toLowerCase()
  const cal = cals.find((c) => String(c.displayName || "").trim().toLowerCase() === want) || (want ? null : cals.find((c) => (c.components || []).includes("VEVENT")))
  if (!cal) throw new Error("calendrier iCloud introuvable : " + want)
  return { client, cal }
}

// Lecture directe du calendrier par CalDAV (voit tout de suite les RDV créés depuis le site).
async function caldavBusy(ic) {
  if (!ic) return []
  const [from, to] = range()
  const objs = await ic.client.fetchCalendarObjects({ calendar: ic.cal, timeRange: { start: from.toISOString(), end: to.toISOString() } })
  return objs.flatMap((o) => (o.data ? busyFromICS(o.data, from, to) : []))
}

export async function allBusy(ic) {
  const res = await Promise.allSettled([icsBusy(), caldavBusy(ic)])
  if (res.every((r) => r.status === "rejected")) throw res[0].reason
  return res.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).sort((a, b) => a[0] - b[0])
}

export function validSlot(start) {
  if (isNaN(+start)) return false
  const now = Date.now()
  if (+start < now + 60 * 60000 || +start > now + DAYS_AHEAD * 86400000) return false
  const p = parisParts(start)
  const key = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`
  if (OFF.includes(key)) return false
  const hm = `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`
  return (SLOTS[p.wd] || []).includes(hm)
}

export const overlaps = (busy, s, e) => busy.some(([a, b]) => s < b && e > a)

export const fmtParis = (d) => new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d)
