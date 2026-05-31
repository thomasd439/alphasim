export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
 
  const { endpoint, provider } = req.query;
  if (!endpoint) return res.status(400).json({ error: "No endpoint provided" });
 
  // Route by provider. Defaults to Polygon so existing calls keep working.
  const bases = {
    polygon: "https://api.polygon.io",
    finnhub: "https://finnhub.io"
  };
  const base = bases[provider] || bases.polygon;
  const url = base + decodeURIComponent(endpoint);
 
  try {
    const response = await fetch(url, { headers: { "Accept": "application/json" } });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    // Forward the upstream status so the app can detect 401/403 (auth/plan)
    // instead of every response looking like a success.
    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
 
