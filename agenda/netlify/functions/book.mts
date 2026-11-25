// POST /api/book {start} : crée le RDV dans l'agenda iCloud de Loïc et bloque le créneau sur le site.
import type { Config } from "@netlify/functions"
import { createDAVClient } from "tsdav"
import { allBusy, bookings, cors, DUR_MIN, fmtParis, overlaps, validSlot } from "../lib/agenda.mts"

const z = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")

async function addToICloud(start: Date, end: Date, uid: string, goal: string) {
  const username = Netlify.env.get("ICLOUD_USERNAME"), password = Netlify.env.get("ICLOUD_APP_PASSWORD")
  if (!username || !password) throw new Error("identifiants iCloud manquants")
  const client = await createDAVClient({ serverUrl: "https://caldav.icloud.com", credentials: { username, password }, authMethod: "Basic", defaultAccountType: "caldav" })
  const cals = await client.fetchCalendars()
  const want = (Netlify.env.get("ICLOUD_CALENDAR") || "").trim().toLowerCase()
  const cal = cals.find(c => String(c.displayName || "").trim().toLowerCase() === want) || (want ? undefined : cals.find(c => (c.components || []).includes("VEVENT")))
  if (!cal) throw new Error("calendrier iCloud introuvable : " + want)
  const desc = `Réservé depuis le site (l0ic02.github.io).${goal ? " Objectif : " + goal + "." : ""} La personne doit t'écrire sur WhatsApp pour confirmer. Sans message, tu peux supprimer ce RDV.`
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Loic Thizy//Site RDV//FR", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
    "SUMMARY:Bilan offert (site) – à confirmer", `DESCRIPTION:${desc.replace(/[,;]/g, m => "\\" + m)}`,
    "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", "DESCRIPTION:Bilan dans 1 h", "END:VALARM",
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n")
  const r = await client.createCalendarObject({ calendar: cal, filename: `${uid}.ics`, iCalString: ics })
  if (!r.ok) throw new Error("iCloud " + r.status)
}

export default async (req: Request) => {
  const h = cors(req)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h })
  let body: any = {}
  try { body = await req.json() } catch {}
  const start = new Date(String(body.start || ""))
  const goal = String(body.goal || "").slice(0, 60).replace(/[\r\n]/g, " ")
  if (body.website) return Response.json({ ok: true }, { headers: h }) // piège à robots
  if (!validSlot(start)) return Response.json({ ok: false, error: "créneau invalide" }, { status: 400, headers: h })
  const end = new Date(+start + DUR_MIN * 60000)
  const store = bookings(), key = start.toISOString()
  if (await store.get(key)) return Response.json({ ok: false, error: "créneau déjà pris" }, { status: 409, headers: h })
  if (overlaps(await allBusy(), +start, +end)) return Response.json({ ok: false, error: "créneau déjà pris" }, { status: 409, headers: h })
  const uid = `site-${z(start)}-${Math.random().toString(36).slice(2, 8)}@l0ic02.github.io`
  await store.set(key, JSON.stringify({ uid, at: new Date().toISOString() }))
  try {
    await addToICloud(start, end, uid, goal)
  } catch (e) {
    console.error(e)
    // le créneau reste bloqué sur le site ; Loïc le verra via WhatsApp
    return Response.json({ ok: true, agenda: false, when: fmtParis(start) }, { headers: h })
  }
  return Response.json({ ok: true, agenda: true, when: fmtParis(start) }, { headers: h })
}

export const config: Config = {
  path: "/api/book",
  method: ["POST", "OPTIONS"],
  rateLimit: { windowLimit: 3, windowSize: 60, aggregateBy: ["ip", "domain"] },
}
