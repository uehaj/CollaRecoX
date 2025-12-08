import { NextRequest, NextResponse } from 'next/server';
import OpenAI from 'openai';
import { HttpsProxyAgent } from 'https-proxy-agent';

// プロキシ設定を取得
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const httpAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  httpAgent: httpAgent,
});

// AI再編エージェントのAPIエンドポイント
// テキストを受け取り、誤字修正、句読点整理、専門用語補完を行う
export async function POST(request: NextRequest) {
  try {
    const { text, prompt } = await request.json();

    if (!text || typeof text !== 'string') {
      return NextResponse.json(
        { error: 'Text is required' },
        { status: 400 }
      );
    }

    // デフォルトのプロンプト（カスタムプロンプトが指定されていない場合）
    const systemPrompt = `あなたは日本語文章の校正アシスタントです。以下の文章を校正してください。

校正のルール:
1. 誤字脱字を修正
2. 句読点を適切に整理
3. 明らかに誤った専門用語があれば補完・修正
4. 文の意味や内容は変更しない
5. 原文の文体やトーンを維持

${prompt ? `追加の指示: ${prompt}` : ''}

修正した文章のみを出力してください。説明は不要です。`;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: systemPrompt,
        },
        {
          role: 'user',
          content: text,
        },
      ],
      temperature: 0.3, // 低めに設定して一貫性を保つ
      max_tokens: 4096,
    });

    const rewrittenText = response.choices[0]?.message?.content || text;

    return NextResponse.json({
      original: text,
      rewritten: rewrittenText,
      success: true,
    });
  } catch (error) {
    console.error('[Rewrite API] Error:', error);
    return NextResponse.json(
      { error: 'Failed to rewrite text', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
