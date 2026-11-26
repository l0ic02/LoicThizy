// POST /api/mirror : recopie l'agenda Google « RDV Coach » dans iCloud (voir lib/mirror.mjs).
// Appelé par GitHub Actions toutes les 15 min. Authentification sans nouveau secret :
//   en-têtes x-mirror-ts (secondes) et x-mirror-sig = HMAC-SHA256(GOOGLE_ICS_URL, "mirror:" + ts), ±5 min.
// Corps optionnel : { sent: [hachages], state: {...} } (mémoires, HMAC uniquement). Réponse : compteurs + mémoires (HMAC).
import { icloud } from "../lib/agenda.mjs"
import { IMPORT_ACTIF, WINDOW_AFTER, WINDOW_BEFORE, eventsFromICS, importToSheet, makeWebhook, mirrorToIcloud, postToSheet, verify } from "../lib/mirror.mjs"

const key = () => (process.env.GOOGLE_ICS_URL || "").trim()

export function POST(req) { return handle(req) }

// deps : injection pour les tests uniquement
export async function handle(req, deps = {}) {
  const k = key()
  if (!k || !verify(k, req.headers.get("x-mirror-ts"), req.headers.get("x-mirror-sig"))) {
    return Response.json({ ok: false }, { status: 401 })
  }
  let body = {}
  try { body = await req.json() } catch {}
  const sent = Array.isArray(body.sent) ? body.sent.filter((h) => /^[0-9a-f]{32}$/.test(h)).slice(0, 5000) : []
  try {
    const ic = deps.ic !== undefined ? deps.ic : await icloud()
    if (!ic) return Response.json({ ok: false, error: "icloud" }, { status: 503 })
    const fetchIcs = deps.fetchIcs || (async (u) => {
      const r = await fetch(u.replace(/^webcal:\/\//, "https://"), { headers: { "cache-control": "no-cache" } })
      if (!r.ok) throw new Error("ics " + r.status)
      return r.text()
    })
    const icsText = await fetchIcs(k)
    const now = deps.now || Date.now()
    const webhook = deps.webhook !== undefined ? deps.webhook : (process.env.MIRROR_ANNULATION === "0" ? null : makeWebhook(k))
    const a = await mirrorToIcloud({ icsText, client: ic.client, cal: ic.cal, now, state: body.state, hmacKey: k, webhook })
    // starts RDV Coach (après A) pour l'anti-boucle de B
    const wantedStarts = eventsFromICS(icsText, new Date(now - WINDOW_BEFORE), new Date(now + WINDOW_AFTER)).map((e) => e.start)
    const b = await importToSheet({
      foreign: a.foreign, wantedStarts, sent, hmacKey: k, now,
      post: deps.post || postToSheet, actif: deps.importActif !== undefined ? deps.importActif : IMPORT_ACTIF,
    })
    return Response.json({ ok: true, miroir: a.stats, import: { actif: deps.importActif ?? IMPORT_ACTIF, ...b.stats }, sent_new: b.nouveaux, state: a.state })
  } catch (e) {
    console.error("mirror", e && e.name, (e && e.message || "").replace(/https?:\/\/\S+/g, "[url]").slice(0, 120))
    return Response.json({ ok: false, error: "miroir indisponible" }, { status: 502 })
  }
}
