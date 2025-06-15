import { NextRequest } from "next/server";
import OpenAI from "openai";

export const runtime = "nodejs"; // Edge runtime doesn't support Node.js streams

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export async function POST(req: NextRequest) {
  try {
    // Get the model parameter from query string or use mini as default
    const { searchParams } = new URL(req.url);
    const model = searchParams.get("model") || "gpt-4o-mini-transcribe";
    
    // Validate model
    const validModels = ["gpt-4o-mini-transcribe", "gpt-4o-transcribe"];
    if (!validModels.includes(model)) {
      return new Response(
        JSON.stringify({ error: "Invalid model. Use gpt-4o-mini-transcribe or gpt-4o-transcribe" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Parse FormData to get the audio file
    const formData = await req.formData();
    const audioFile = formData.get('audio') as File;
    
    if (!audioFile) {
      return new Response(
        JSON.stringify({ error: "No audio file provided" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // Call OpenAI transcription API with streaming
    const transcriptionStream = await openai.audio.transcriptions.create({
      file: audioFile,
      model: model as "gpt-4o-mini-transcribe" | "gpt-4o-transcribe",
      stream: true,
      response_format: "json",
    });

    // Create a readable stream to send chunks back to the client
    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of transcriptionStream as AsyncIterable<{ text: string }>) {
            const data = JSON.stringify(chunk) + "\n";
            controller.enqueue(encoder.encode(data));
          }
          controller.close();
        } catch (error) {
          console.error("Transcription error:", error);
          const errorData = JSON.stringify({ 
            error: error instanceof Error ? error.message : "Unknown error" 
          }) + "\n";
          controller.enqueue(encoder.encode(errorData));
          controller.close();
        }
      },
    });

    return new Response(readable, {
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });

  } catch (error) {
    console.error("API route error:", error);
    return new Response(
      JSON.stringify({ 
        error: error instanceof Error ? error.message : "Internal server error" 
      }),
      { 
        status: 500, 
        headers: { "Content-Type": "application/json" } 
      }
    );
  }
}