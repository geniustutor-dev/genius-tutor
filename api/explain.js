const hits = new Map();

async function verifyUser(idToken) {
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
  return d.users && d.users[0] ? d.users[0].localId : null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const { idToken, subject, passage, question, options, correct, chosen, explanation, followup } =
    req.body || {};

  const uid = idToken ? await verifyUser(idToken) : null;
  if (!uid) return res.status(401).json({ error: "Please sign in again." });

  const now = Date.now();
  const recent = (hits.get(uid) || []).filter((t) => now - t < 3600000);
  if (recent.length >= 15)
    return res.status(429).json({ error: "Limit reached. Try again in a while." });
  recent.push(now);
  hits.set(uid, recent);

  const q = String(question || "").slice(0, 1500);
  const opts = (Array.isArray(options) ? options : []).slice(0, 6).map((o) => String(o).slice(0, 300));
  const ask = String(followup || "").slice(0, 500);

  const prompt =
    `Subject: ${subject || "General"}\n` +
    (passage ? `Passage: ${String(passage).slice(0, 2500)}\n` : "") +
    `Question: ${q}\n` +
    `Options: ${opts.join(" | ")}\n` +
    `Correct answer: ${correct}\n` +
    `Student chose: ${chosen || "nothing"}\n` +
    `Existing explanation: ${String(explanation || "").slice(0, 800)}\n` +
    (ask ? `Student asks: ${ask}` : "Explain why the correct answer is right and why the student's choice is wrong.");

  const models = [
    process.env.GEMINI_MODEL || "gemini-3.8-flash",
    "gemini-flash-lite-latest",
    "gemini-flash-latest",
  ].filter((m, i, a) => a.indexOf(m) === i);

  const body = JSON.stringify({
    systemInstruction: {
      parts: [
        {
          text:
            "You are a friendly tutor helping Nigerian secondary school students prepare for JAMB UTME and WAEC. Explain in simple English, step by step, in under 150 words. Stay on the question. If the stated correct answer looks wrong, say so briefly.",
        },
      ],
    },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 2000, temperature: 0.3 },
  });

  let lastStatus = 0;
  let lastMsg = "";
  for (const model of models) {
    try {
      const r = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body,
        }
      );
      if (r.ok) {
        const d = await r.json();
        const answer = d.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (answer) return res.status(200).json({ answer });
        lastStatus = 204;
        continue;
      }
      lastStatus = r.status;
      try { lastMsg = (await r.json()).error?.message || ""; } catch (_) {}
      console.error("Gemini error", model, lastStatus, lastMsg);
      if ([404, 429, 500, 503].includes(r.status)) continue;
      break;
    } catch (e) {
      lastStatus = 500;
    }
  }

  if (lastStatus === 429 || lastStatus === 503 || lastStatus === 500 || lastStatus === 204)
    return res.status(503).json({ error: "AI is busy right now. Please try again in a minute." });
  return res.status(502).json({ error: "AI error " + lastStatus + ": " + lastMsg.slice(0, 160) });
}
