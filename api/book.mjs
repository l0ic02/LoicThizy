// POST /api/book {start, prenom, nom, tel, page, format} : crée le RDV dans l'agenda iCloud de Loïc
// (le créneau devient aussitôt occupé sur le site), puis l'ajoute au Google Sheet de suivi.
import { allBusy, cors, DUR_MIN, fmtParis, icloud, overlaps, validSlot } from "../lib/agenda.mjs"

const z = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")
const clean = (s, n = 60) => String(s || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, n)
const icsText = (s) => s.replace(/[\\,;]/g, (m) => "\\" + m)
const telOk = (t) => { const d = t.replace(/\D/g, ""); return d.length >= 9 && d.length <= 13 }

// Date et heure du créneau à Paris : « 2026-11-28 », « 09:00 »
function parisDateHeure(d) {
  const o = {}
  for (const p of new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d)) o[p.type] = p.value
  return { date: `${o.year}-${o.month}-${o.day}`, heure: `${String(+o.hour % 24).padStart(2, "0")}:${o.minute}` }
}

// Envoi au Google Sheet (Apps Script). Un échec ici n'annule jamais le RDV.
async function toSheet(row) {
  const url = (process.env.SHEET_WEBHOOK_URL || "").trim()
  if (!url) return
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(row), redirect: "follow", signal: AbortSignal.timeout(10000) })
    const t = await r.text()
    if (!r.ok || !/"ok":\s*true/.test(t)) console.error("Sheet", r.status, t.slice(0, 300))
  } catch (e) {
    console.error("Sheet", e)
  }
}

export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }) }

export async function POST(req) {
  const h = cors(req)
  if (!h["access-control-allow-origin"]) return Response.json({ ok: false }, { status: 403, headers: h })
  let body = {}
  try { body = await req.json() } catch {}
  if (body.website) return Response.json({ ok: true }, { headers: h }) // piège à robots
  const start = new Date(String(body.start || ""))
  if (!validSlot(start)) return Response.json({ ok: false, error: "créneau invalide" }, { status: 400, headers: h })
  const prenom = clean(body.prenom), nom = clean(body.nom), tel = clean(body.tel, 30), format = clean(body.format, 20)
  const pro = body.page === "pro"
  if (!prenom || !telOk(tel)) return Response.json({ ok: false, error: "prénom et téléphone requis" }, { status: 400, headers: h })
  const end = new Date(+start + DUR_MIN * 60000)
  const qui = [prenom, nom].filter(Boolean).join(" ")
  try {
    const ic = await icloud()
    if (!ic) throw new Error("identifiants iCloud manquants")
    if (overlaps(await allBusy(ic), +start, +end)) return Response.json({ ok: false, error: "créneau déjà pris" }, { status: 409, headers: h })
    const uid = `site-${z(start)}@l0ic02.github.io`
    const summary = `${pro ? "RDV opportunité pro" : "Bilan offert"} (site) – ${qui} – à confirmer`
    const desc = `${qui} · ${tel}${format ? " · " + format : ""}\nRéservé depuis le site (l0ic02.github.io${pro ? "/pro" : ""}). La personne doit t'écrire sur WhatsApp pour confirmer. Sans message, tu peux supprimer ce RDV.`
    const ics = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Loic Thizy//Site RDV//FR", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT", `UID:${uid}`, `DTSTAMP:${z(new Date())}`, `DTSTART:${z(start)}`, `DTEND:${z(end)}`,
      `SUMMARY:${icsText(summary)}`, `DESCRIPTION:${icsText(desc).replace(/\n/g, "\\n")}`,
      "BEGIN:VALARM", "TRIGGER:-PT1H", "ACTION:DISPLAY", `DESCRIPTION:${pro ? "RDV pro" : "Bilan"} dans 1 h`, "END:VALARM",
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n")
    // même nom de fichier pour un même créneau : iCloud refuse un doublon
    const r = await ic.client.createCalendarObject({ calendar: ic.cal, filename: `site-${z(start)}.ics`, iCalString: ics })
    if (r.status === 412) return Response.json({ ok: false, error: "créneau déjà pris" }, { status: 409, headers: h })
    if (!r.ok) throw new Error("iCloud " + r.status)
    await toSheet({ page: pro ? "pro" : "client", prenom, nom, tel, format, ...parisDateHeure(start) })
    return Response.json({ ok: true, when: fmtParis(start) }, { headers: h })
  } catch (e) {
    console.error(e)
    return Response.json({ ok: false, error: "agenda indisponible" }, { status: 502, headers: h })
  }
}
