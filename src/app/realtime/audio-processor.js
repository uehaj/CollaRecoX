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

  process(inputs) {
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

      // Convert to base64
      const bytes = new Uint8Array(pcm16.buffer);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      const base64Audio = btoa(binary);

      // Send audio data to main thread
      this.port.postMessage({
        type: 'audioData',
        audio: base64Audio
      });
    }

    return true; // Keep the processor alive
  }
}

registerProcessor('realtime-audio-processor', RealtimeAudioProcessor);