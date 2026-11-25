// Logique commune : créneaux du site, lecture de l'agenda iCloud (ICS), réservations.
import ical from "node-ical"
import { getStore } from "@netlify/blobs"

// Mêmes règles que le calendrier du site (index.html, « prise de RDV »).
export const DUR_MIN = 45
export const SLOTS: Record<number, string[]> = {
  4: ["17:30", "18:15", "19:00"],
  5: ["17:30", "18:15", "19:00"],
  6: ["09:00", "09:45", "10:30", "11:15", "12:00", "12:45", "13:30", "14:15", "15:00", "15:45", "16:30", "17:15", "18:00", "18:45"],
}
export const OFF = ["2026-11-21"]
const DAYS_AHEAD = 75
const TZ = "Europe/Paris"

export const ORIGINS = ["https://l0ic02.github.io"]

export function cors(req: Request): Record<string, string> {
  const o = req.headers.get("origin") || ""
  const ok = ORIGINS.includes(o) || /^http:\/\/localhost(:\d+)?$/.test(o)
  return ok ? { "access-control-allow-origin": o, "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" } : { vary: "origin" }
}

// Composantes de date/heure à Paris pour un instant donné.
function parisParts(d: Date) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false })
  const o: Record<string, string> = {}
  for (const p of f.formatToParts(d)) o[p.type] = p.value
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(o.weekday)
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, wd }
}

// Instant UTC correspondant à une heure locale de Paris.
export function parisToUTC(y: number, m: number, d: number, h = 0, mi = 0): Date {
  const g = Date.UTC(y, m - 1, d, h, mi)
  const p = parisParts(new Date(g))
  const asU = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi)
  return new Date(g - (asU - g))
}

export type Busy = [number, number][]

// Créneaux occupés de l'agenda iCloud publié (lien ICS).
export async function icsBusy(): Promise<Busy> {
  const url = (Netlify.env.get("ICLOUD_ICS_URL") || "").replace(/^webcal:\/\//, "https://")
  if (!url) return []
  const res = await fetch(url, { headers: { "cache-control": "no-cache" } })
  if (!res.ok) throw new Error("ICS " + res.status)
  const data = ical.sync.parseICS(await res.text())
  const from = new Date(Date.now() - 86400000), to = new Date(Date.now() + DAYS_AHEAD * 86400000)
  const out: Busy = []
  for (const k in data) {
    const ev: any = data[k]
    if (!ev || ev.type !== "VEVENT" || ev.recurrenceid) continue
    if (String(ev.transparency || "").toUpperCase() === "TRANSPARENT") continue
    if (String(ev.status || "").toUpperCase() === "CANCELLED") continue
    let inst: any[]
    try { inst = ical.expandRecurringEvent(ev, { from, to }) } catch { inst = [] }
    for (const i of inst) {
      let s: Date = i.start, e: Date = i.end || new Date(+i.start + 3600000)
      if (i.isFullDay) {
        // journée entière : de minuit à minuit, heure de Paris
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

// Réservations faites depuis le site (gardées le temps qu'iCloud republie son agenda).
export function bookings() { return getStore({ name: "reservations", consistency: "strong" }) }

export async function siteBusy(): Promise<Busy> {
  const store = bookings(), out: Busy = []
  const { blobs } = await store.list()
  const now = Date.now()
  for (const b of blobs) {
    const s = Date.parse(b.key)
    if (isNaN(s)) continue
    if (s < now - 86400000) { await store.delete(b.key); continue }
    out.push([s, s + DUR_MIN * 60000])
  }
  return out
}

export async function allBusy(): Promise<Busy> {
  const [a, b] = await Promise.all([icsBusy(), siteBusy()])
  return a.concat(b).sort((x, y) => x[0] - y[0])
}

// Vérifie qu'un début de RDV correspond bien à un créneau proposé par le site.
export function validSlot(start: Date): boolean {
  if (isNaN(+start)) return false
  const now = Date.now()
  if (+start < now + 60 * 60000 || +start > now + DAYS_AHEAD * 86400000) return false
  const p = parisParts(start)
  const key = `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`
  if (OFF.includes(key)) return false
  const hm = `${String(p.h).padStart(2, "0")}:${String(p.mi).padStart(2, "0")}`
  return (SLOTS[p.wd] || []).includes(hm)
}

export function overlaps(busy: Busy, s: number, e: number) { return busy.some(([a, b]) => s < b && e > a) }

export function fmtParis(d: Date) {
  return new Intl.DateTimeFormat("fr-FR", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(d)
}
