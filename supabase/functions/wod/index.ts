// One function: read a board photo, save results, list them.
// Auth is a shared token (APP_TOKEN) the phone sends in x-app-token; the table has RLS on
// and no policies, so only this function (service role) can touch it.
// ponytail: shared token, no user accounts. Add Supabase Auth if anyone but Paul uses it.

const MODELS = [
  "nvidia/nemotron-3.5-super-vl:free", // read the test board perfectly; gemma failed on it
  "google/gemma-4-31b-it:free",
  "google/gemma-4-26b-a4b-it:free",
];

const PROMPT = `This is a photo of a CrossFit gym whiteboard. Read the workout of the day.
Return ONLY JSON, no prose, in this shape:
{"parts":[{"title":"...","kind":"strength|for_time|amrap|emom|other","prescription":"..."}]}
Rules:
- One part per scored piece (A, B, C...). Skip warm-ups and mobility unless nothing else is on the board.
- strength: title is the lift only, e.g. "Back Squat". prescription keeps the scheme, e.g. "5-5-3-3-1 @ 70-90%".
- metcons: title is a short name, e.g. "21-15-9 Thrusters / Pull-ups" (or the benchmark name if written, e.g. "Fran").
  prescription is the full workout as written, one movement per line, with RX and scaled weights and any time cap.
- Copy numbers exactly. If a word is unreadable, write [?].`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-token",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

const DB = `${Deno.env.get("SUPABASE_URL")}/rest/v1/results`;
const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const db = (path: string, init: RequestInit = {}) =>
  fetch(DB + path, {
    ...init,
    headers: { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json", prefer: "return=representation" },
  });

async function parse(image: string) {
  let last = "";
  for (const model of MODELS) {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: image } }] }],
      }),
    });
    const body = await r.json().catch(() => ({}));
    const text: string = body?.choices?.[0]?.message?.content ?? "";
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    try {
      const out = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(out.parts) && out.parts.length) return { model, parts: out.parts };
    } catch { /* try the next model */ }
    last = `${model}: ${body?.error?.message ?? "unreadable reply"}`;
  }
  throw new Error(last);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.headers.get("x-app-token") !== Deno.env.get("APP_TOKEN")) return json({ error: "bad token" }, 401);

  const action = new URL(req.url).pathname.split("/").pop();
  try {
    if (req.method === "POST" && action === "parse") {
      const { image } = await req.json();
      if (typeof image !== "string" || !image.startsWith("data:image/")) return json({ error: "image must be a data URL" }, 400);
      return json(await parse(image));
    }
    if (req.method === "POST" && action === "save") {
      const { results } = await req.json();
      const r = await db("", { method: "POST", body: JSON.stringify(results) });
      return json(await r.json(), r.status);
    }
    if (req.method === "GET" && action === "list") {
      const r = await db("?select=*&order=day.desc,created_at.desc&limit=1000");
      return json(await r.json(), r.status);
    }
    if (req.method === "DELETE" && action === "delete") {
      const id = new URL(req.url).searchParams.get("id") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
      const r = await db(`?id=eq.${id}`, { method: "DELETE" });
      return json(await r.json(), r.status);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
});
