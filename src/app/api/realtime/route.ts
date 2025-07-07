import { NextRequest } from "next/server";

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

  return new Response(
    JSON.stringify({ 
      message: "WebSocket endpoint is handled by custom server at /api/realtime-ws",
      model: model,
      websocket_url: `ws://localhost:5001/api/realtime-ws?model=${model}`
    }), 
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}