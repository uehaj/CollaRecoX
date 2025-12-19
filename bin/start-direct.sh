#!/bin/bash

# Direct server starter without any proxy interference
# Usage: ./start-direct.sh [port]

PORT=${1:-8888}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_DIR"

echo "Starting server directly on port $PORT without proxy..."
echo "📁 Project root: $PROJECT_DIR"

# Completely disable all proxy settings
unset HTTP_PROXY
unset HTTPS_PROXY
unset http_proxy
unset https_proxy
unset ALL_PROXY
unset all_proxy

# Set NO_PROXY to bypass proxy for localhost (consistent with start-daemon.sh)
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="localhost,127.0.0.1,::1"

# Clear any curl/wget proxy configs
export HTTP_PROXY_REQUEST_FULLURI=false
export HTTPS_PROXY_REQUEST_FULLURI=false

# Check if .env.local exists
if [ ! -f ".env.local" ]; then
    echo "❌ Error: .env.local not found"
    echo "Please create .env.local with required environment variables:"
    echo "  OPENAI_API_KEY=your_api_key_here"
    exit 1
fi

# Load environment variables from .env.local
echo "📋 Loading environment variables from .env.local..."
while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and comments
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    # Export the variable
    export "$line"
done < .env.local

# Check for required environment variables
if [ -z "$OPENAI_API_KEY" ]; then
    echo "❌ ERROR: OPENAI_API_KEY environment variable is required"
    exit 1
fi

echo "✅ Environment loaded"
echo "🌐 Server will start at: http://localhost:$PORT"
echo "🎤 Realtime API: ws://localhost:$PORT/api/realtime-ws"
echo "📡 Hocuspocus: ws://localhost:$PORT/api/yjs-ws"
echo ""

# Start server directly (foreground)
NODE_ENV=production PORT=$PORT node server.js
