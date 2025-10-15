const url = require('url');
const fs = require('fs');
const path = require('path');

// Simple serverless function that fetches data directly from Polymarket API
async function fetchPolymarketData(endpoint, params = {}) {
    try {
        const queryString = new URLSearchParams(params).toString();
        const apiUrl = `https://gamma-api.polymarket.com${endpoint}${queryString ? `?${queryString}` : ''}`;
        
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API request failed: ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        console.error(`Error fetching ${endpoint}:`, error);
        return null;
    }
}

async function getStats() {
    try {
        // Get active events with basic stats
        const activeEvents = await fetchPolymarketData('/events', {
            limit: 1000,
            closed: false
        });
        
        // Get resolved events sample
        const resolvedEvents = await fetchPolymarketData('/events', {
            limit: 100,
            closed: true
        });
        
        if (!activeEvents || !resolvedEvents) {
            return {
                totalEvents: 0,
                events: { active: 0, resolved: 0 },
                markets: { total: 0, active: 0, resolved: 0, multiOutcome: 0, binary: 0 },
                totalVolume: 0,
                lastUpdate: new Date().toISOString()
            };
        }
        
        let totalVolume = 0;
        let totalActiveMarkets = 0;
        let totalResolvedMarkets = 0;
        
        // Calculate stats from active events
        activeEvents.forEach(event => {
            totalVolume += event.volume || 0;
            totalActiveMarkets += event.markets?.length || 0;
        });
        
        // Calculate stats from resolved events
        resolvedEvents.forEach(event => {
            totalResolvedMarkets += event.markets?.length || 0;
        });
        
        return {
            totalEvents: activeEvents.length + resolvedEvents.length,
            events: {
                active: activeEvents.length,
                resolved: resolvedEvents.length
            },
            markets: {
                total: totalActiveMarkets + totalResolvedMarkets,
                active: totalActiveMarkets,
                resolved: totalResolvedMarkets,
                multiOutcome: 0,
                binary: totalActiveMarkets
            },
            totalVolume: totalVolume,
            lastUpdate: new Date().toISOString()
        };
    } catch (error) {
        console.error('Error calculating stats:', error);
        return {
            totalEvents: 0,
            events: { active: 0, resolved: 0 },
            markets: { total: 0, active: 0, resolved: 0, multiOutcome: 0, binary: 0 },
            totalVolume: 0,
            lastUpdate: new Date().toISOString(),
            error: error.message
        };
    }
}

async function getActiveEvents(limit = 10) {
    try {
        const events = await fetchPolymarketData('/events', {
            limit: limit,
            closed: false
        });
        
        if (!events) {
            return { count: 0, total: 0, events: [] };
        }
        
        // Enhance events with market data
        const enhancedEvents = events.map(event => ({
            ...event,
            markets: event.markets || [],
            activeMarketsCount: event.markets?.filter(m => m.active)?.length || 0,
            resolvedMarketsCount: event.markets?.filter(m => !m.active)?.length || 0,
            multiOutcomeMarketsCount: 0,
            totalVolume: event.volume || 0
        }));
        
        return {
            count: enhancedEvents.length,
            total: enhancedEvents.length,
            events: enhancedEvents
        };
    } catch (error) {
        console.error('Error fetching active events:', error);
        return { count: 0, total: 0, events: [], error: error.message };
    }
}

function serveStaticFile(res, filePath) {
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

// Serverless function handler for Vercel
module.exports = async (req, res) => {
    try {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
            res.statusCode = 200;
            res.end();
            return;
        }

        console.log(`[${new Date().toISOString()}] ${req.method} ${pathname}`);

        switch (pathname) {
            case '/':
                serveStaticFile(res, 'public/index.html');
                break;
                
            case '/stats':
                res.setHeader('Content-Type', 'application/json');
                const stats = await getStats();
                res.end(JSON.stringify(stats, null, 2));
                break;
                
            case '/active':
                res.setHeader('Content-Type', 'application/json');
                const limit = parseInt(parsedUrl.query.limit) || 10;
                const activeEvents = await getActiveEvents(limit);
                res.end(JSON.stringify(activeEvents, null, 2));
                break;
                
            case '/resolved':
                res.setHeader('Content-Type', 'application/json');
                const resolvedEvents = await fetchPolymarketData('/events', {
                    limit: parseInt(parsedUrl.query.limit) || 10,
                    closed: true
                });
                res.end(JSON.stringify({
                    count: resolvedEvents?.length || 0,
                    total: resolvedEvents?.length || 0,
                    markets: resolvedEvents || []
                }, null, 2));
                break;
                
            case '/update':
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    success: true,
                    message: 'Data fetched fresh on each request in serverless mode',
                    timestamp: new Date().toISOString()
                }, null, 2));
                break;
                
            case '/events':
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Headers': 'Cache-Control'
                });
                res.write('data: {"type":"connected","message":"SSE connected in serverless mode"}\n\n');
                // Keep connection alive for a bit
                setTimeout(() => {
                    res.write('data: {"type":"info","message":"Serverless SSE timeout"}\n\n');
                    res.end();
                }, 30000);
                break;
                
            case '/winners':
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    message: 'Winner tracking not available in serverless mode',
                    topWinners: [],
                    count: 0
                }, null, 2));
                break;
                
            case '/winner-stats':
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    totalMarketsTracked: 0,
                    totalWinners: 0,
                    totalPayouts: 0,
                    averageWinnerPayout: 0,
                    topWinner: null
                }, null, 2));
                break;
                
            case '/track-winners':
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    success: false,
                    message: 'Winner tracking not available in serverless mode'
                }, null, 2));
                break;
                
            default:
                res.statusCode = 404;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Not found' }));
        }
    } catch (error) {
        console.error('Serverless handler error:', error);
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ 
            error: 'Internal server error',
            message: error.message,
            timestamp: new Date().toISOString()
        }));
    }
};