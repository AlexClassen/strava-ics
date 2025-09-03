import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { code, scope, state, error } = req.query;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (error) {
    res.status(400).send(`<h2>OAuth Error</h2><pre>${error}</pre>`);
    return;
  }
  res.send(`
    <h2>Strava OAuth – Code Received</h2>
    <p>Copy this code and use it in the token exchange step:</p>
    <pre style="padding:12px;border:1px solid #ccc;border-radius:8px;display:inline-block;">
code=${code || "(none)"} 
scope=${scope || "(none)"} 
state=${state || "(none)"}
    </pre>
  `);
}
