// One function: read a board photo, save results, list them.
// Auth is a shared token (APP_TOKEN) the phone sends in x-app-token; the table has RLS on
// and no policies, so only this function (service role) can touch it.
// ponytail: shared token, no user accounts. Add Supabase Auth if anyone but Paul uses it.

// 2026-11-19, reasoning off. Gemini 3.5 Flash-Lite (Google free tier, own key): 6/6 right on both boards at
// 1.6-2.8s. Gemini 3.1 Flash-Lite: 5/6, one Google 503. Simple board, 5 runs each on OpenRouter: nano 5/5 at
// 2s, super 5/5 at ~3s. Busy five-section board: super kept the E2M as one part and the cap on the right part;
// nano split the E2M and gave the finisher Part C's cap. Gemma 4 was 429 on every call, so it is out.
const MODELS = [
  "gemini/gemini-3.5-flash-lite",
  "gemini/gemini-3.1-flash-lite",
  "nvidia/nemotron-3.5-super-vl:free",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  "inclusionai/ling-3.2-flash:free",
];
const PER_MODEL_MS = 20_000; // a free model that hangs gets skipped, not waited on

const PROMPT = `This is a photo of a CrossFit gym whiteboard. Read the workout of the day.
Return ONLY JSON, no prose, in this shape:
{"parts":[{"title":"...","kind":"strength|for_time|amrap|emom|other","prescription":"..."}]}
Rules:
- Boards often hold several workouts: Part A / B / C, strength plus a metcon, an EMOM, a partner WOD, a finisher,
  sometimes in columns. Return EVERY section as its own part, in board order, warm-up first if there is one
  (title "Warm-up", kind "other"). Never merge two sections and never stop after the first.
- Titles describe the work, never just the label: not "Part A" but "Deadlift" or "Partner run / devil press / wall balls".
  Leave "A)", "Part B -" and similar labels out of titles.
- strength: title is the lift only, e.g. "Back Squat". prescription keeps the scheme, e.g. "5-5-3-3-1 @ 70-90%".
- metcons: title is a short name, e.g. "21-15-9 Thrusters / Pull-ups" (or the benchmark name if written, e.g. "Fran").
  E2M / EMOM / "every X min" is kind "emom"; partner notes (synchro, YGIG) stay in the prescription.
  prescription is the full workout as written, one movement per line, with RX and scaled weights and any time cap.
- Copy numbers exactly. If a word is unreadable, write [?].`;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-token",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
    if (model.startsWith("gemini/") && !Deno.env.get("GEMINI_API_KEY")) continue;
    let reply: { text: string; error?: string };
    try {
      reply = model.startsWith("gemini/") ? await askGemini(model.slice(7), image) : await askOpenRouter(model, image);
    } catch (e) {
      last = `${model}: ${e?.name === "TimeoutError" ? "timed out" : e}`;
      continue;
    }
    const parts = extractParts(reply.text);
    if (parts) return { model, parts };
    last = `${model}: ${reply.error ?? "unreadable reply"}`;
  }
  throw new Error(last);
}

async function askOpenRouter(model: string, image: string) {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(PER_MODEL_MS),
    headers: { authorization: `Bearer ${Deno.env.get("OPENROUTER_API_KEY")}`, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      reasoning: { enabled: false }, // thinking tripled the time (10s vs 3s) for the same answer
      messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: image } }] }],
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { text: body?.choices?.[0]?.message?.content ?? "", error: body?.error?.message };
}

// Google AI Studio free tier, called directly (not through OpenRouter). Gemini 3.x takes thinkingLevel;
// the old thinkingBudget: 0 is a 400 on 3.5.
async function askGemini(model: string, image: string) {
  const [, mime, data] = image.match(/^data:(image\/[\w+.-]+);base64,(.*)$/s) ?? [];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    signal: AbortSignal.timeout(PER_MODEL_MS),
    headers: { "x-goog-api-key": Deno.env.get("GEMINI_API_KEY")!, "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data } }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "minimal" } },
    }),
  });
  const body = await r.json().catch(() => ({}));
  return { text: body?.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "", error: body?.error?.message };
}

// Models sometimes add a stray "}" or prose after the JSON: shorten from the end until it parses.
function extractParts(text: string) {
  const start = text.indexOf("{");
  for (let end = text.lastIndexOf("}"); start >= 0 && end > start; end = text.lastIndexOf("}", end - 1)) {
    try {
      const parts = JSON.parse(text.slice(start, end + 1)).parts;
      if (Array.isArray(parts) && parts.length)
        return parts.map((p: any) => ({ ...p, title: String(p.title ?? "").replace(/^[A-Z][).]\s*/, "") }));
    } catch { /* shorter */ }
  }
  return null;
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
    if (req.method === "PATCH" && action === "update") {
      const id = new URL(req.url).searchParams.get("id") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
      const { day, title, kind, prescription, score, score_value, rx, notes } = await req.json();
      const r = await db(`?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ day, title, kind, prescription, score, score_value, rx, notes }) });
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
