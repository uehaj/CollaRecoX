import { NextResponse } from 'next/server';

const audioProcessorCode = `
// AudioWorklet processor for real-time audio processing
class RealtimeAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    
    // Listen for messages from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'start') {
        this.isRecording = true;
      } else if (event.data.type === 'stop') {
        this.isRecording = false;
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (!this.isRecording || inputs.length === 0 || inputs[0].length === 0) {
      return true;
    }

    const input = inputs[0];
    const inputChannel = input[0]; // First channel

    if (inputChannel && inputChannel.length > 0) {
      // Convert Float32Array to Int16Array (16-bit PCM)
      const pcm16 = new Int16Array(inputChannel.length);
      for (let i = 0; i < inputChannel.length; i++) {
        const s = Math.max(-1, Math.min(1, inputChannel[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }

      // Send raw PCM16 data to main thread (btoa not available in AudioWorklet)
      // Main thread will handle base64 encoding
      this.port.postMessage({
        type: 'audioData',
        pcm16Array: Array.from(pcm16)
      });
    }

    return true; // Keep the processor alive
  }
}

registerProcessor('realtime-audio-processor', RealtimeAudioProcessor);
`;

export async function GET() {
  return new NextResponse(audioProcessorCode, {
    headers: {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}