// Vercel serverless function: sends the admin a phone push (via ntfy) when a student sends a chat question.
// The ntfy topic lives ONLY in the Vercel environment variable NTFY_TOPIC, so it is never visible in the page source.
// Fake alerts are blocked: the caller must be signed in, and the thread must be theirs and have a fresh student message.
const PROJECT_ID = 'genius-tutor-4a7b2';
const seen = new Map();   // tid|lastAt -> true, so one student message sends one alert

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false }); return; }
  const topic = process.env.NTFY_TOPIC;
  if (!topic) { res.status(500).json({ ok: false, error: 'not configured' }); return; }

  const auth = String(req.headers.authorization || '');
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const body = typeof req.body === 'string' ? safeParse(req.body) : (req.body || {});
  const tid = String(body.tid || '');
  if (!token || !/^[A-Za-z0-9_]{3,200}$/.test(tid)) { res.status(400).json({ ok: false }); return; }

  try {
    // Read the thread AS the student: Firestore rules decide whether they may see it.
    const url = 'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/threads/' + tid;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (!r.ok) { res.status(403).json({ ok: false }); return; }
    const f = (await r.json()).fields || {};
    const str = k => (f[k] && f[k].stringValue) || '';
    const lastAt = f.lastAt && f.lastAt.timestampValue ? Date.parse(f.lastAt.timestampValue) : 0;
    if (str('lastRole') !== 'student' || !lastAt || Date.now() - lastAt > 120000) { res.status(200).json({ ok: true, skipped: true }); return; }

    const key = tid + '|' + lastAt;
    if (seen.has(key)) { res.status(200).json({ ok: true, duplicate: true }); return; }
    seen.set(key, true);
    if (seen.size > 500) seen.delete(seen.keys().next().value);

    const subject = str('subject');
    const msg = ((subject ? subject + ': ' : '') + str('lastMessage')).slice(0, 140);
    await fetch('https://ntfy.sh/', {
      method: 'POST',
      body: JSON.stringify({
        topic, title: '💬 New student question', message: msg, priority: 4, tags: ['speech_balloon'],
        click: 'https://' + (req.headers.host || '')
      })
    });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
};

function safeParse(t) { try { return JSON.parse(t); } catch (_) { return {}; } }
