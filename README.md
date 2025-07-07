# AI-Powered Audio Transcription

A comprehensive audio transcription application built with Next.js 14 and OpenAI's latest models. Supports both batch processing and real-time streaming transcription with server-side API key management for security.

## Features

- **Dual Modes**: Choose between batch processing or real-time streaming
- **Multiple Models**: Support for both transcribe and realtime API models
- **Browser-based**: No downloads required, works in any modern web browser
- **Secure**: API keys are handled server-side for maximum security
- **WebSocket Streaming**: True real-time audio streaming with instant transcription
- **Responsive UI**: Clean, mobile-friendly interface built with Tailwind CSS

## Model Comparison

| Model | Cost/minute | Type | Features |
|-------|-------------|------|----------|
| GPT-4o Mini Transcribe | ~$0.003 | Batch | Fast, cost-effective, good for high-volume |
| GPT-4o Transcribe | ~$0.006 | Batch | Higher accuracy, better multilingual support |
| GPT-4o Mini Realtime | ~$0.06 input / $0.24 output | Streaming | Real-time processing, instant results |
| GPT-4o Realtime | ~$0.06 input / $0.24 output | Streaming | Premium real-time with highest accuracy |

## Prerequisites

- Node.js 18 or later
- OpenAI API key with access to GPT-4o transcribe models
- Modern web browser with MediaRecorder support

## Installation

1. **Clone or create the project:**
   ```bash
   # If using this as a template
   npx create-next-app@latest my-transcription-app --typescript --tailwind --eslint --app --use-npm --src-dir
   cd my-transcription-app
   
   # Install dependencies
   npm install openai ws @types/ws
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` and add your OpenAI API key:
   ```env
   OPENAI_API_KEY=your_openai_api_key_here
   ```

3. **Run the development server:**
   ```bash
   npm run dev
   ```
   
   Note: This uses a custom server with WebSocket support for real-time functionality.

4. **Open your browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

## Usage

The application offers two transcription modes:

### Batch Processing Mode (`/recorder`)
- Record audio and process when recording stops
- More cost-effective for longer recordings
- Uses standard file upload

1. **Select Model**: Choose between GPT-4o Mini (~$0.003/min) or GPT-4o (~$0.006/min)
2. **Start Recording**: Click "Start Recording" and allow microphone access
3. **Speak**: Talk clearly into your microphone
4. **Stop Recording**: Click "Stop Recording" when finished
5. **Processing**: Wait for transcription to complete

### Real-time Streaming Mode (`/realtime`)
- True streaming transcription as you speak
- Higher cost but instant results
- Uses WebSocket connection

1. **Connect**: Establish WebSocket connection to Realtime API
2. **Select Model**: Choose between realtime models (~$0.06-0.24/min)
3. **Start Streaming**: Begin real-time audio streaming
4. **Speak**: See transcription appear instantly as you talk
5. **Stop Streaming**: End the real-time session

## API Endpoints

### POST `/api/transcribe`

Streams audio to OpenAI's transcription API and returns real-time results.

**Query Parameters:**
- `model` (optional): `gpt-4o-mini-transcribe` or `gpt-4o-transcribe` (default: mini)

**Request Body:**
- Raw audio stream (application/octet-stream)

**Response:**
- Streaming JSON chunks, one per line
- Each chunk: `{"text": "transcribed text"}`

## Architecture

```
Browser (MediaRecorder) 
    ↓ [WebM/Opus Stream]
Next.js API Route (/api/transcribe)
    ↓ [PassThrough Stream]
OpenAI GPT-4o Transcribe API
    ↓ [Streaming JSON Response]
Browser (Real-time Display)
```

### Key Components

- **Frontend** (`src/app/recorder/page.tsx`): React component with MediaRecorder integration
- **API Route** (`src/app/api/transcribe/route.ts`): Node.js stream proxy to OpenAI
- **Types** (`src/types/transcription.ts`): TypeScript definitions

## Browser Compatibility

| Browser | MediaRecorder | WebM Support | Status |
|---------|---------------|--------------|--------|
| Chrome 49+ | ✅ | ✅ | Full support |
| Firefox 29+ | ✅ | ✅ | Full support |
| Safari 14.1+ | ✅ | ⚠️ | Limited format support |
| Edge 79+ | ✅ | ✅ | Full support |

## Cost Optimization Tips

1. **Use Mini Model**: Start with `gpt-4o-mini-transcribe` for most use cases
2. **Audio Quality**: Lower sample rates (16kHz) reduce token usage
3. **Chunking**: 250ms intervals balance latency and efficiency
4. **Preprocessing**: Remove silence periods before streaming

## Deployment

### Vercel (Recommended)

1. **Connect your repository** to Vercel
2. **Set environment variables** in Vercel dashboard:
   - `OPENAI_API_KEY`
3. **Deploy** - Vercel will handle the rest

### Other Platforms

Ensure your deployment platform supports:
- Node.js runtime (not Edge runtime for streaming)
- Environment variables
- WebSocket/streaming responses

## Troubleshooting

### Common Issues

**"No supported audio format found"**
- Update your browser to the latest version
- Try a different browser (Chrome/Firefox recommended)

**"Network error" or CORS issues**
- Ensure API key is set in `.env.local`
- Check browser console for detailed error messages
- Verify OpenAI API key has transcription permissions

**"Recording not starting"**
- Grant microphone permissions when prompted
- Check if another application is using your microphone
- Try refreshing the page and allowing permissions again

**Poor transcription quality**
- Speak clearly and close to the microphone
- Reduce background noise
- Consider upgrading to GPT-4o model for better accuracy

### Debug Mode

Enable detailed logging by adding to your `.env.local`:
```env
NODE_ENV=development
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Acknowledgments

- Built with [Next.js](https://nextjs.org/)
- Powered by [OpenAI](https://openai.com/)
- Styled with [Tailwind CSS](https://tailwindcss.com/)

## Support

For issues and questions:
1. Check the troubleshooting section above
2. Review browser console errors
3. Verify OpenAI API key and permissions
4. Open an issue with detailed error information