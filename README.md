# RZE Trading Platform

A sophisticated automated stock trading platform implementing a **phased exit strategy** using the Alpaca Markets API.

## 🎯 Overview

RZE automatically executes a 4-phase exit strategy that:
- Sells positions in stages (35%, 30%, 25%, 10%) as prices rise
- Progressively moves stop losses higher to lock in profits
- After Phase 1 take-profit hits, the position cannot lose money
- Supports 24-hour trading via Alpaca's overnight trading

## 📋 Features

- **Automated Phased Exits**: Configure custom take-profit and stop-loss levels for each phase
- **Real-time Monitoring**: WebSocket-based order tracking and phase transitions
- **Multiple Templates**: Create and switch between different trading strategies
- **Notifications**: Slack and email alerts for trades, phase transitions, and errors
- **Paper & Live Trading**: Seamlessly switch between paper and live accounts
- **Comprehensive History**: Track all trades with detailed analytics

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   React Frontend │◄───►│   Node.js API   │◄───►│   PostgreSQL    │
│   (Port 3000)    │     │   (Port 3001)   │     │   (Port 5432)   │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │   Alpaca API    │
                        │   + WebSocket   │
                        └─────────────────┘
```

## 🚀 Quick Start

### Prerequisites

- Node.js 18+ or Docker
- PostgreSQL 15+ (or use Docker)
- Alpaca Trading Account (Paper and/or Live)

### Option 1: Docker (Recommended)

1. **Clone and configure**:
   ```bash
   git clone <repository-url>
   cd rze-trading-platform
   cp .env.example .env
   ```

2. **Edit `.env`** with your Alpaca API keys:
   ```env
   ALPACA_PAPER_API_KEY=your_paper_key
   ALPACA_PAPER_SECRET_KEY=your_paper_secret
   DATABASE_PASSWORD=your_secure_password
   ```

3. **Start with Docker Compose**:
   ```bash
   docker-compose up -d
   ```

4. **Run migrations**:
   ```bash
   docker-compose exec api npm run migrate
   ```

5. **Access the API** at `http://localhost:3001`

### Option 2: Manual Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Setup PostgreSQL database**:
   ```sql
   CREATE DATABASE rze_trading;
   CREATE USER rze_admin WITH PASSWORD 'your_password';
   GRANT ALL PRIVILEGES ON DATABASE rze_trading TO rze_admin;
   ```

3. **Configure environment**:
   ```bash
   cp .env.example .env
   # Edit .env with your settings
   ```

4. **Run migrations**:
   ```bash
   npm run migrate
   ```

5. **Start the server**:
   ```bash
   npm run dev   # Development with auto-reload
   npm start     # Production
   ```

## 🔧 Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TRADING_MODE` | `paper` or `live` | `paper` |
| `ALPACA_PAPER_API_KEY` | Paper trading API key | Required |
| `ALPACA_PAPER_SECRET_KEY` | Paper trading secret | Required |
| `DATABASE_HOST` | PostgreSQL host | `localhost` |
| `DATABASE_NAME` | Database name | `rze_trading` |
| `SLACK_ENABLED` | Enable Slack notifications | `false` |
| `EMAIL_ENABLED` | Enable email notifications | `false` |

### Trade Templates

Default template configuration:
```json
{
  "phases": [
    { "phase": 1, "take_profit_pct": 2, "stop_loss_pct": -2, "sell_pct": 35 },
    { "phase": 2, "take_profit_pct": 5, "stop_loss_pct": 0, "sell_pct": 30 },
    { "phase": 3, "take_profit_pct": 8, "stop_loss_pct": 2, "sell_pct": 25 },
    { "phase": 4, "take_profit_pct": 12, "stop_loss_pct": 5, "sell_pct": 10 }
  ]
}
```

## 📡 API Endpoints

### Account
- `GET /api/account` - Get account info
- `GET /api/account/positions` - Get current positions
- `GET /api/account/stats` - Get trading statistics
- `POST /api/account/sync-capital` - Sync starting capital

### Trades
- `GET /api/trades` - List all trades
- `GET /api/trades/active` - Get active trades
- `POST /api/trades` - Execute new trade
- `POST /api/trades/:id/cancel` - Cancel a trade
- `POST /api/trades/calculate` - Calculate trade details

### Templates
- `GET /api/templates` - List templates
- `POST /api/templates` - Create template
- `POST /api/templates/:id/activate` - Set active template

### History
- `GET /api/history` - Trade history with filters
- `GET /api/history/summary` - Summary statistics
- `GET /api/history/by-phase` - Stats by exit phase
- `GET /api/history/daily` - Daily P&L

## 📊 How the Strategy Works

### Phase 1 (Entry)
1. Buy order fills at entry price
2. Place OCO order: 35% shares at +2% TP / -2% SL
3. Place stop loss: 65% shares at -2%

### Phase 2 (After Phase 1 TP hits)
1. Cancel Phase 1 stop loss
2. Place OCO order: 30% shares at +5% TP / 0% SL (breakeven)
3. Place stop loss: 35% shares at breakeven
4. **Position is now risk-free!**

### Phase 3 (After Phase 2 TP hits)
1. Cancel Phase 2 stop loss
2. Place OCO order: 25% shares at +8% TP / +2% SL
3. Place stop loss: 10% shares at +2%

### Phase 4 (After Phase 3 TP hits)
1. Cancel Phase 3 stop loss
2. Place OCO order: 10% shares at +12% TP / +5% SL
3. Trade completes when TP or SL hits

## 🔔 Notifications

### Slack Setup
1. Create a Slack app at https://api.slack.com/apps
2. Add Bot Token Scopes: `chat:write`
3. Install to workspace and copy Bot Token
4. Get channel ID (right-click channel → View channel details)
5. Add to `.env`:
   ```env
   SLACK_ENABLED=true
   SLACK_BOT_TOKEN=xoxb-your-token
   SLACK_CHANNEL_ID=C0123456789
   ```

### Email Setup
```env
EMAIL_ENABLED=true
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASSWORD=your-app-password
EMAIL_TO=notifications@example.com
```

## 🚢 Deployment to Digital Ocean

### Using App Platform

1. Create a new App in Digital Ocean App Platform
2. Connect your GitHub repository
3. Configure environment variables
4. Add a managed PostgreSQL database
5. Deploy!

### Using Droplet

1. Create a Droplet (Ubuntu 22.04, 2GB+ RAM)
2. SSH into the server:
   ```bash
   ssh root@your-droplet-ip
   ```
3. Install Docker:
   ```bash
   curl -fsSL https://get.docker.com | sh
   ```
4. Clone and deploy:
   ```bash
   git clone <repository-url>
   cd rze-trading-platform
   cp .env.example .env
   nano .env  # Configure your settings
   docker-compose up -d
   ```

## 🧪 Testing

```bash
# Run tests
npm test

# Test notifications
curl -X POST http://localhost:3001/api/settings/notifications/test
```

## 📝 License

Private - All rights reserved

## 🆘 Support

For issues or questions, please open a GitHub issue or contact the development team.
