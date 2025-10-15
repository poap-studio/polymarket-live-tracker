const PolymarketTracker = require('./marketTracker');
const PolymarketWinnerTracker = require('./winnerTracker');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

class PolymarketApp {
    constructor() {
        this.tracker = new PolymarketTracker();
        this.winnerTracker = new PolymarketWinnerTracker();
        this.port = process.env.PORT || 3000;
        this.sseClients = new Set();
    }

    async start() {
        console.log('🚀 Starting Polymarket Tracker Application...');
        
        this.setupRealtimeCallbacks();
        
        // Skip scheduler in serverless environment
        if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') {
            this.tracker.startScheduler();
        } else {
            console.log('Serverless mode - scheduler disabled');
        }
        
        this.startWebServer();
        
        process.on('SIGINT', () => {
            console.log('\n📝 Shutting down gracefully...');
            if (!process.env.VERCEL && process.env.NODE_ENV !== 'production') {
                this.tracker.saveData().then(() => {
                    console.log('✅ Data saved. Goodbye!');
                    process.exit(0);
                });
            } else {
                console.log('✅ Goodbye!');
                process.exit(0);
            }
        });
    }

    setupRealtimeCallbacks() {
        this.tracker.addRealtimeCallback((data) => {
            this.broadcastToClients(data);
        });
    }

    broadcastToClients(data) {
        const message = `data: ${JSON.stringify(data)}\n\n`;
        
        for (const client of this.sseClients) {
            try {
                client.write(message);
            } catch (error) {
                console.log('Error sending SSE data to client:', error.message);
                this.sseClients.delete(client);
            }
        }
        
        if (data.type === 'market_resolved') {
            console.log(`📡 Broadcasting market resolution to ${this.sseClients.size} clients: ${data.market.question}`);
        }
    }

    startWebServer() {
        const server = http.createServer((req, res) => {
            const parsedUrl = url.parse(req.url, true);
            const path = parsedUrl.pathname;

            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Access-Control-Allow-Origin', '*');

            try {
                switch (path) {
                    case '/':
                        this.serveStaticFile(res, 'public/index.html');
                        break;
                    case '/stats':
                        this.handleStats(res);
                        break;
                    case '/active':
                        this.handleActiveEvents(res, parsedUrl.query);
                        break;
                    case '/resolved':
                        this.handleResolvedMarkets(res, parsedUrl.query);
                        break;
                    case '/multi-outcome':
                        this.handleMultiOutcomeMarkets(res, parsedUrl.query);
                        break;
                    case '/top-active':
                        this.handleTopActive(res, parsedUrl.query);
                        break;
                    case '/top-resolved':
                        this.handleTopResolved(res, parsedUrl.query);
                        break;
                    case '/export':
                        this.handleExport(res);
                        break;
                    case '/update':
                        this.handleManualUpdate(res);
                        break;
                    case '/events':
                        this.handleSSE(req, res);
                        break;
                    case '/winners':
                        this.handleWinners(res, parsedUrl.query);
                        break;
                    case '/winner-stats':
                        this.handleWinnerStats(res);
                        break;
                    case '/track-winners':
                        this.handleTrackWinners(res, parsedUrl.query);
                        break;
                    default:
                        res.statusCode = 404;
                        res.end(JSON.stringify({ error: 'Not found' }));
                }
            } catch (error) {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: error.message }));
            }
        });

        server.listen(this.port, () => {
            console.log(`🌐 Web server running on http://localhost:${this.port}`);
            console.log(`📊 Available endpoints:`);
            console.log(`   GET /stats - Market statistics`);
            console.log(`   GET /active?limit=10 - Active markets`);
            console.log(`   GET /resolved?limit=10 - Resolved markets`);
            console.log(`   GET /multi-outcome?type=active&limit=10 - Multi-outcome markets`);
            console.log(`   GET /top-active?limit=10 - Top active markets by volume`);
            console.log(`   GET /top-resolved?limit=10 - Top resolved markets by volume`);
            console.log(`   GET /export - Export all data`);
            console.log(`   GET /update - Manual update trigger`);
            console.log(`   GET /events - Server-Sent Events for real-time updates`);
            console.log(`   GET /winners?marketId=123 - Get winners for specific market`);
            console.log(`   GET /winners?limit=50 - Get top winners across all markets`);
            console.log(`   GET /winner-stats - Get winner statistics`);
            console.log(`   GET /track-winners?marketId=123&outcome=YES - Track winners for resolved market`);
        });
    }

    serveStaticFile(res, filePath) {
        const fullPath = path.join(__dirname, filePath);
        
        fs.readFile(fullPath, (err, content) => {
            if (err) {
                res.statusCode = 404;
                res.setHeader('Content-Type', 'text/html');
                res.end('<h1>404 Not Found</h1>');
                return;
            }
            
            const ext = path.extname(filePath);
            let contentType = 'text/html';
            
            if (ext === '.css') contentType = 'text/css';
            else if (ext === '.js') contentType = 'application/javascript';
            else if (ext === '.json') contentType = 'application/json';
            
            res.setHeader('Content-Type', contentType);
            res.end(content);
        });
    }

    handleHome(res) {
        const response = {
            name: 'Polymarket Tracker API',
            version: '1.0.0',
            status: 'running',
            endpoints: [
                '/stats',
                '/active',
                '/resolved', 
                '/multi-outcome',
                '/top-active',
                '/top-resolved',
                '/export',
                '/update'
            ],
            lastUpdate: this.tracker.markets.lastUpdate
        };
        res.end(JSON.stringify(response, null, 2));
    }

    handleStats(res) {
        const activeEvents = this.tracker.events.active.size;
        const resolvedEvents = this.tracker.events.resolved.size;
        
        const activeEventsArray = Array.from(this.tracker.events.active.values());
        const totalActiveMarkets = activeEventsArray.reduce((sum, e) => sum + e.activeMarketsCount, 0);
        const totalResolvedMarkets = activeEventsArray.reduce((sum, e) => sum + e.resolvedMarketsCount, 0);
        const totalActiveMultiOutcome = activeEventsArray.reduce((sum, e) => sum + e.multiOutcomeMarketsCount, 0);
        const totalVolume = activeEventsArray.reduce((sum, e) => sum + e.totalVolume, 0);

        const stats = {
            totalEvents: activeEvents + resolvedEvents,
            events: {
                active: activeEvents,
                resolved: resolvedEvents
            },
            markets: {
                total: totalActiveMarkets + totalResolvedMarkets,
                active: totalActiveMarkets,
                resolved: totalResolvedMarkets,
                multiOutcome: totalActiveMultiOutcome,
                binary: totalActiveMarkets - totalActiveMultiOutcome
            },
            totalVolume: totalVolume,
            lastUpdate: this.tracker.events.lastUpdate
        };

        res.end(JSON.stringify(stats, null, 2));
    }

    handleActiveEvents(res, query) {
        const limit = parseInt(query.limit) || 10;
        const events = Array.from(this.tracker.events.active.values())
            .sort((a, b) => b.totalVolume - a.totalVolume)
            .slice(0, limit);

        res.end(JSON.stringify({
            count: events.length,
            total: this.tracker.events.active.size,
            events
        }, null, 2));
    }

    handleActiveMarkets(res, query) {
        const limit = parseInt(query.limit) || 10;
        const markets = Array.from(this.tracker.markets.active.values())
            .sort((a, b) => b.volumeUSD - a.volumeUSD)
            .slice(0, limit);

        res.end(JSON.stringify({
            count: markets.length,
            total: this.tracker.markets.active.size,
            markets
        }, null, 2));
    }

    handleResolvedMarkets(res, query) {
        const limit = parseInt(query.limit) || 10;
        const markets = Array.from(this.tracker.markets.resolved.values())
            .sort((a, b) => b.volumeUSD - a.volumeUSD)
            .slice(0, limit);

        res.end(JSON.stringify({
            count: markets.length,
            total: this.tracker.markets.resolved.size,
            markets
        }, null, 2));
    }

    handleMultiOutcomeMarkets(res, query) {
        const type = query.type || 'active';
        const limit = parseInt(query.limit) || 10;
        const markets = this.tracker.getMultiOutcomeMarkets(type, limit);

        res.end(JSON.stringify({
            type,
            count: markets.length,
            markets
        }, null, 2));
    }

    handleTopActive(res, query) {
        const limit = parseInt(query.limit) || 10;
        const markets = this.tracker.getTopMarkets('active', limit);

        res.end(JSON.stringify({
            count: markets.length,
            markets
        }, null, 2));
    }

    handleTopResolved(res, query) {
        const limit = parseInt(query.limit) || 10;
        const markets = this.tracker.getTopMarkets('resolved', limit);

        res.end(JSON.stringify({
            count: markets.length,
            markets
        }, null, 2));
    }

    async handleExport(res) {
        try {
            if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
                // In serverless, return the data directly instead of saving to file
                const exportData = this.tracker.exportData();
                res.end(JSON.stringify({
                    success: true,
                    data: exportData,
                    message: 'Data exported successfully (serverless mode)'
                }, null, 2));
            } else {
                const exportFile = await this.tracker.exportData();
                res.end(JSON.stringify({
                    success: true,
                    file: exportFile,
                    message: 'Data exported successfully'
                }, null, 2));
            }
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async handleManualUpdate(res) {
        try {
            res.end(JSON.stringify({
                success: true,
                message: 'Manual update triggered'
            }, null, 2));
            
            this.tracker.performFullUpdate();
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    handleSSE(req, res) {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Cache-Control'
        });

        res.write('data: {"type":"connected","message":"SSE connection established"}\n\n');

        this.sseClients.add(res);
        console.log(`📡 New SSE client connected. Total clients: ${this.sseClients.size}`);

        req.on('close', () => {
            this.sseClients.delete(res);
            console.log(`📡 SSE client disconnected. Total clients: ${this.sseClients.size}`);
        });

        req.on('error', (error) => {
            console.log('SSE client error:', error.message);
            this.sseClients.delete(res);
        });
    }

    handleWinners(res, query) {
        try {
            const marketId = query.marketId;
            const limit = parseInt(query.limit) || 1000; // Increased default from 50 to 1000
            
            if (marketId) {
                // Get winners for specific market
                const winners = this.winnerTracker.getMarketWinners(marketId);
                if (!winners) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'Market winners not found' }));
                    return;
                }
                res.end(JSON.stringify(winners, null, 2));
            } else {
                // Get top winners across all markets
                const topWinners = this.winnerTracker.getTopWinners(limit);
                res.end(JSON.stringify({
                    topWinners,
                    count: topWinners.length,
                    limit
                }, null, 2));
            }
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async handleWinnerStats(res) {
        try {
            const stats = await this.winnerTracker.getWinnerStats();
            res.end(JSON.stringify(stats, null, 2));
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    async handleTrackWinners(res, query) {
        try {
            const marketId = query.marketId;
            const winningOutcome = query.outcome;
            const blockNumber = query.blockNumber ? parseInt(query.blockNumber) : null;
            
            if (!marketId || !winningOutcome) {
                res.statusCode = 400;
                res.end(JSON.stringify({ 
                    error: 'Missing required parameters: marketId and outcome' 
                }));
                return;
            }

            console.log(`🎯 Triggering winner tracking for market ${marketId}, outcome: ${winningOutcome}`);
            
            // Start tracking in background
            this.winnerTracker.trackMarketWinners(marketId, winningOutcome, blockNumber)
                .then(result => {
                    if (result) {
                        console.log(`✅ Winner tracking completed for market ${marketId}`);
                    }
                })
                .catch(error => {
                    console.error(`❌ Winner tracking failed for market ${marketId}:`, error);
                });

            res.end(JSON.stringify({
                success: true,
                message: `Winner tracking initiated for market ${marketId}`,
                marketId,
                winningOutcome,
                blockNumber
            }, null, 2));
            
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    }
}

if (require.main === module) {
    const app = new PolymarketApp();
    app.start().catch(console.error);
}

module.exports = PolymarketApp;