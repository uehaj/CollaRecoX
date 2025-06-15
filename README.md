# AI-Powered Audio Transcription

A real-time audio transcription application built with Next.js 14 and OpenAI's latest GPT-4o transcribe models. Stream audio directly from your browser and get instant, accurate transcriptions with server-side API key management for security.

## Features

- **Real-time Streaming**: Audio is processed as you speak using browser MediaRecorder API
- **Multiple Models**: Choose between GPT-4o Mini (faster/cheaper) and GPT-4o (higher accuracy)
- **Browser-based**: No downloads required, works in any modern web browser
- **Secure**: API keys are handled server-side for maximum security
- **Cost-effective**: GPT-4o Mini is 50% cheaper than traditional Whisper models
- **Responsive UI**: Clean, mobile-friendly interface built with Tailwind CSS

## Model Comparison

| Model | Cost/minute | Features |
|-------|-------------|----------|
| GPT-4o Mini Transcribe | ~$0.003 | Fast, cost-effective, good for high-volume |
| GPT-4o Transcribe | ~$0.006 | Higher accuracy, better multilingual support |

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
   
   # Install OpenAI SDK
   npm install openai
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

4. **Open your browser:**
   Navigate to [http://localhost:3000](http://localhost:3000)

## Usage

1. **Select Model**: Choose between GPT-4o Mini (faster/cheaper) or GPT-4o (higher accuracy)
2. **Start Recording**: Click "Start Recording" and allow microphone access
3. **Speak**: Talk clearly into your microphone
4. **Real-time Results**: Watch transcription appear in real-time
5. **Stop Recording**: Click "Stop Recording" when finished

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