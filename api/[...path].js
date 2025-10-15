const url = require('url');
const fs = require('fs');
const path = require('path');

// Serverless function that proxies directly to Polymarket API
module.exports = async (req, res) => {
    try {
        const parsedUrl = url.parse(req.url, true);
        const pathname = parsedUrl.pathname;

        // Set CORS headers
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
                return serveStaticFile(res, 'public/index.html');
                
            case '/stats':
                return await handleStats(req, res);
                
            case '/active':
                return await handleActive(req, res, parsedUrl.query);
                
            case '/resolved':
                return await handleResolved(req, res, parsedUrl.query);
                
            case '/update':
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    success: true,
                    message: 'Data fetched fresh on each request in serverless mode',
                    timestamp: new Date().toISOString()
                }));
                break;
                
            case '/events':
                // Simple SSE endpoint
                res.writeHead(200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache',
                    'Connection': 'keep-alive',
                    'Access-Control-Allow-Origin': '*'
                });
                res.write('data: {"type":"connected","message":"Serverless SSE connected"}\n\n');
                setTimeout(() => res.end(), 30000);
                break;
                
            case '/winners':
            case '/winner-stats':
            case '/track-winners':
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    message: 'Winner tracking not available in serverless mode',
                    data: []
                }));
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
            message: error.message
        }));
    }
};

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

async function makeApiRequest(endpoint, params = {}) {
    const https = require('https');
    const queryString = new URLSearchParams(params).toString();
    const apiUrl = `https://gamma-api.polymarket.com${endpoint}${queryString ? `?${queryString}` : ''}`;
    
    return new Promise((resolve) => {
        const request = https.get(apiUrl, (response) => {
            let data = '';
            
            response.on('data', (chunk) => {
                data += chunk;
            });
            
            response.on('end', () => {
                try {
                    const jsonData = JSON.parse(data);
                    resolve(jsonData);
                } catch (parseError) {
                    console.error('Error parsing JSON:', parseError);
                    resolve([]);
                }
            });
        });
        
        request.on('error', (error) => {
            console.error(`Error fetching ${endpoint}:`, error);
            resolve([]);
        });
        
        request.setTimeout(15000, () => {
            request.abort();
            console.error(`Request timeout for ${endpoint}`);
            resolve([]);
        });
    });
}

// Function to fetch multiple pages of events
async function makeMultiPageApiRequest(endpoint, params = {}, maxEvents = 10000) {
    const allEvents = [];
    const batchSize = 500; // API maximum per request
    const maxBatches = Math.ceil(Math.min(maxEvents, 10000) / batchSize);
    
    for (let i = 0; i < maxBatches; i++) {
        const offset = i * batchSize;
        const batchParams = {
            ...params,
            limit: batchSize,
            offset: offset
        };
        
        const batch = await makeApiRequest(endpoint, batchParams);
        
        if (!batch || batch.length === 0) {
            break; // No more data
        }
        
        allEvents.push(...batch);
        
        // If we got less than the batch size, we've reached the end
        if (batch.length < batchSize) {
            break;
        }
        
        // Stop if we've reached our target
        if (allEvents.length >= maxEvents) {
            break;
        }
    }
    
    return allEvents.slice(0, maxEvents);
}

async function handleStats(req, res) {
    try {
        res.setHeader('Content-Type', 'application/json');
        
        // Fetch up to 10,000 active events using pagination
        const activeEvents = await makeMultiPageApiRequest('/events', { closed: false }, 10000);
        
        if (!activeEvents || activeEvents.length === 0) {
            return res.end(JSON.stringify({
                totalEvents: 0,
                events: { active: 0, resolved: 0 },
                markets: { total: 0, active: 0, resolved: 0, multiOutcome: 0, binary: 0 },
                totalVolume: 0,
                lastUpdate: new Date().toISOString(),
                note: 'Limited sample in serverless mode'
            }));
        }
        
        let totalVolume = 0;
        let totalMarkets = 0;
        
        let resolvedMarketsTotal = 0;
        let multiOutcomeTotal = 0;
        
        activeEvents.forEach(event => {
            totalVolume += event.volume || 0;
            const markets = event.markets || [];
            totalMarkets += markets.length;
            
            const resolvedMarkets = markets.filter(m => m.active === false || m.closed === true);
            resolvedMarketsTotal += resolvedMarkets.length;
            
            const multiOutcomeMarkets = markets.filter(m => {
                const outcomes = m.outcomes;
                if (typeof outcomes === 'string') {
                    try {
                        const parsed = JSON.parse(outcomes);
                        return Array.isArray(parsed) && parsed.length > 2;
                    } catch {
                        return false;
                    }
                }
                return Array.isArray(outcomes) && outcomes.length > 2;
            });
            multiOutcomeTotal += multiOutcomeMarkets.length;
        });
        
        const stats = {
            totalEvents: activeEvents.length,
            events: {
                active: activeEvents.length,
                resolved: 0
            },
            markets: {
                total: totalMarkets,
                active: totalMarkets - resolvedMarketsTotal,
                resolved: resolvedMarketsTotal,
                multiOutcome: multiOutcomeTotal,
                binary: totalMarkets - multiOutcomeTotal
            },
            totalVolume: totalVolume,
            lastUpdate: new Date().toISOString(),
            note: `Sample of ${activeEvents.length} events (serverless mode)`
        };
        
        res.end(JSON.stringify(stats, null, 2));
    } catch (error) {
        console.error('Error in handleStats:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
    }
}

async function handleActive(req, res, query) {
    try {
        res.setHeader('Content-Type', 'application/json');
        
        const limit = Math.min(parseInt(query.limit) || 50, 10000); // Cap at 10,000
        
        // Fetch ALL active events first (up to 10,000) to sort by volume
        const allEvents = await makeMultiPageApiRequest('/events', { closed: false }, 10000);
        
        if (!allEvents) {
            return res.end(JSON.stringify({ count: 0, total: 0, events: [] }));
        }
        
        // Process ALL events to calculate total volume
        const processedEvents = allEvents.map(event => {
            const markets = event.markets || [];
            const activeMarkets = markets.filter(m => m.active === true && m.closed !== true);
            const resolvedMarkets = markets.filter(m => m.active === false || m.closed === true);
            const multiOutcomeMarkets = markets.filter(m => {
                const outcomes = m.outcomes;
                if (typeof outcomes === 'string') {
                    try {
                        const parsed = JSON.parse(outcomes);
                        return Array.isArray(parsed) && parsed.length > 2;
                    } catch {
                        return false;
                    }
                }
                return Array.isArray(outcomes) && outcomes.length > 2;
            });
            
            return {
                ...event,
                markets: markets,
                activeMarketsCount: activeMarkets.length,
                resolvedMarketsCount: resolvedMarkets.length,
                multiOutcomeMarketsCount: multiOutcomeMarkets.length,
                totalVolume: event.volume || 0
            };
        });
        
        // Sort ALL events by total volume (descending) and take top ones
        const sortedEvents = processedEvents
            .sort((a, b) => b.totalVolume - a.totalVolume)
            .slice(0, limit);
        
        res.end(JSON.stringify({
            count: sortedEvents.length,
            total: allEvents.length,
            events: sortedEvents
        }, null, 2));
    } catch (error) {
        console.error('Error in handleActive:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
    }
}

async function handleResolved(req, res, query) {
    try {
        res.setHeader('Content-Type', 'application/json');
        
        const limit = Math.min(parseInt(query.limit) || 10, 50);
        const events = await makeApiRequest('/events', { limit, closed: true });
        
        res.end(JSON.stringify({
            count: events?.length || 0,
            total: events?.length || 0,
            markets: events || []
        }, null, 2));
    } catch (error) {
        console.error('Error in handleResolved:', error);
        res.statusCode = 500;
        res.end(JSON.stringify({ error: error.message }));
    }
}