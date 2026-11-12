const hits = new Map();
const okTokens = new Map();

async function verifyUser(idToken) {
  const cached = okTokens.get(idToken);
  if (cached && cached.exp > Date.now()) return cached.uid;
  const r = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" +
      process.env.FIREBASE_API_KEY,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );
  if (!r.ok) return null;
  const d = await r.json();
  const uid = d.users && d.users[0] ? d.users[0].localId : null;
  if (uid) {
    if (okTokens.size > 500) okTokens.clear();
    okTokens.set(idToken, { uid, exp: Date.now() + 5 * 60 * 1000 });
  }
  return uid;
}

const SYSTEM =
  "You are a friendly tutor helping Nigerian secondary school students prepare for JAMB UTME and WAEC. Explain in simple English, step by step, in under 150 words. Stay on the question and answer follow-up questions directly, like a chat. For maths, solve step by step like a textbook, one step per line, and write every formula or calculation in LaTeX between single dollar signs, for example $\\frac{F_1}{A_1} = \\frac{F_2}{A_2}$ and $10\\text{ N} \\times 100 = 1000\\text{ N}$. Always write fractions with \\frac{top}{bottom}, never with a slash. Use only these: \\frac, \\sqrt, ^, _, \\times, \\div, \\pm, \\approx, \\le, \\ge, \\pi, \\theta, \\Delta, \\text{}, \\rightarrow, \\%. Put units inside \\text{}. You may use **bold** for key words. If the stated correct answer looks wrong, say so briefly.";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { idToken, subject, passage, question, options, correct, chosen, explanation, followup, history } =
    req.body || {};

  const uid = idToken ? await verifyUser(idToken) : null;
  if (!uid) return res.status(401).json({ error: "Please sign in again." });

  const now = Date.now();
  const recent = (hits.get(uid) || []).filter((t) => now - t < 3600000);
  if (recent.length >= 40)
    return res.status(429).json({ error: "Limit reached. Try again in a while." });
  recent.push(now);
  hits.set(uid, recent);

  const q = String(question || "").slice(0, 1500);
  const opts = (Array.isArray(options) ? options : []).slice(0, 6).map((o) => String(o).slice(0, 300));
  const ask = String(followup || "").slice(0, 500);

  const hist = (Array.isArray(history) ? history : [])
    .slice(-12)
    .map((m) => ({
      role: m && m.role === "model" ? "model" : "user",
      text: String((m && m.text) || "").slice(0, 1500),
    }))
    .filter((m) => m.text);

  const context =
    `Subject: ${subject || "General"}\n` +
    (passage ? `Passage: ${String(passage).slice(0, 2500)}\n` : "") +
    `Question: ${q}\n` +
    `Options: ${opts.join(" | ")}\n` +
    `Correct answer: ${correct}\n` +
    `Student chose: ${chosen || "nothing"}\n` +
    `Existing explanation: ${String(explanation || "").slice(0, 800)}\n`;

  const contents = [];
  if (hist.length === 0) {
    contents.push({
      role: "user",
      parts: [{
        text: context + (ask
          ? `Student asks: ${ask}`
          : "Explain why the correct answer is right and why the student's choice is wrong."),
      }],
    });
  } else {
    contents.push({
      role: "user",
      parts: [{ text: context + "Explain why the correct answer is right and why the student's choice is wrong." }],
    });
    let last = "user";
    for (const m of hist) {
      if (m.role === last) continue;
      contents.push({ role: m.role, parts: [{ text: m.text }] });
      last = m.role;
    }
    if (last === "user" && contents.length > 1) contents.pop();
    contents.push({ role: "user", parts: [{ text: ask || "Please explain more." }] });
  }

  const models = [
    process.env.GEMINI_MODEL || "gemini-flash-lite-latest",
    "gemini-3.8-flash",
    "gemini-flash-latest",
  ].filter((m, i, a) => a.indexOf(m) === i);

  function callGemini(model, quickThinking) {
    const generationConfig = { maxOutputTokens: 1200, temperature: 0.3 };
    if (quickThinking) generationConfig.thinkingConfig = { thinkingLevel: "minimal" };
    return fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":streamGenerateContent?alt=sse",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          contents,
          generationConfig,
        }),
      }
    );
  }

  let lastStatus = 0;
  let lastMsg = "";
  for (const model of models) {
    try {
      let r = await callGemini(model, true);
      if (r.status === 400) r = await callGemini(model, false);
      if (!r.ok) {
        lastStatus = r.status;
        try { lastMsg = (await r.json()).error?.message || ""; } catch (_) {}
        console.error("Gemini error", model, lastStatus, lastMsg);
        if ([404, 429, 500, 503].includes(r.status)) continue;
        break;
      }

      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let sent = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const j = line.slice(5).trim();
          if (!j || j === "[DONE]") continue;
          try {
            const d = JSON.parse(j);
            const t = (d.candidates?.[0]?.content?.parts || [])
              .map((p) => (p.thought ? "" : p.text || ""))
              .join("");
            if (t) {
              if (!sent) {
                res.status(200);
                res.setHeader("Content-Type", "text/plain; charset=utf-8");
                res.setHeader("Cache-Control", "no-cache, no-transform");
                res.setHeader("X-Accel-Buffering", "no");
                sent = true;
              }
              res.write(t);
            }
          } catch (_) {}
        }
      }
      if (sent) return res.end();
      lastStatus = 204;
    } catch (e) {
      lastStatus = 500;
    }
  }

  if (lastStatus === 429 || lastStatus === 503 || lastStatus === 500 || lastStatus === 204)
    return res.status(503).json({ error: "AI is busy right now. Please try again in a minute." });
  return res.status(502).json({ error: "AI error " + lastStatus + ": " + lastMsg.slice(0, 160) });
    }
