const PolymarketTracker = require('../marketTracker');
const PolymarketWinnerTracker = require('../winnerTracker');
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
        console.log('Serverless mode - scheduler disabled');
    }

    setupRealtimeCallbacks() {
        this.tracker.addRealtimeCallback((data) => {
            this.broadcastToClients(data);
        });
    }

    broadcastToClients(data) {
        const message = `data: ${JSON.stringify(data)}\\n\\n`;
        
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

    async handleRequest(req, res) {
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
                    await this.handleExport(res);
                    break;
                case '/update':
                    await this.handleManualUpdate(res);
                    break;
                case '/events':
                    this.handleSSE(req, res);
                    break;
                case '/winners':
                    this.handleWinners(res, parsedUrl.query);
                    break;
                case '/winner-stats':
                    await this.handleWinnerStats(res);
                    break;
                case '/track-winners':
                    await this.handleTrackWinners(res, parsedUrl.query);
                    break;
                default:
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'Not found' }));
            }
        } catch (error) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error.message }));
        }
    }

    serveStaticFile(res, filePath) {
        const fullPath = path.join(__dirname, '..', filePath);
        
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
            const exportData = this.tracker.exportData();
            res.end(JSON.stringify({
                success: true,
                data: exportData,
                message: 'Data exported successfully (serverless mode)'
            }, null, 2));
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

        res.write('data: {"type":"connected","message":"SSE connection established"}\\n\\n');

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
            const limit = parseInt(query.limit) || 1000;
            
            if (marketId) {
                const winners = this.winnerTracker.getMarketWinners(marketId);
                if (!winners) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: 'Market winners not found' }));
                    return;
                }
                res.end(JSON.stringify(winners, null, 2));
            } else {
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

// Global app instance for serverless functions
let globalApp = null;

async function getApp() {
    if (!globalApp) {
        globalApp = new PolymarketApp();
        await globalApp.start();
    }
    return globalApp;
}

// Serverless function handler for Vercel
module.exports = async (req, res) => {
    try {
        const app = await getApp();
        await app.handleRequest(req, res);
    } catch (error) {
        console.error('Serverless handler error:', error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
};