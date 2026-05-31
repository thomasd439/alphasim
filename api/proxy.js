export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  let endpoint = req.query.endpoint;
  const provider = req.query.provider;
  if (Array.isArray(endpoint)) endpoint = endpoint[0];
  if (!endpoint) return res.status(400).json({ error: "No endpoint provided" });

  // Vercel already URL-decodes req.query once. Only decode again if the value
  // still looks percent-encoded — this avoids the double-decode that can
  // corrupt the apiKey, while still working if the value arrives raw.
  if (endpoint.indexOf("%2F") !== -1 || endpoint.indexOf("%3F") !== -1 || endpoint.indexOf("%3D") !== -1) {
    try { endpoint = decodeURIComponent(endpoint); } catch (e) { /* leave as-is */ }
  }

  const bases = { polygon: "https://api.polygon.io", finnhub: "https://finnhub.io" };
  const base = bases[provider] || bases.polygon;
  const url = base + endpoint;

  // Diagnostic: if no credential made it into the request, say so clearly
  // instead of letting the upstream return a confusing 401.
  if (/[?&](apiKey|token)=(?:&|$)/.test(url)) {
    return res.status(400).json({
      error: "Proxy received an empty apiKey/token. The app did not include a key — check the key is saved in the correct field."
    });
  }

  try {
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
