// GET /api/busy : créneaux occupés en direct (agenda iCloud + réservations du site).
import type { Config } from "@netlify/functions"
import { allBusy, cors } from "../lib/agenda.mts"

export default async (req: Request) => {
  const h = cors(req)
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h })
  try {
    const busy = await allBusy()
    const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z")
    return Response.json(busy.map(([s, e]) => [iso(s), iso(e)]), { headers: { ...h, "cache-control": "public, max-age=30" } })
  } catch (e) {
    console.error(e)
    return Response.json({ error: "agenda indisponible" }, { status: 502, headers: h })
  }
}

export const config: Config = { path: "/api/busy", method: ["GET", "OPTIONS"] }
