# EKKO Redis Stream Server

A lightweight Redis WebSocket bridge for EKKO token feeds, designed to be deployed on Render.com.

## What This Does

This server bridges your Redis token streams to WebSocket clients and provides HTTP endpoints for your frontend:

- **WebSocket Server**: Real-time token updates via WebSocket
- **HTTP Endpoints**: REST API for fetching token data
- **Redis Integration**: Connects to your existing Upstash Redis instance

## Endpoints

### HTTP Endpoints

- `GET /health` - Health check
- `GET /status` - Server status and connection info
- `GET /get-latest-30` - Fetch latest 30 tokens (used by TokenFeed.tsx)
- `POST /test-token` - Add a test token for testing

### WebSocket

Connect to the base URL and send JSON messages:

```javascript
// Subscribe to token updates
ws.send(JSON.stringify({
    type: 'subscribe',
    channel: 'tokens:new'
}));

// Unsubscribe
ws.send(JSON.stringify({
    type: 'unsubscribe',
    channel: 'tokens:new'
}));
```

## Deployment to Render.com

### Option 1: Deploy from GitHub

1. Push this `redis-stream-server` folder to a GitHub repository
2. Go to Render.com dashboard
3. Click "New +" → "Web Service"
4. Connect your GitHub repository
5. Set root directory to `redis-stream-server`
6. Render will automatically detect the `render.yaml` and deploy

### Option 2: Manual Deploy

1. Zip the `redis-stream-server` folder
2. Go to Render.com dashboard
3. Click "New +" → "Web Service"
4. Choose "Deploy an existing image or repository"
5. Upload your zip file

## After Deployment

Once deployed, you'll get a URL like: `https://ekko-redis-stream.onrender.com`

Update your frontend environment variables:

```env
# In your Netlify environment variables
VITE_REDIS_WS_URL=wss://ekko-redis-stream.onrender.com
```

And update your `TokenFeed.tsx`:

```javascript
// Change from:
const response = await fetch('http://localhost:8082/get-latest-30');

// To:
const response = await fetch('https://ekko-redis-stream.onrender.com/get-latest-30');
```

## Testing

After deployment:

1. Visit `https://your-app.onrender.com/health` - should return server status
2. Visit `https://your-app.onrender.com/get-latest-30` - should return token data
3. Test WebSocket connection from your frontend

## Redis Data Structure

The server expects Redis to have token data in these keys:

- `tokens:latest` - List of latest tokens
- `tokens:new` - List of new tokens
- Channel `tokens:new` - Pub/sub for real-time updates

## Local Testing

```bash
npm install
npm start
```

Server will run on `http://localhost:8082` with WebSocket on the same port.