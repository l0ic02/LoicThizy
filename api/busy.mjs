// GET /api/busy : créneaux occupés en direct (agenda iCloud).
import { allBusy, cors, icloud } from "../lib/agenda.mjs"

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z")

export function OPTIONS(req) { return new Response(null, { status: 204, headers: cors(req) }) }

export async function GET(req) {
  const h = cors(req)
  try {
    let ic = null
    try { ic = await icloud() } catch (e) { console.error(e) }
    const busy = await allBusy(ic)
    return Response.json(busy.map(([s, e]) => [iso(s), iso(e)]), { headers: { ...h, "cache-control": "public, s-maxage=20, max-age=0" } })
  } catch (e) {
    console.error(e)
    return Response.json({ error: "agenda indisponible" }, { status: 502, headers: h })
  }
}
