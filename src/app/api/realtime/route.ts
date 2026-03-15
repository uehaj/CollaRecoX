import { NextRequest } from "next/server";
import { buildWsUrlFromHost } from "@/lib/wsUrl";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const model = searchParams.get("model") || "gpt-4o-realtime-preview";

  // Validate model
  const validModels = ["gpt-4o-realtime-preview", "gpt-4o-mini-realtime-preview"];
  if (!validModels.includes(model)) {
    return new Response(
      JSON.stringify({ error: "Invalid model. Use gpt-4o-realtime-preview or gpt-4o-mini-realtime-preview" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const host = req.headers.get('host') || 'localhost:8888';
  return new Response(
    JSON.stringify({
      message: "WebSocket endpoint is handled by custom server at /api/realtime-ws",
      model: model,
      websocket_url: buildWsUrlFromHost(host, '/api/realtime-ws', { model })
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}