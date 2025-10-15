const { ethers } = require('ethers');

class PolymarketWinnerTracker {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com');
        
        // Polymarket CTF Exchange Contract on Polygon
        this.ctfExchangeAddress = '0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e';
        
        // ERC1155 ABI for tracking transfers
        this.erc1155ABI = [
            "event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)",
            "event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)",
            "function balanceOf(address account, uint256 id) view returns (uint256)",
            "function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])"
        ];
        
        this.contract = new ethers.Contract(this.ctfExchangeAddress, this.erc1155ABI, this.provider);
        
        // Store winner data
        this.marketWinners = new Map(); // marketId -> { winners: [], totalPayout: 0, winningOutcome: '' }
        this.holderSnapshots = new Map(); // positionId -> Map(address -> balance)
    }

    async trackMarketWinners(marketId, winningOutcome, resolutionBlockNumber = null) {
        try {
            console.log(`🏆 Tracking winners for market ${marketId}, outcome: ${winningOutcome}`);
            
            // Get the position ID for the winning outcome token
            const positionId = await this.getPositionId(marketId, winningOutcome);
            
            if (!positionId) {
                console.log(`❌ Could not determine position ID for market ${marketId}`);
                return null;
            }

            // Get block number for resolution (current if not specified)
            const blockNumber = resolutionBlockNumber || await this.provider.getBlockNumber();
            
            // Build snapshot of token holders at resolution time
            const holders = await this.buildHolderSnapshot(positionId, blockNumber);
            
            // Calculate total payout
            const totalPayout = Array.from(holders.values()).reduce((sum, balance) => sum + balance, 0);
            
            const winnerData = {
                marketId,
                winningOutcome,
                positionId: positionId.toString(),
                resolutionBlock: blockNumber,
                winners: Array.from(holders.entries()).map(([address, balance]) => ({
                    address,
                    winningTokens: balance,
                    payoutUSDC: balance // 1:1 ratio, each winning token = 1 USDC
                })),
                totalPayout,
                winnerCount: holders.size,
                timestamp: new Date().toISOString()
            };

            this.marketWinners.set(marketId, winnerData);
            
            console.log(`🎉 Found ${holders.size} winners for market ${marketId}`);
            console.log(`💰 Total payout: ${totalPayout} USDC`);
            
            return winnerData;
            
        } catch (error) {
            console.error(`Error tracking winners for market ${marketId}:`, error);
            return null;
        }
    }

    async buildHolderSnapshot(positionId, blockNumber) {
        try {
            const holders = new Map();
            
            // Query all transfer events for this position ID up to the resolution block
            const filter = this.contract.filters.TransferSingle(null, null, null, positionId, null);
            
            // Get events in chunks to avoid RPC limits
            const fromBlock = 0; // Could optimize by getting market creation block
            const chunkSize = 10000;
            
            for (let start = fromBlock; start <= blockNumber; start += chunkSize) {
                const end = Math.min(start + chunkSize - 1, blockNumber);
                
                console.log(`📊 Querying transfers for position ${positionId}, blocks ${start}-${end}`);
                
                const events = await this.contract.queryFilter(filter, start, end);
                
                // Process transfer events to build balance snapshot
                for (const event of events) {
                    const { from, to, value } = event.args;
                    const amount = parseInt(value.toString());
                    
                    // Subtract from sender (except mint from zero address)
                    if (from !== ethers.ZeroAddress) {
                        const currentBalance = holders.get(from) || 0;
                        const newBalance = currentBalance - amount;
                        if (newBalance <= 0) {
                            holders.delete(from);
                        } else {
                            holders.set(from, newBalance);
                        }
                    }
                    
                    // Add to receiver (except burn to zero address)
                    if (to !== ethers.ZeroAddress) {
                        const currentBalance = holders.get(to) || 0;
                        holders.set(to, currentBalance + amount);
                    }
                }
            }
            
            // Filter out zero balances
            const activeHolders = new Map();
            for (const [address, balance] of holders) {
                if (balance > 0) {
                    activeHolders.set(address, balance);
                }
            }
            
            return activeHolders;
            
        } catch (error) {
            console.error(`Error building holder snapshot for position ${positionId}:`, error);
            return new Map();
        }
    }

    async getPositionId(marketId, outcome) {
        // This would need to be implemented based on how your system maps
        // market IDs to Polymarket position IDs. Options:
        
        // Option 1: If you store position IDs in market data
        // return market.outcomes.find(o => o.outcome === outcome)?.positionId;
        
        // Option 2: Calculate from conditionId (would need market's conditionId)
        // const conditionId = await this.getConditionId(marketId);
        // return this.calculatePositionId(conditionId, outcome);
        
        // Option 3: Query from Polymarket API
        // return await this.getPositionIdFromAPI(marketId, outcome);
        
        // For now, return null - this needs market-specific implementation
        console.log(`⚠️  Position ID mapping not implemented for market ${marketId}, outcome ${outcome}`);
        return null;
    }

    async verifyWinnerPayout(marketId, address) {
        try {
            const winnerData = this.marketWinners.get(marketId);
            if (!winnerData) {
                return { verified: false, reason: 'Market winner data not found' };
            }

            const winner = winnerData.winners.find(w => w.address.toLowerCase() === address.toLowerCase());
            if (!winner) {
                return { verified: false, reason: 'Address not found in winners list' };
            }

            // Could verify on-chain if position tokens were redeemed
            return {
                verified: true,
                winningTokens: winner.winningTokens,
                payoutUSDC: winner.payoutUSDC,
                marketId,
                winningOutcome: winnerData.winningOutcome
            };
            
        } catch (error) {
            console.error(`Error verifying winner payout:`, error);
            return { verified: false, reason: 'Verification error' };
        }
    }

    getMarketWinners(marketId) {
        return this.marketWinners.get(marketId) || null;
    }

    getAllMarketWinners() {
        return Object.fromEntries(this.marketWinners);
    }

    getTopWinners(limit = 10) {
        const allWinners = [];
        
        for (const [marketId, data] of this.marketWinners) {
            for (const winner of data.winners) {
                allWinners.push({
                    ...winner,
                    marketId,
                    winningOutcome: data.winningOutcome
                });
            }
        }
        
        return allWinners
            .sort((a, b) => b.payoutUSDC - a.payoutUSDC)
            .slice(0, limit);
    }

    async getWinnerStats() {
        const stats = {
            totalMarketsTracked: this.marketWinners.size,
            totalWinners: 0,
            totalPayouts: 0,
            averageWinnerPayout: 0,
            topWinner: null
        };

        for (const [marketId, data] of this.marketWinners) {
            stats.totalWinners += data.winnerCount;
            stats.totalPayouts += data.totalPayout;
        }

        if (stats.totalWinners > 0) {
            stats.averageWinnerPayout = stats.totalPayouts / stats.totalWinners;
        }

        const topWinners = this.getTopWinners(1);
        if (topWinners.length > 0) {
            stats.topWinner = topWinners[0];
        }

        return stats;
    }

    // Helper method to format addresses for display
    formatAddress(address) {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    }

    // Export winner data for external use
    exportWinnerData() {
        return {
            marketWinners: Object.fromEntries(this.marketWinners),
            exportedAt: new Date().toISOString(),
            totalMarkets: this.marketWinners.size
        };
    }
}

module.exports = PolymarketWinnerTracker;