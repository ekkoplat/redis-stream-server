#!/usr/bin/env node
/**
 * Redis Stream Server for EKKO Token Feed - Render.com Deployment
 * Based on the working local redis-stream-server.js
 * Provides all endpoints that frontend expects
 */

const express = require('express');
const cors = require('cors');
const { createClient } = require('redis');

const app = express();
const PORT = process.env.PORT || 8082;

// Middleware
app.use(cors());
app.use(express.json());

// Redis clients
let client = null;
let subscriber = null;

// EXACT same Redis configs as your working local server - but prioritize the one that has data
const REDIS_CONFIGS = [
    // Option 1: Redis Cloud Public (where pumpfun-all.js was publishing before)
    {
        name: 'Redis Cloud Public',
        config: {
            username: 'default',
            password: 'Hakoff11!',
            socket: {
                host: 'redis-12423.c43162.us-east-1-mz.ec2.cloud.rlrcp.com',
                port: 12423
            }
        }
    },
    // Option 2: Upstash Redis (backup)
    {
        name: 'Upstash Redis (Production)',
        config: {
            username: 'default',
            password: 'AXg0AAIjcDE4NjQ4NzliODg2OGI0ZGMxOWY0NTFkMjE5NGYyZTU4NnAxMA',
            socket: {
                host: 'primary-labrador-30772.upstash.io',
                port: 6379,
                tls: true
            }
        }
    },
    // Option 3: Redis Cloud Alt Format
    {
        name: 'Redis Cloud Alt Format',
        config: {
            username: 'default',
            password: 'Hakoff11!',
            socket: {
                host: 'c43162-redis-12423.us-east-1-mz.ec2.cloud.rlrcp.com',
                port: 12423
            }
        }
    }
];

// Connect to Redis
async function connectRedis() {
    for (const configOption of REDIS_CONFIGS) {
        try {
            console.log(`⏳ Trying: ${configOption.name}`);

            // Main client for operations
            client = createClient(configOption.config);
            client.on('error', err => console.log('Redis Client Error:', err));
            await client.connect();

            // Subscriber client for keyspace notifications
            subscriber = createClient(configOption.config);
            subscriber.on('error', err => console.log('Redis Subscriber Error:', err));
            await subscriber.connect();

            // Enable keyspace notifications for new keys
            await client.configSet('notify-keyspace-events', 'KEA');

            // Test if this Redis instance has token data
            const tokenKeys = await client.keys('token/*');
            console.log(`📊 Found ${tokenKeys.length} tokens in ${configOption.name}`);

            console.log(`✅ Redis connected (${configOption.name})`);
            return true;
        } catch (error) {
            console.log(`❌ Failed: ${configOption.name} - ${error.message}`);

            try {
                if (client) await client.quit();
                if (subscriber) await subscriber.quit();
            } catch (cleanupError) {
                // Ignore cleanup errors
            }
            client = null;
            subscriber = null;
        }
    }

    console.log('❌ All Redis configs failed');
    return false;
}

// Health check endpoint for Render.com
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Status endpoint with Redis connection info
app.get('/status', async (req, res) => {
    try {
        if (!client) {
            return res.json({
                connected: false,
                error: 'Redis not connected',
                timestamp: new Date().toISOString()
            });
        }

        const tokenKeys = await client.keys('token/*');
        const txKeys = await client.keys('transaction/*');

        res.json({
            connected: true,
            tokenCount: tokenKeys.length,
            transactionCount: txKeys.length,
            server: 'Redis Stream Server for EKKO',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            connected: false,
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Get Redis status (frontend expects this endpoint)
app.get('/api/redis/status', async (req, res) => {
    try {
        if (!client) {
            return res.status(503).json({
                connected: false,
                error: 'Redis not connected'
            });
        }

        const tokenKeys = await client.keys('token/*');
        const txKeys = await client.keys('transaction/*');

        res.json({
            connected: true,
            tokenCount: tokenKeys.length,
            transactionCount: txKeys.length,
            server: 'Redis Stream Server for EKKO'
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get specific token data (frontend expects this endpoint)
app.get('/api/redis/tokens/:key', async (req, res) => {
    try {
        if (!client) {
            return res.status(503).json({ error: 'Redis not connected' });
        }

        const { key } = req.params;
        // Decode the key in case it's URL encoded
        const decodedKey = decodeURIComponent(key);
        const data = await client.hGetAll(decodedKey);

        if (Object.keys(data).length === 0) {
            return res.status(404).json({ error: 'Token not found' });
        }

        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// MAIN ENDPOINT: Get latest 30 tokens - compatible with frontend expectations
app.get('/get-latest-30', async (req, res) => {
    try {
        const startTime = Date.now();

        if (!client) {
            return res.json({
                success: false,
                error: 'Redis not connected',
                data: [],
                count: 0,
                timestamp: new Date().toISOString()
            });
        }

        console.log(`🚀 Getting latest 30 tokens using optimized approach`);

        // Get ALL token keys at once
        const tokenKeys = await client.keys('token/*');
        console.log(`📊 Found ${tokenKeys.length} total tokens`);

        if (tokenKeys.length === 0) {
            return res.json({
                success: true,
                data: [],
                count: 0,
                timestamp: new Date().toISOString(),
                responseTime: `${Date.now() - startTime}ms`
            });
        }

        // Get timestamps first to sort, then fetch full data for top 30
        const timestampPipeline = client.multi();
        tokenKeys.forEach(key => timestampPipeline.hGet(key, 'createdAt'));
        const timestampResults = await timestampPipeline.exec();

        // Create array of [key, timestamp] pairs for sorting
        const keyTimestamps = [];
        for (let i = 0; i < tokenKeys.length; i++) {
            const timestampResult = timestampResults[i];
            let timestamp = null;

            if (Array.isArray(timestampResult) && timestampResult.length === 2) {
                timestamp = timestampResult[1]; // [error, data] format
            } else {
                timestamp = timestampResult;
            }

            // Fallback to current time if no timestamp
            const createdAt = timestamp || new Date().toISOString();
            keyTimestamps.push([tokenKeys[i], new Date(createdAt).getTime()]);
        }

        // Sort by timestamp (newest first) and take only top 30 keys
        keyTimestamps.sort((a, b) => b[1] - a[1]);
        const top30Keys = keyTimestamps.slice(0, 30).map(item => item[0]);

        console.log(`⚡ Sorted ${tokenKeys.length} tokens, fetching full data for top 30`);

        // Now fetch full data ONLY for the 30 newest tokens
        const dataPipeline = client.multi();
        top30Keys.forEach(key => dataPipeline.hGetAll(key));
        const dataResults = await dataPipeline.exec();

        const tokens = [];
        for (let i = 0; i < dataResults.length; i++) {
            try {
                const result = dataResults[i];
                let error = null;
                let data = null;

                if (Array.isArray(result) && result.length === 2) {
                    [error, data] = result;
                } else {
                    data = result;
                }

                if (!error && data && Object.keys(data).length > 0) {
                    const createdAt = data.createdAt || data.created_at || data.timestamp || new Date().toISOString();

                    tokens.push({
                        ...data,
                        key: top30Keys[i],
                        created_at: createdAt,
                        createdAt: createdAt,
                        bonding_curve_progress: parseFloat(data.bonding_curve_progress || 0)
                    });
                }
            } catch (err) {
                console.error(`❌ Error processing token ${top30Keys[i]}:`, err);
            }
        }

        const elapsed = Date.now() - startTime;
        console.log(`⚡ Got ${tokens.length} latest tokens in ${elapsed}ms from ${tokenKeys.length} total`);

        res.json({
            success: true,
            data: tokens,
            count: tokens.length,
            timestamp: new Date().toISOString(),
            responseTime: `${elapsed}ms`,
            totalTokens: tokenKeys.length
        });

    } catch (error) {
        console.error('❌ Error getting latest tokens:', error);
        res.status(500).json({
            success: false,
            error: error.message,
            data: [],
            count: 0,
            timestamp: new Date().toISOString()
        });
    }
});

// Real-time Redis keyspace notifications stream using Server-Sent Events
app.get('/api/redis/stream', (req, res) => {
    // Set up Server-Sent Events
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
    });

    console.log('📡 New client connected to Redis stream');

    if (!subscriber) {
        res.write('event: error\ndata: No Redis subscriber available\n\n');
        return;
    }

    // Track recent notifications to prevent spam
    const notificationDebounce = new Map();
    const NOTIFICATION_DEBOUNCE_MS = 5000; // 5 seconds between notifications for same token

    // Subscribe to keyspace notifications for token and transaction keys
    subscriber.pSubscribe('__keyspace@0__:token/*', (message, pattern) => {
        console.log(`🔔 Redis keyspace notification: ${pattern} -> ${message}`);
        if (message === 'hset') {
            // New token hash created
            const tokenKey = pattern.replace('__keyspace@0__:', '');

            // Debounce notifications for the same token
            const now = Date.now();
            const lastNotification = notificationDebounce.get(tokenKey);

            if (lastNotification && (now - lastNotification) < NOTIFICATION_DEBOUNCE_MS) {
                console.log(`⏭️ Skipping notification for ${tokenKey} - debounced`);
                return;
            }

            notificationDebounce.set(tokenKey, now);
            console.log(`🆕 New token detected in real-time: ${tokenKey}`);
            res.write(`event: token\ndata: ${tokenKey}\n\n`);
        }
    });

    subscriber.pSubscribe('__keyspace@0__:transaction/*', (message, pattern) => {
        console.log(`🔔 Redis keyspace notification: ${pattern} -> ${message}`);
        if (message === 'hset') {
            // New transaction hash created
            const txKey = pattern.replace('__keyspace@0__:', '');
            console.log(`💰 New transaction detected in real-time: ${txKey}`);
            res.write(`event: transaction\ndata: ${txKey}\n\n`);
        }
    });

    // Keep connection alive
    const keepAlive = setInterval(() => {
        res.write('event: ping\ndata: ping\n\n');
    }, 30000);

    // Clean up old debounce entries periodically
    const cleanupInterval = setInterval(() => {
        const now = Date.now();
        const cleanupThreshold = NOTIFICATION_DEBOUNCE_MS * 2;

        notificationDebounce.forEach((timestamp, key) => {
            if (now - timestamp > cleanupThreshold) {
                notificationDebounce.delete(key);
            }
        });
    }, 60000);

    // Clean up when client disconnects
    req.on('close', () => {
        console.log('📡 Client disconnected from Redis stream');
        clearInterval(keepAlive);
        clearInterval(cleanupInterval);
    });
});

// Test endpoint to add a sample token (for debugging)
app.get('/test-token', async (req, res) => {
    try {
        if (!client) {
            return res.status(503).json({ error: 'Redis not connected' });
        }

        const testToken = {
            mint: 'TEST123456789',
            symbol: 'TEST',
            name: 'Test Token',
            createdAt: new Date().toISOString(),
            bonding_curve_progress: '0.25'
        };

        await client.hSet('token/TEST123456789', testToken);
        console.log('✅ Added test token to Redis');

        res.json({
            success: true,
            message: 'Test token added',
            token: testToken
        });
    } catch (error) {
        console.error('❌ Error adding test token:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start server
async function startServer() {
    console.log('🚀 Starting Redis Stream Server for Render.com deployment...');

    const connected = await connectRedis();
    if (!connected) {
        console.error('❌ Failed to connect to Redis - server will start but return empty data');
    } else {
        // Check existing data
        const tokenKeys = await client.keys('token/*');
        const txKeys = await client.keys('transaction/*');
        console.log(`📊 Found ${tokenKeys.length} tokens and ${txKeys.length} transactions in Redis`);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🌐 Redis Stream Server running on port ${PORT}`);
        console.log('');
        console.log('📡 Available Endpoints:');
        console.log(`   GET /health (Render.com health check)`);
        console.log(`   GET /status (Server status)`);
        console.log(`   GET /get-latest-30 (Main token feed)`);
        console.log(`   GET /api/redis/status (Redis status)`);
        console.log(`   GET /api/redis/stream (Real-time SSE stream)`);
        console.log(`   GET /api/redis/tokens/:key (Individual token data)`);
        console.log(`   GET /test-token (Add test token for debugging)`);
        console.log('');
        console.log('🎯 Ready to serve EKKO token feeds!');
    });
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down Redis Stream Server...');
    if (client) {
        await client.quit();
    }
    if (subscriber) {
        await subscriber.quit();
    }
    process.exit(0);
});

startServer();