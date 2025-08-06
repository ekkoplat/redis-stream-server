const WebSocket = require('ws');
const Redis = require('ioredis');
const express = require('express');
const cors = require('cors');

class RedisWebSocketBridge {
    constructor(httpPort = process.env.PORT || 8082, wsPort = 8081) {
        // Create Express app for HTTP endpoints
        this.app = express();
        this.app.use(cors());
        this.app.use(express.json());

        // Create WebSocket server on same port as HTTP (Render requirement)
        this.server = require('http').createServer(this.app);
        this.wss = new WebSocket.Server({ server: this.server });

        // Connect to Upstash Redis with your existing credentials
        const redisConfig = {
            host: 'primary-labrador-30772.upstash.io',
            port: 6379,
            password: 'AXg0AAIjcDE4NjQ4NzliODg2OGI0ZGMxOWY0NTFkMjE5NGYyZTU4NnAxMA',
            tls: {},
            retryStrategy: (times) => Math.min(times * 50, 2000)
        };

        this.subscriber = new Redis(redisConfig);
        this.publisher = new Redis(redisConfig);

        this.clients = new Map();
        this.setupWebSocketServer();
        this.setupHttpEndpoints();

        // Start server
        this.server.listen(httpPort, () => {
            console.log(`🚀 EKKO Redis Stream Server running on port ${httpPort}`);
            console.log(`🔴 WebSocket server ready for connections`);
            console.log(`🟢 HTTP endpoints available`);
        });

        // Redis connection handlers
        this.subscriber.on('connect', () => {
            console.log('✅ Redis subscriber connected');
        });

        this.publisher.on('connect', () => {
            console.log('✅ Redis publisher connected');
        });

        this.subscriber.on('error', (err) => {
            console.error('❌ Redis subscriber error:', err);
        });

        this.publisher.on('error', (err) => {
            console.error('❌ Redis publisher error:', err);
        });
    }

    setupHttpEndpoints() {
        // Health check endpoint
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                connections: this.wss.clients.size,
                timestamp: new Date().toISOString(),
                message: 'EKKO Redis Stream Server is running!'
            });
        });

        // Status endpoint
        this.app.get('/status', (req, res) => {
            res.json({
                status: 'running',
                websocketConnections: this.wss.clients.size,
                redisConnected: this.subscriber.status === 'ready',
                timestamp: new Date().toISOString(),
                message: 'Redis WebSocket server is ready for connections'
            });
        });

        // Get latest 30 tokens endpoint (what your TokenFeed.tsx expects)
        this.app.get('/get-latest-30', async (req, res) => {
            try {
                console.log('📡 Fetching latest 30 tokens from Redis...');

                // Try to get from multiple possible Redis keys
                let tokens = [];

                try {
                    // Try the main tokens list
                    tokens = await this.publisher.lrange('tokens:latest', 0, 29);
                    console.log(`Found ${tokens.length} tokens in tokens:latest`);
                } catch (error) {
                    console.log('No tokens:latest, trying alternatives...');
                }

                // If no tokens, try other common keys
                if (tokens.length === 0) {
                    try {
                        tokens = await this.publisher.lrange('tokens:new', 0, 29);
                        console.log(`Found ${tokens.length} tokens in tokens:new`);
                    } catch (error) {
                        console.log('No tokens:new either');
                    }
                }

                // Parse tokens
                const parsedTokens = tokens.map(token => {
                    try {
                        return JSON.parse(token);
                    } catch (e) {
                        console.error('Error parsing token:', e);
                        return null;
                    }
                }).filter(Boolean);

                console.log(`✅ Returning ${parsedTokens.length} parsed tokens`);

                res.json({
                    success: true,
                    data: parsedTokens,
                    count: parsedTokens.length,
                    timestamp: new Date().toISOString()
                });
            } catch (error) {
                console.error('❌ Error fetching latest tokens:', error);
                res.status(500).json({
                    success: false,
                    error: 'Failed to fetch tokens',
                    message: error.message
                });
            }
        });

        // Test endpoint to add sample data
        this.app.post('/test-token', async (req, res) => {
            try {
                const testToken = {
                    mint: 'TestToken' + Date.now(),
                    symbol: 'TEST',
                    name: 'Test Token',
                    createdAt: new Date().toISOString(),
                    price: Math.random() * 0.001,
                    marketCap: Math.random() * 100000
                };

                // Add to Redis
                await this.publisher.lpush('tokens:latest', JSON.stringify(testToken));
                await this.publisher.ltrim('tokens:latest', 0, 99); // Keep last 100

                // Publish to subscribers
                await this.publisher.publish('tokens:new', JSON.stringify({
                    type: 'INSERT',
                    token: testToken,
                    timestamp: Date.now()
                }));

                console.log('✅ Test token published');
                res.json({ success: true, token: testToken });
            } catch (error) {
                console.error('❌ Error publishing test token:', error);
                res.status(500).json({ success: false, error: error.message });
            }
        });
    }

    setupWebSocketServer() {
        this.wss.on('connection', (ws) => {
            console.log('👤 New WebSocket client connected');
            this.clients.set(ws, new Set());

            ws.on('message', (message) => {
                try {
                    const data = JSON.parse(message.toString());
                    console.log('📨 WebSocket message received:', data);

                    if (data.type === 'subscribe') {
                        const channels = this.clients.get(ws) || new Set();
                        channels.add(data.channel);
                        this.clients.set(ws, channels);

                        // Subscribe to Redis channel if first subscriber
                        if (this.getChannelSubscriberCount(data.channel) === 1) {
                            this.subscriber.subscribe(data.channel);
                            console.log(`🔔 Subscribed to Redis channel: ${data.channel}`);
                        }

                        ws.send(JSON.stringify({
                            type: 'subscribed',
                            channel: data.channel,
                            timestamp: Date.now()
                        }));
                    }

                    if (data.type === 'unsubscribe') {
                        const channels = this.clients.get(ws);
                        if (channels) {
                            channels.delete(data.channel);

                            // Unsubscribe from Redis if no more subscribers
                            if (this.getChannelSubscriberCount(data.channel) === 0) {
                                this.subscriber.unsubscribe(data.channel);
                                console.log(`🔕 Unsubscribed from Redis channel: ${data.channel}`);
                            }
                        }
                    }
                } catch (error) {
                    console.error('❌ Error processing WebSocket message:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid message format'
                    }));
                }
            });

            ws.on('close', () => {
                console.log('👤 WebSocket client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('❌ WebSocket error:', error);
                this.clients.delete(ws);
            });

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Connected to EKKO Redis Stream Server',
                timestamp: Date.now()
            }));
        });
    }

    getChannelSubscriberCount(channel) {
        let count = 0;
        this.clients.forEach((channels) => {
            if (channels.has(channel)) count++;
        });
        return count;
    }

    start() {
        // Handle Redis messages and forward to WebSocket clients
        this.subscriber.on('message', (channel, message) => {
            console.log(`📡 Redis message on channel ${channel}`);

            this.clients.forEach((channels, ws) => {
                if (channels.has(channel) && ws.readyState === WebSocket.OPEN) {
                    try {
                        ws.send(JSON.stringify({
                            channel,
                            data: JSON.parse(message),
                            timestamp: Date.now()
                        }));
                    } catch (error) {
                        console.error('❌ Error forwarding message to client:', error);
                    }
                }
            });
        });

        console.log('🔴 Redis message forwarding started');
    }
}

// Create and start the server
const bridge = new RedisWebSocketBridge();
bridge.start();

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 SIGTERM received, shutting down gracefully');
    bridge.server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 SIGINT received, shutting down gracefully');
    bridge.server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });
});