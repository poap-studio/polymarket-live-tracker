# 🎯 Polymarket Live Tracker

A comprehensive real-time tracking application for Polymarket events and markets, featuring winner detection, market analysis, and live updates.

## ✨ Features

- **Real-time Market Tracking**: Live updates of Polymarket events and markets
- **Winner Detection**: Automatic detection and display of winning outcomes for resolved markets
- **Volume Analysis**: Track trading volumes and market performance
- **Interactive Dashboard**: Clean web interface with filtering and search capabilities
- **Server-Sent Events**: Real-time browser notifications for market resolutions
- **Winner Analytics**: Track and analyze market winners with blockchain integration
- **Export Functionality**: Export market data and winner information

## 🚀 Getting Started

### Prerequisites

- Node.js (v14 or higher)
- npm or yarn
- Polymarket account with API access

### Installation

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd polymarket-tracker
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   ```bash
   cp .env.example .env
   ```

4. **Configure your credentials in `.env`**
   ```env
   # Your private key (without 0x prefix)
   PRIVATE_KEY=your_private_key_here
   
   # Your funder address from Polymarket profile
   FUNDER_ADDRESS=your_funder_address_here
   
   # Signature type (0 = EOA, 1 = Magic/Email, 2 = Browser Wallet)
   SIGNATURE_TYPE=0
   ```

5. **Start the application**
   ```bash
   npm start
   ```

6. **Open your browser**
   ```
   http://localhost:3000
   ```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PRIVATE_KEY` | Your wallet private key | Required |
| `FUNDER_ADDRESS` | Your Polymarket funder address | Required |
| `SIGNATURE_TYPE` | Wallet signature type (0-2) | 0 |
| `POLYGON_RPC_URL` | Polygon RPC endpoint | https://polygon-rpc.com |
| `MARKETS_API_URL` | Polymarket API endpoint | https://gamma-api.polymarket.com |
| `PORT` | Server port | 3000 |
| `ENABLE_REALTIME` | Enable real-time updates | true |

### API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Web dashboard |
| `GET /stats` | Market statistics |
| `GET /active?limit=50` | Active markets |
| `GET /resolved?limit=50` | Resolved markets |
| `GET /winners?marketId=123` | Market winners |
| `GET /winner-stats` | Winner statistics |
| `GET /track-winners?marketId=123&outcome=YES` | Track market winners |
| `GET /events` | Server-Sent Events stream |
| `GET /export` | Export all data |

## 📊 Dashboard Features

### Market Display
- **Volume-based color coding**: Green (>$100k), Yellow (>$10k), Gray (<$10k)
- **Real-time countdowns**: Live countdown timers for market end dates
- **Winner badges**: Green badges showing winning outcomes for resolved markets
- **Market filtering**: Search and filter markets by various criteria

### Winner Tracking
- **Automatic winner detection**: Uses Polymarket's outcome prices to determine winners
- **Blockchain integration**: Track actual token holders and payouts
- **Winner analytics**: Statistics and leaderboards for market winners

### Real-time Updates
- **Live market resolutions**: Instant notifications when markets resolve
- **Auto-refresh**: Periodic updates every 5 minutes
- **WebSocket integration**: Real-time price and status updates

## 🔒 Security

This application handles sensitive cryptographic keys. Follow these security practices:

### Local Development
- Never commit your `.env` file to version control
- Use strong, unique private keys
- Regularly rotate API keys and credentials

### Production Deployment
- Use environment variables for sensitive data
- Implement proper access controls
- Use HTTPS for all communications
- Consider using hardware wallets for production keys

## 🏗️ Architecture

```
├── index.js              # Main application server
├── marketTracker.js      # Core market tracking logic
├── winnerTracker.js      # Winner detection and blockchain tracking
├── public/
│   └── index.html        # Web dashboard
├── data/                 # Local data storage
└── .env                  # Environment configuration (not in git)
```

### Key Components

- **PolymarketTracker**: Main class for fetching and tracking market data
- **PolymarketWinnerTracker**: Specialized class for winner detection and blockchain analysis
- **Web Server**: Express-like HTTP server with SSE support
- **Real-time Engine**: WebSocket connections for live updates

## 🔍 Market Winner Detection

The application uses multiple data sources to determine market winners:

1. **Outcome Prices**: Markets with price > 0.9 are considered winners
2. **Token Data**: ERC-1155 token transfers for precise holder tracking
3. **API Integration**: Direct integration with Polymarket's resolution data

## 📈 Analytics

### Market Statistics
- Total events and markets tracked
- Volume analysis and trending
- Resolution rates and timing
- Multi-outcome vs binary market distribution

### Winner Analytics
- Total payouts and winner counts
- Top winners across all markets
- Average payout calculations
- Market-specific winner breakdowns

## 🐛 Troubleshooting

### Common Issues

**Port already in use**
```bash
lsof -ti:3000 | xargs kill
```

**Environment variables not loading**
- Ensure `.env` file exists in project root
- Check for syntax errors in `.env` file
- Restart the application after changes

**API rate limiting**
- Increase `REQUEST_DELAY_MS` in `.env`
- Check your Polymarket API limits
- Implement exponential backoff

**WebSocket connection issues**
- Check firewall settings
- Verify WebSocket URL in configuration
- Monitor connection logs in browser console

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

This project is licensed under the ISC License.

## 🚨 Disclaimer

This is an educational/analytical tool. Trading involves risk. Always do your own research and never trade with funds you can't afford to lose.

## 📞 Support

For issues and questions:
- Create an issue in the GitHub repository
- Check the troubleshooting section above
- Review Polymarket's official documentation