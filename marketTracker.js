require('dotenv').config();
const axios = require('axios');
const fs = require('fs-extra');
const cron = require('node-cron');
const path = require('path');
const WebSocket = require('ws');

class PolymarketTracker {
    constructor() {
        this.baseURL = 'https://gamma-api.polymarket.com';
        this.dataDir = './data';
        this.eventsFile = path.join(this.dataDir, 'events.json');
        this.logFile = path.join(this.dataDir, 'tracking.log');
        
        this.rateLimits = {
            general: { limit: 750, window: 10000 },
            delay: 100
        };
        
        this.requestQueue = [];
        this.isProcessingQueue = false;
        this.lastRequestTime = 0;
        
        this.events = {
            active: new Map(),
            resolved: new Map(),
            lastUpdate: null
        };
        
        this.websocket = null;
        this.wsReconnectAttempts = 0;
        this.maxReconnectAttempts = parseInt(process.env.WS_MAX_RECONNECT_ATTEMPTS) || 10;
        this.reconnectDelay = parseInt(process.env.WS_RECONNECT_DELAY) || 5000;
        this.enableRealtime = process.env.ENABLE_REALTIME === 'true';
        this.wsUrl = process.env.WEBSOCKET_URL || 'wss://ws-subscriptions-clob.polymarket.com';
        
        this.realtimeCallbacks = new Set();
        
        this.initializeData();
    }

    async initializeData() {
        try {
            // Skip file operations in serverless environment
            if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
                console.log('Running in serverless environment - skipping file operations');
                return;
            }
            
            await fs.ensureDir(this.dataDir);
            
            if (await fs.pathExists(this.eventsFile)) {
                const data = await fs.readJson(this.eventsFile);
                this.events.active = new Map(data.active || []);
                this.events.resolved = new Map(data.resolved || []);
                this.events.lastUpdate = data.lastUpdate;
                this.log(`Loaded ${this.events.active.size} active and ${this.events.resolved.size} resolved events from storage`);
            }
        } catch (error) {
            this.log(`Error initializing data: ${error.message}`);
        }
    }

    async saveData() {
        try {
            const data = {
                active: Array.from(this.events.active.entries()),
                resolved: Array.from(this.events.resolved.entries()),
                lastUpdate: this.events.lastUpdate
            };
            await fs.writeJson(this.eventsFile, data, { spaces: 2 });
            this.log(`Saved ${this.events.active.size} active and ${this.events.resolved.size} resolved events to storage`);
        } catch (error) {
            this.log(`Error saving data: ${error.message}`);
        }
    }

    log(message) {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;
        console.log(logMessage);
        
        fs.appendFile(this.logFile, logMessage + '\n').catch(err => 
            console.error('Failed to write to log file:', err)
        );
    }

    async makeRequest(url, retries = 3) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ url, retries, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessingQueue || this.requestQueue.length === 0) return;
        
        this.isProcessingQueue = true;
        
        while (this.requestQueue.length > 0) {
            const { url, retries, resolve, reject } = this.requestQueue.shift();
            
            const timeSinceLastRequest = Date.now() - this.lastRequestTime;
            if (timeSinceLastRequest < this.rateLimits.delay) {
                await new Promise(resolve => setTimeout(resolve, this.rateLimits.delay - timeSinceLastRequest));
            }
            
            try {
                this.lastRequestTime = Date.now();
                const response = await axios.get(url, {
                    timeout: 30000,
                    headers: {
                        'User-Agent': 'PolymarketTracker/1.0',
                        'Accept': 'application/json'
                    }
                });
                resolve(response.data);
            } catch (error) {
                if (retries > 0 && (error.response?.status === 429 || error.code === 'ECONNRESET')) {
                    this.log(`Rate limited or connection error, retrying... (${retries} retries left)`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    this.requestQueue.unshift({ url, retries: retries - 1, resolve, reject });
                } else {
                    this.log(`Request failed: ${error.message}`);
                    reject(error);
                }
            }
        }
        
        this.isProcessingQueue = false;
    }

    parseEventData(event) {
        const markets = (event.markets || []).map(market => {
            const tokens = market.tokens || [];
            
            // Parse outcome prices to determine winners for resolved markets
            let outcomePrices = [];
            let outcomesList = [];
            try {
                if (market.outcomePrices && typeof market.outcomePrices === 'string') {
                    outcomePrices = JSON.parse(market.outcomePrices);
                }
                if (market.outcomes && typeof market.outcomes === 'string') {
                    outcomesList = JSON.parse(market.outcomes);
                }
            } catch (e) {
                // Fallback if parsing fails
                outcomePrices = [];
                outcomesList = [];
            }

            // Build outcomes from either tokens or direct outcome data
            let outcomes = [];
            
            if (market.closed && outcomesList.length > 0 && outcomePrices.length > 0) {
                // For resolved markets, use the outcomes and outcomePrices directly
                outcomes = outcomesList.map((outcome, index) => {
                    const price = parseFloat(outcomePrices[index] || 0);
                    const winner = price > 0.9; // Winner is outcome with price closest to 1.0
                    
                    return {
                        tokenId: tokens[index]?.token_id || null,
                        outcome: outcome,
                        price: price,
                        winner: winner
                    };
                });
            } else if (tokens.length > 0) {
                // For active markets or when token data is available
                outcomes = tokens.map((token, index) => {
                    let winner = token.winner || false;
                    let price = parseFloat(token.price || 0);
                    
                    // Check if we have outcome price data for resolved markets
                    if (market.closed && outcomePrices.length > index) {
                        const outcomePrice = parseFloat(outcomePrices[index] || 0);
                        winner = outcomePrice > 0.9;
                        price = outcomePrice;
                    }
                    
                    return {
                        tokenId: token.token_id,
                        outcome: token.outcome || (outcomesList[index] || `Outcome ${index + 1}`),
                        price: price,
                        winner: winner
                    };
                });
            } else {
                // Fallback: create basic structure
                outcomes = [];
            }

            return {
                id: market.id,
                questionId: market.question_id,
                question: market.question,
                description: market.description,
                slug: market.slug,
                
                status: market.closed ? 'resolved' : 'active',
                startDate: market.start_date,
                endDate: market.end_date,
                
                volume: parseFloat(market.volume || 0),
                volumeUSD: parseFloat(market.volume_usd || 0),
                liquidity: parseFloat(market.liquidity || 0),
                
                outcomes,
                outcomesCount: outcomes.length,
                isMultiOutcome: outcomes.length > 2,
                
                // For resolved markets, identify the winning outcome
                winningOutcome: market.closed && outcomes.length > 0 ? 
                    outcomes.find(o => o.winner)?.outcome || null : null,
                
                conditionId: market.condition_id,
                fpmm: market.fpmm,
                
                polymarketURL: event.slug ? 
                    `https://polymarket.com/event/${event.slug}?tid=${Date.now()}` : 
                    null
            };
        });

        const totalVolume = markets.reduce((sum, m) => sum + (m.volumeUSD || m.volume || 0), 0);
        const totalLiquidity = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0);
        const hasActiveMarkets = markets.some(m => m.status === 'active');
        const hasResolvedMarkets = markets.some(m => m.status === 'resolved');
        const multiOutcomeMarkets = markets.filter(m => m.isMultiOutcome).length;

        return {
            id: event.id,
            ticker: event.ticker,
            slug: event.slug,
            title: event.title,
            description: event.description,
            
            status: event.closed ? 'resolved' : 'active',
            startDate: event.startDate,
            creationDate: event.creationDate,
            endDate: event.endDate,
            
            volume: parseFloat(event.volume || 0),
            volumeUSD: parseFloat(event.volume || 0),
            liquidity: parseFloat(event.liquidity || 0),
            totalVolume,
            totalLiquidity,
            
            active: event.active,
            closed: event.closed,
            archived: event.archived,
            new: event.new,
            featured: event.featured,
            restricted: event.restricted,
            
            tags: event.tags || [],
            
            markets,
            marketsCount: markets.length,
            activeMarketsCount: markets.filter(m => m.status === 'active').length,
            resolvedMarketsCount: markets.filter(m => m.status === 'resolved').length,
            multiOutcomeMarketsCount: multiOutcomeMarkets,
            
            hasActiveMarkets,
            hasResolvedMarkets,
            
            lastUpdate: new Date().toISOString(),
            
            polymarketURL: event.slug ? 
                `https://polymarket.com/event/${event.slug}?tid=${Date.now()}` : 
                null
        };
    }

    async fetchEvents(options = {}) {
        const params = new URLSearchParams({
            limit: options.limit || 100,
            offset: options.offset || 0,
            ...options.params
        });

        const url = `${this.baseURL}/events?${params}`;
        this.log(`Fetching events: ${url}`);
        
        try {
            const data = await this.makeRequest(url);
            return data;
        } catch (error) {
            this.log(`Error fetching events: ${error.message}`);
            return [];
        }
    }

    async fetchMarkets(options = {}) {
        const params = new URLSearchParams({
            limit: options.limit || 100,
            offset: options.offset || 0,
            ...options.params
        });

        const url = `${this.baseURL}/markets?${params}`;
        this.log(`Fetching markets: ${url}`);
        
        try {
            const data = await this.makeRequest(url);
            return data;
        } catch (error) {
            this.log(`Error fetching markets: ${error.message}`);
            return [];
        }
    }

    async trackActiveEvents() {
        this.log('Starting to track active events...');
        let offset = 0;
        let hasMore = true;
        let newEvents = 0;
        let updatedEvents = 0;

        while (hasMore) {
            try {
                const events = await this.fetchEvents({
                    limit: 100,
                    offset,
                    params: { closed: 'false' }
                });

                if (!events || events.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const event of events) {
                    const eventData = this.parseEventData(event);

                    if (this.events.active.has(eventData.id)) {
                        updatedEvents++;
                    } else {
                        newEvents++;
                    }

                    this.events.active.set(eventData.id, eventData);
                }

                offset += events.length;
                
                if (events.length < 100) {
                    hasMore = false;
                }

                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (error) {
                this.log(`Error tracking active events at offset ${offset}: ${error.message}`);
                break;
            }
        }

        this.log(`Active events tracking complete: ${newEvents} new, ${updatedEvents} updated`);
    }

    async trackResolvedMarkets() {
        this.log('Starting to track resolved markets...');
        let offset = 0;
        let hasMore = true;
        let newMarkets = 0;
        let updatedMarkets = 0;

        const octDate = new Date('2024-10-10');

        while (hasMore) {
            try {
                const events = await this.fetchEvents({
                    limit: 100,
                    offset,
                    params: { closed: 'true' }
                });

                if (!events || events.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const event of events) {
                    const eventEndDate = new Date(event.end_date);
                    
                    if (eventEndDate >= octDate && event.markets) {
                        const eventData = this.parseEventData(event);
                        
                        if (eventData.status === 'resolved') {
                            if (this.events.resolved.has(eventData.id)) {
                                updatedMarkets++;
                            } else {
                                newMarkets++;
                            }

                            this.events.resolved.set(eventData.id, eventData);
                            
                            if (this.events.active.has(eventData.id)) {
                                this.events.active.delete(eventData.id);
                            }
                        }
                    }
                }

                offset += events.length;
                
                if (events.length < 100) {
                    hasMore = false;
                }

                await new Promise(resolve => setTimeout(resolve, 200));

            } catch (error) {
                this.log(`Error tracking resolved markets at offset ${offset}: ${error.message}`);
                break;
            }
        }

        this.log(`Resolved markets tracking complete: ${newMarkets} new, ${updatedMarkets} updated`);
    }

    async performFullUpdate() {
        this.log('=== Starting full events update ===');
        const startTime = Date.now();

        try {
            await this.trackActiveEvents();

            this.events.lastUpdate = new Date().toISOString();
            await this.saveData();

            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            this.log(`=== Full update completed in ${duration}s ===`);
            this.printStats();

        } catch (error) {
            this.log(`Error during full update: ${error.message}`);
        }
    }

    printStats() {
        const activeEvents = this.events.active.size;
        const resolvedEvents = this.events.resolved.size;
        const totalEvents = activeEvents + resolvedEvents;

        const activeEventsArray = Array.from(this.events.active.values());
        const totalActiveMarkets = activeEventsArray.reduce((sum, e) => sum + e.marketsCount, 0);
        const totalActiveMultiOutcome = activeEventsArray.reduce((sum, e) => sum + e.multiOutcomeMarketsCount, 0);
        const totalVolume = activeEventsArray.reduce((sum, e) => sum + e.totalVolume, 0);

        this.log(`📊 Events Statistics:`);
        this.log(`   Total Events: ${totalEvents}`);
        this.log(`   Active Events: ${activeEvents}`);
        this.log(`   Total Markets in Active Events: ${totalActiveMarkets}`);
        this.log(`   Multi-outcome Markets: ${totalActiveMultiOutcome}`);
        this.log(`   Total Volume: $${totalVolume.toLocaleString()}`);
        this.log(`   Last Update: ${this.events.lastUpdate}`);
    }

    getTopMarkets(type = 'active', limit = 10) {
        const events = type === 'active' ? this.events.active : this.events.resolved;
        return Array.from(events.values())
            .sort((a, b) => b.totalVolume - a.totalVolume)
            .slice(0, limit);
    }

    getMultiOutcomeMarkets(type = 'active', limit = 10) {
        const events = type === 'active' ? this.events.active : this.events.resolved;
        return Array.from(events.values())
            .filter(e => e.multiOutcomeMarketsCount > 0)
            .sort((a, b) => b.totalVolume - a.totalVolume)
            .slice(0, limit);
    }

    startScheduler() {
        this.log('Starting market tracking scheduler...');
        
        cron.schedule('0 * * * *', () => {
            this.log('⏰ Hourly update triggered');
            this.performFullUpdate();
        });

        this.log('Scheduler started - markets will update every hour');
        
        this.startRealTimeTracking();
        
        this.performFullUpdate();
    }

    async exportData() {
        const exportData = {
            active: Array.from(this.events.active.values()),
            resolved: Array.from(this.events.resolved.values()),
            stats: {
                activeCount: this.events.active.size,
                resolvedCount: this.events.resolved.size,
                lastUpdate: this.events.lastUpdate
            }
        };

        const exportFile = path.join(this.dataDir, `export_${Date.now()}.json`);
        await fs.writeJson(exportFile, exportData, { spaces: 2 });
        this.log(`Data exported to: ${exportFile}`);
        return exportFile;
    }

    initializeWebSocket() {
        if (!this.enableRealtime) {
            this.log('Real-time WebSocket tracking disabled via configuration');
            return;
        }

        this.log('🔌 Initializing WebSocket connection for real-time market updates...');
        this.connectWebSocket();
    }

    connectWebSocket() {
        try {
            this.websocket = new WebSocket(this.wsUrl);

            this.websocket.on('open', () => {
                this.log('✅ WebSocket connected to Polymarket real-time feed');
                this.wsReconnectAttempts = 0;

                const subscriptionMessage = {
                    auth: {},
                    channel: 'market',
                    types: ['price_change', 'last_trade_price', 'book']
                };

                this.websocket.send(JSON.stringify(subscriptionMessage));
                this.log('📡 Subscribed to market channel for real-time updates');
            });

            this.websocket.on('message', (data) => {
                try {
                    const message = JSON.parse(data.toString());
                    this.handleWebSocketMessage(message);
                } catch (error) {
                    this.log(`Error parsing WebSocket message: ${error.message}`);
                }
            });

            this.websocket.on('close', (code, reason) => {
                this.log(`🔌 WebSocket disconnected: ${code} - ${reason}`);
                this.scheduleReconnect();
            });

            this.websocket.on('error', (error) => {
                this.log(`❌ WebSocket error: ${error.message}`);
                this.scheduleReconnect();
            });

        } catch (error) {
            this.log(`Failed to create WebSocket connection: ${error.message}`);
            this.scheduleReconnect();
        }
    }

    handleWebSocketMessage(message) {
        if (message.channel === 'market' && message.data) {
            const { asset_id, event_type, price, status } = message.data;

            if (event_type === 'price_change' || event_type === 'last_trade_price') {
                this.updateMarketPrice(asset_id, price);
            }

            if (status && (status === 'resolved' || status === 'closed')) {
                this.handleMarketResolution(asset_id, message.data);
            }
        }
    }

    updateMarketPrice(marketId, price) {
        for (const [eventId, eventData] of this.events.active) {
            const market = eventData.markets.find(m => m.id === marketId);
            if (market) {
                const oldPrice = market.price || 0;
                market.price = parseFloat(price);
                
                this.log(`💹 Market price update: ${market.question} - ${oldPrice} → ${price}`);
                
                this.notifyRealtimeUpdate({
                    type: 'price_update',
                    eventId,
                    marketId,
                    price: parseFloat(price),
                    oldPrice,
                    timestamp: new Date().toISOString()
                });
                break;
            }
        }
    }

    async handleMarketResolution(marketId, data) {
        for (const [eventId, eventData] of this.events.active) {
            const marketIndex = eventData.markets.findIndex(m => m.id === marketId);
            if (marketIndex !== -1) {
                const market = eventData.markets[marketIndex];
                
                this.log(`🔴 REAL-TIME MARKET RESOLVED: ${market.question}`);
                
                market.status = 'resolved';
                market.resolvedAt = new Date().toISOString();
                
                eventData.resolvedMarketsCount++;
                eventData.activeMarketsCount--;
                
                this.notifyRealtimeUpdate({
                    type: 'market_resolved',
                    eventId,
                    marketId,
                    market: market,
                    eventData: {
                        title: eventData.title,
                        activeMarketsCount: eventData.activeMarketsCount,
                        resolvedMarketsCount: eventData.resolvedMarketsCount
                    },
                    timestamp: new Date().toISOString()
                });

                await this.saveData();
                break;
            }
        }
    }

    scheduleReconnect() {
        if (this.wsReconnectAttempts >= this.maxReconnectAttempts) {
            this.log(`❌ Max WebSocket reconnection attempts (${this.maxReconnectAttempts}) reached. Giving up.`);
            return;
        }

        this.wsReconnectAttempts++;
        const delay = this.reconnectDelay * Math.pow(2, this.wsReconnectAttempts - 1);
        
        this.log(`🔄 Reconnecting WebSocket in ${delay}ms (attempt ${this.wsReconnectAttempts}/${this.maxReconnectAttempts})`);
        
        setTimeout(() => {
            this.connectWebSocket();
        }, delay);
    }

    addRealtimeCallback(callback) {
        this.realtimeCallbacks.add(callback);
    }

    removeRealtimeCallback(callback) {
        this.realtimeCallbacks.delete(callback);
    }

    notifyRealtimeUpdate(data) {
        for (const callback of this.realtimeCallbacks) {
            try {
                callback(data);
            } catch (error) {
                this.log(`Error in realtime callback: ${error.message}`);
            }
        }
    }

    startRealTimeTracking() {
        if (this.enableRealtime) {
            this.initializeWebSocket();
        } else {
            this.log('Real-time tracking disabled. Set ENABLE_REALTIME=true in .env to enable.');
        }
    }

    stopRealTimeTracking() {
        if (this.websocket) {
            this.websocket.close();
            this.websocket = null;
            this.log('🔌 WebSocket connection closed');
        }
    }
}

module.exports = PolymarketTracker;