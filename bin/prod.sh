#!/bin/bash

# Production server startup script for collarecox
# This script loads environment variables from .env.local and starts the production server

set -e

# Default values
ENABLE_LOG=false
LOG_DIR="logs"
FORCE_KILL=false

# Parse command line arguments
show_help() {
    cat << EOF
Usage: bin/prod.sh [OPTIONS]

Production server startup script for collarecox

OPTIONS:
    -f, --force             Kill existing process on port 8888 before starting
    -l, --log               Enable logging to file (default: disabled)
    -d, --log-dir <dir>     Specify log directory (default: logs)
    -h, --help              Show this help message

EXAMPLES:
    bin/prod.sh                      # Start server without logging
    bin/prod.sh -f                   # Force kill existing process and start
    bin/prod.sh -l                   # Start server with logging to ./logs
    bin/prod.sh -f -l                # Force kill and start with logging
    bin/prod.sh -l -d /path/to/logs  # Start server with custom log directory

EOF
    exit 0
}

while [[ $# -gt 0 ]]; do
    case $1 in
        -f|--force)
            FORCE_KILL=true
            shift
            ;;
        -l|--log)
            ENABLE_LOG=true
            shift
            ;;
        -d|--log-dir)
            LOG_DIR="$2"
            shift 2
            ;;
        -h|--help)
            show_help
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h or --help for usage information"
            exit 1
            ;;
    esac
done

# Get the project root directory (parent of bin directory)
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "🚀 Starting collarecox production server..."
echo "📁 Project root: $PROJECT_ROOT"

# Change to project root
cd "$PROJECT_ROOT"

# Setup logging if enabled
if [ "$ENABLE_LOG" = true ]; then
    # Create log directory if it doesn't exist
    mkdir -p "$LOG_DIR"

    # Generate timestamp for log filename
    TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
    LOG_FILE="${LOG_DIR}/server_${TIMESTAMP}.log"

    echo "📝 Logging enabled: $LOG_FILE"
    echo "💡 Tip: tail -f $LOG_FILE | grep --color 'threshold\|VAD\|Auto-commit'"
fi

# Check if .env.local exists
if [ ! -f ".env.local" ]; then
    echo "❌ Error: .env.local not found"
    echo "Please create .env.local with required environment variables:"
    echo "  OPENAI_API_KEY=your_api_key_here"
    exit 1
fi

# Load environment variables from .env.local
echo "📋 Loading environment variables from .env.local..."
# Export all variables from .env.local
while IFS= read -r line || [ -n "$line" ]; do
    # Skip comments and empty lines
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    # Export the variable
    export "$line"
done < .env.local

# Disable TLS verification for corporate proxy environments
# WARNING: This is a security risk, use only in trusted network environments
echo "🔓 Disabling TLS verification for corporate proxy environment"
export NODE_TLS_REJECT_UNAUTHORIZED=0

# Check for existing processes on port 8888
echo "🔍 Checking for existing processes on port 8888..."
PIDS=$(lsof -ti:8888 2>/dev/null || true)

if [ -n "$PIDS" ]; then
    if [ "$FORCE_KILL" = true ]; then
        # Force kill existing processes
        echo "⚠️  Found existing process(es): $PIDS"
        echo "🔪 Killing process(es)..."
        echo "$PIDS" | xargs kill -9 2>/dev/null || true
        sleep 1
        echo "✅ Process(es) killed"
    else
        # Error: existing process found without -f flag
        echo "❌ Error: Port 8888 is already in use by process(es): $PIDS"
        echo ""
        echo "To kill existing processes and start the server, use:"
        echo "  bin/prod.sh -f"
        echo ""
        echo "Or manually kill the process(es):"
        echo "  kill -9 $PIDS"
        exit 1
    fi
else
    echo "✅ No existing process found on port 8888"
fi

# Display configuration
echo "✅ Environment loaded"
echo "🌐 Server will start at: http://localhost:8888"
echo "🎤 Realtime API: ws://localhost:8888/api/realtime-ws"
echo "📡 Hocuspocus: ws://localhost:8888/api/yjs-ws"
echo ""

# Build the project for production
echo "🔨 Building project for production..."
npm run build
if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi
echo "✅ Build completed successfully"
echo ""

# Start production server with or without logging
if [ "$ENABLE_LOG" = true ]; then
    echo "📋 Server logs will be saved to: $LOG_FILE"
    echo "🔍 To monitor specific logs in another terminal:"
    echo "   tail -f $LOG_FILE | grep --color 'threshold\|VAD\|Auto-commit\|Error'"
    echo ""
    npm run start 2>&1 | tee "$LOG_FILE"
else
    npm run start
fi
