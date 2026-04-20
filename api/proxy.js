export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
 
  const { endpoint } = req.query;
  if (!endpoint) return res.status(400).json({ error: "No endpoint provided" });
 
  const url = "https://api.polygon.io" + decodeURIComponent(endpoint);
 
  try {
    const response = await fetch(url, {
      headers: { "Accept": "application/json" }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
