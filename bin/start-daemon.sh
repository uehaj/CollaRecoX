#!/bin/bash

# Collarecox WebSocket Server Daemon Starter
# Usage: ./start-daemon.sh [start|stop|restart|status]

# Detect project directory (use current directory if not in expected location)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

LOG_DIR="$PROJECT_DIR/logs"
PID_FILE="$PROJECT_DIR/server.pid"
LOG_FILE="$LOG_DIR/server.log"
ERROR_LOG="$LOG_DIR/server.error.log"

# Change to project directory
cd "$PROJECT_DIR"

# Create log directory if it doesn't exist
mkdir -p "$LOG_DIR"

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


case "${1:-start}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
      echo "Server is already running (PID: $(cat $PID_FILE))"
      exit 1
    fi
    
    # Check for required environment variables
    if [ -z "$OPENAI_API_KEY" ]; then
      echo "❌ ERROR: OPENAI_API_KEY environment variable is required"
      echo "Please set your OpenAI API key:"
      echo "export OPENAI_API_KEY=\"your-api-key-here\""
      echo "You can find your API key at: https://platform.openai.com/account/api-keys"
      exit 1
    fi
    
    echo "Starting Collarecox server..."

    # Check if production build exists, if not, build it
    if [ ! -f ".next/BUILD_ID" ]; then
      echo "Production build not found. Building application..."
      npm run build
      if [ $? -ne 0 ]; then
        echo "❌ Build failed. Cannot start server."
        exit 1
      fi
      echo "✅ Build completed successfully."
    fi
    
    # Start server with nohup and redirect output, disable proxy for localhost, enable trace warnings
    nohup env NODE_ENV=production NODE_OPTIONS="--trace-warnings --trace-uncaught" OPENAI_API_KEY="${OPENAI_API_KEY}" NO_PROXY="localhost,127.0.0.1,::1" no_proxy="localhost,127.0.0.1,::1" node server.js -h 0.0.0.0 > "$LOG_FILE" 2> "$ERROR_LOG" & 
    
    # Save PID
    echo $! > "$PID_FILE"
    
    echo "Server started with PID: $(cat $PID_FILE)"
    echo "Logs: $LOG_FILE"
    echo "Error logs: $ERROR_LOG"
    ;;
    
  stop)
    if [ ! -f "$PID_FILE" ]; then
      echo "PID file not found. Server may not be running."
      exit 1
    fi
    
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "Stopping server (PID: $PID)..."
      kill "$PID"
      
      # Wait for process to stop
      for i in {1..10}; do
        if ! kill -0 "$PID" 2>/dev/null; then
          break
        fi
        sleep 1
      done
      
      # Force kill if still running
      if kill -0 "$PID" 2>/dev/null; then
        echo "Force killing server..."
        kill -9 "$PID"
      fi
      
      rm -f "$PID_FILE"
      echo "Server stopped."
    else
      echo "Server process not found. Cleaning up PID file."
      rm -f "$PID_FILE"
    fi
    ;;
    
  restart)
    $0 stop
    sleep 2
    $0 start
    ;;
    
  status)
    if [ -f "$PID_FILE" ] && kill -0 $(cat "$PID_FILE") 2>/dev/null; then
      echo "Server is running (PID: $(cat $PID_FILE))"
      echo "Port check:"
      netstat -tlnp 2>/dev/null | grep 8888 || echo "Port 8888 not found"
    else
      echo "Server is not running"
      [ -f "$PID_FILE" ] && rm -f "$PID_FILE"
    fi
    ;;
    
  logs)
    echo "=== Server Logs ==="
    tail -f "$LOG_FILE"
    ;;
    
  errors)
    echo "=== Error Logs ==="
    tail -f "$ERROR_LOG"
    ;;
    
  *)
    echo "Usage: $0 {start|stop|restart|status|logs|errors}"
    echo ""
    echo "Commands:"
    echo "  start   - Start the server"
    echo "  stop    - Stop the server"
    echo "  restart - Restart the server"
    echo "  status  - Check server status"
    echo "  logs    - Show server logs (tail -f)"
    echo "  errors  - Show error logs (tail -f)"
    exit 1
    ;;
esac
