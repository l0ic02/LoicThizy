// POST /api/book {start} : crée le RDV dans l'agenda iCloud de Loïc (le créneau devient aussitôt occupé sur le site).
import { allBusy, cors, DUR_MIN, fmtParis, icloud, overlaps, validSlot } from "../lib/agenda.mjs"

const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")

export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }) }

export async function POST(req) {
  const h = cors(req)
  if (!h["access-control-allow-origin"]) return Response.json({ ok: false }, { status: 403, headers: h })
  let body = {}
  try { body = await req.json() } catch {}
  if (body.website) return Response.json({ ok: true }, { headers: h }) // piège à robots
  const start = new Date(String(body.start || ""))
  if (!validSlot(start)) return Response.json({ ok: false, error: "créneau invalide" }, { status: 400, headers: h })
  const end = new Date(+start + DUR_MIN * 60000)
  try {
    const ic = await icloud()
    if (!ic) throw new Error("identifiants iCloud manquants")
    if (overlaps(await allBusy(ic), +start, +end)) return Response.json({ ok: false, error: "créneau déjà pris" }, { status: 409, headers: h })
    const uid = `site-${z(start)}@l0ic02.github.io`
    const desc = "Réservé depuis le site (l0ic02.github.io). La personne doit t'écrire sur WhatsApp pour confirmer. Sans message, tu peux supprimer ce RDV."
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Loic Thizy//Site RDV//FR", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
      "SUMMARY:Bilan offert (site) – à confirmer", `DESCRIPTION:${desc.replace(/[,;]/g, (m) => "\\" + m)}`,
      "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", "DESCRIPTION:Bilan dans 1 h", "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n")
    // même nom de fichier pour un même créneau : iCloud refuse un doublon
    const r = await ic.client.createCalendarObject({ calendar: ic.cal, filename: `site-${z(start)}.ics`, iCalString: ics })
    if (r.status === 412) return Response.json({ ok: false, error: "créneau déjà pris" }, { status: 409, headers: h })
    if (!r.ok) throw new Error("iCloud " + r.status)
    return Response.json({ ok: true, when: fmtParis(start) }, { headers: h })
  } catch (e) {
    console.error(e)
    return Response.json({ ok: false, error: "agenda indisponible" }, { status: 502, headers: h })
  }
}
