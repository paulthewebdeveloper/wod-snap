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
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

// Every database call runs AS the signed-in user (their token + the anon key), so row-level security decides what
// they can read and write. The service key is used only for admin account work, after checking the caller is admin.
const BASE = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const rest = (path: string, token: string, init: RequestInit = {}) =>
  fetch(`${BASE}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: ANON, authorization: `Bearer ${token}`, "content-type": "application/json", prefer: "return=representation" },
  });
const authAdmin = (path: string, init: RequestInit = {}) =>
  fetch(`${BASE}/auth/v1/admin/${path}`, {
    ...init,
    headers: { apikey: SERVICE, authorization: `Bearer ${SERVICE}`, "content-type": "application/json" },
  });
const UUID = /^[0-9a-f-]{36}$/;
const relay = async (r: Response) => json(await r.json().catch(() => ({})), r.status);

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
  // Who is calling: a valid Supabase session, belonging to an active member.
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const who = token && await fetch(`${BASE}/auth/v1/user`, { headers: { apikey: ANON, authorization: `Bearer ${token}` } });
  if (!who || !who.ok) return json({ error: "sign in again" }, 401);
  const uid: string = (await who.json()).id;
  const [me] = await (await rest(`members?user_id=eq.${uid}&select=*`, token)).json().catch(() => []);
  if (!me?.active) return json({ error: "not on the team" }, 403);

  const url = new URL(req.url), action = url.pathname.split("/").pop(), id = url.searchParams.get("id") ?? "";
  try {
    if (req.method === "POST" && action === "parse") {
      const { image } = await req.json();
      if (typeof image !== "string" || !image.startsWith("data:image/")) return json({ error: "image must be a data URL" }, 400);
      return json(await parse(image));
    }
    if (req.method === "GET" && action === "me") return json(me);

    if (req.method === "POST" && action === "save") {
      const { results } = await req.json();
      // user_id is never taken from the client: the column defaults to the caller.
      const rows = (results ?? []).map(({ day, title, kind, prescription, score, score_value, rx, notes }: any) =>
        ({ day, title, kind, prescription, score, score_value, rx, notes }));
      return relay(await rest("results", token, { method: "POST", body: JSON.stringify(rows) }));
    }
    if (req.method === "GET" && action === "list") {
      const mine = url.searchParams.get("scope") !== "team";
      const r = await rest(`results?select=*${mine ? `&user_id=eq.${uid}` : ""}&order=day.desc,created_at.desc&limit=2000`, token);
      if (!r.ok || mine) return relay(r);
      // Team scope: label each row with its owner's name (members has no foreign key to results, so join here).
      const names = new Map((await (await rest("members?select=user_id,name", token)).json()).map((m: any) => [m.user_id, m.name]));
      return json((await r.json()).map((row: any) => ({ ...row, owner_name: names.get(row.user_id) ?? "" })));
    }
    if (req.method === "PATCH" && action === "update") {
      if (!UUID.test(id)) return json({ error: "bad id" }, 400);
      const { day, title, kind, prescription, score, score_value, rx, notes } = await req.json();
      return relay(await rest(`results?id=eq.${id}`, token, { method: "PATCH", body: JSON.stringify({ day, title, kind, prescription, score, score_value, rx, notes }) }));
    }
    if (req.method === "DELETE" && action === "delete") {
      if (!UUID.test(id)) return json({ error: "bad id" }, 400);
      return relay(await rest(`results?id=eq.${id}`, token, { method: "DELETE" }));
    }

    // Members. Admin and coach see everything; athletes see names only (for the team board).
    if (req.method === "GET" && action === "members") {
      const list = await (await rest("members?select=*&order=created_at", token)).json();
      return json(me.role === "athlete" ? list.filter((m: any) => m.active).map(({ user_id, name }: any) => ({ user_id, name })) : list);
    }
    if (req.method === "POST" && action === "members") {
      if (me.role !== "admin") return json({ error: "only the admin can add members" }, 403);
      const { email, name, role = "athlete" } = await req.json();
      if (!/^\S+@\S+\.\S+$/.test(email ?? "") || !["admin", "coach", "athlete"].includes(role)) return json({ error: "email and role needed" }, 400);
      const made = await authAdmin("users", { method: "POST", body: JSON.stringify({ email: email.toLowerCase(), email_confirm: true }) });
      const user = await made.json();
      if (!made.ok) return json({ error: user.msg ?? user.error_description ?? "could not create the account" }, made.status);
      return relay(await rest("members", token, { method: "POST", body: JSON.stringify({ user_id: user.id, email: user.email, name: name ?? "", role }) }));
    }
    if (req.method === "PATCH" && action === "members") {
      if (!UUID.test(id)) return json({ error: "bad id" }, 400);
      const body = await req.json(), keys = Object.keys(body);
      const selfEdit = id === uid && keys.every((k) => k === "name" || k === "private");
      if (!selfEdit && me.role !== "admin") return json({ error: "only the admin can change that" }, 403);
      const patch = Object.fromEntries(keys.filter((k) => ["name", "private", "role", "active"].includes(k)).map((k) => [k, body[k]]));
      const r = await rest(`members?user_id=eq.${id}`, token, { method: "PATCH", body: JSON.stringify(patch) });
      if (r.ok && "active" in patch) {
        // Removing someone also stops their sign-in; restoring lifts it. Their results are never deleted.
        await authAdmin(`users/${id}`, { method: "PUT", body: JSON.stringify({ ban_duration: patch.active ? "none" : "876000h" }) });
      }
      const rows = await r.json().catch(() => []);
      return json(Array.isArray(rows) ? rows[0] ?? {} : rows, r.ok ? 200 : r.status);
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 502);
  }
});
