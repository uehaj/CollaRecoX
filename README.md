# CollaRecoX

A real-time speech transcription and collaborative editing application powered by OpenAI GPT-4o.

## Features

- **Real-time Transcription**: Stream audio directly to OpenAI's GPT-4o Realtime API for instant speech-to-text
- **Collaborative Editing**: Google Docs-style real-time collaborative text editing using Yjs and Tiptap
- **AI-powered Rewriting**: Rewrite and improve transcribed text using GPT-4o with customizable prompts
- **Session Management**: Create and join transcription sessions with shareable URLs
- **Audio Recording Support**: Process pre-recorded audio files for transcription

## Tech Stack

- **Framework**: Next.js 15 (App Router)
- **Real-time Sync**: Yjs + Hocuspocus + Tiptap
- **AI**: OpenAI API (GPT-4o Realtime / Transcribe models)
- **State Management**: Jotai
- **Styling**: Tailwind CSS v4

## Prerequisites

- Node.js 18+
- OpenAI API key with GPT-4o Realtime API access

## Installation

```bash
# Clone the repository
git clone https://github.com/uehaj/CollaRecoX.git
cd CollaRecoX

# Install dependencies
npm install

# Configure environment variables
cp .env.example .env.local
# Edit .env.local and add your OpenAI API key
```

## Configuration

Create `.env.local` with:

```env
OPENAI_API_KEY=your_openai_api_key_here
```

## Usage

### Development

```bash
# Recommended: Use the development script (handles proxy and environment)
bin/dev.sh

# Or with options
bin/dev.sh -f      # Force kill existing process on port 8888
bin/dev.sh -l      # Enable log file output
bin/dev.sh -f -l   # Both options
```

### Production

```bash
npm run build
npm run start
```

### Access

- **Main Application**: http://localhost:8888/realtime
- **Collaborative Editor**: http://localhost:8888/editor/[sessionId]

## How It Works

1. **Start a Session**: Create or join a transcription session from the main page
2. **Begin Transcription**: Click "Start Recording" to stream audio to OpenAI
3. **Real-time Updates**: Transcribed text appears instantly in the collaborative editor
4. **Collaborate**: Share the session URL for others to view and edit in real-time
5. **AI Rewrite**: Select text and use AI-powered rewriting with custom prompts

## Architecture

```
┌───────────────────────────────┐
│  Browser (Transcription Page) │
│  ┌─────────────────────────┐  │
│  │  Microphone Input       │  │
│  │  Transcription Controls │  │
│  └─────────────────────────┘  │
└───────────────┬───────────────┘
                │ WebSocket (Audio)
                ▼
┌──────────────────────────────────────────┐       ┌───────────────────────┐
│  Next.js Server                          │       │  OpenAI API           │
│                                          │       │                       │
│  ┌────────────────┐   ┌────────────────┐ │       │  ┌─────────────────┐  │
│  │  WebSocket     │──▶│  Hocuspocus    │ │◀─────▶│  │ Realtime API    │  │
│  │  Proxy         │   │  (Yjs Server)  │ │       │  │(gpt-4o-transcribe) │
│  │                │◀──│       ▲        │ │       │  └─────────────────┘  │
│  └────────────────┘   └───────┼────────┘ │       │                       │
│                               │          │       │  ┌─────────────────┐  │
│  ┌────────────────┐           │          │◀─────▶│  │ gpt-4o-mini     │  │
│  │  AI Rewrite    │──────────▶│          │       │  │ (AI Rewrite)    │  │
│  └───────▲────────┘           │          │       │  └─────────────────┘  │
│          │         WebSocket  │          │       │                       │
│          │        (Yjs Sync)  │          │       │                       │
│          │                    │          │       │                       │
└──────────┼────────────────────┼──────────┘       └───────────────────────┘
           │ AI Rewrite         │
           │ Request            │
           │                    ▼ 
┌───────────────────────────────────────────────────┐
│  Browser (Proofreading Page) × N                  │
│  ┌─────────────────────────────────────────────┐  │
│  │  Collaborative Editor (Tiptap)              │  │
│  │  AI Rewrite Controls                        │  │
│  └─────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────┘
```

## Key Routes

| Path | Description |
|------|-------------|
| `/realtime` | Main transcription control panel |
| `/editor/[sessionId]` | Collaborative editing session |
| `/recorder` | Batch audio processing mode |

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Author

Junji Uehara ([@uehaj](https://github.com/uehaj))
