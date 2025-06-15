export type TranscriptionModel = "gpt-4o-mini-transcribe" | "gpt-4o-transcribe";

export interface TranscriptionChunk {
  text: string;
}

export interface TranscriptionError {
  error: string;
}

export type TranscriptionResponse = TranscriptionChunk | TranscriptionError;

export interface MediaRecorderConfig {
  mimeType: string;
  audioBitsPerSecond: number;
}

export interface AudioConstraints {
  sampleRate: number;
  channelCount: number;
  echoCancellation: boolean;
  noiseSuppression: boolean;
}

export const DEFAULT_AUDIO_CONSTRAINTS: AudioConstraints = {
  sampleRate: 16000,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
};

export const SUPPORTED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
] as const;

export const MODEL_PRICING = {
  "gpt-4o-mini-transcribe": {
    pricePerMinute: 0.003,
    description: "Faster & Cheaper"
  },
  "gpt-4o-transcribe": {
    pricePerMinute: 0.006,
    description: "Higher Accuracy"
  }
} as const;