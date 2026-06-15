import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

// 配信権(hostToken)の発行エンドポイント。
//
// 配信者が新しいセッションを作るときに呼ぶ。サーバーが sessionId を新規生成し、
// hostToken = HMAC_SHA256(SERVER_SECRET, sessionId) を計算して両方を返す。
// この token を持つ者だけが配信(/api/realtime-ws)できる（サーバーが同じ計算で照合）。
//
// 重要: クライアントから sessionId を受け取らない。HMAC は決定的なので、もし任意の
// sessionId に対して token を返すと、校正リンクで sessionId を知った校正者が配信権を
// 入手できてしまう。そのため sessionId は必ずここで生成し、既存IDには token を発行しない。
const serverSecret = process.env.SERVER_SECRET || "";

export async function POST() {
  const sessionId = crypto.randomUUID();
  const hostToken = crypto
    .createHmac("sha256", serverSecret)
    .update(sessionId)
    .digest("hex");

  return NextResponse.json({ sessionId, hostToken });
}
