# FlowScope

Real-time order-flow charting in the browser: **footprint, liquidity heatmap, big-trade bubbles, DOM, Time & Sales, CVD, profiles**, 35+ drawing tools, a **custom indicator editor** and a **tick-by-tick backtester**. React + Node, free data sources, one command to deploy.

| Page | What it does |
|---|---|
| **Chart** `#/chart` | Candles / Footprint / Heatmap, overlays, drawing tools, paper-trading panel, DOM, T&S, watchlist, bar replay, symbol tabs |
| **Indicators** `#/indicators` | Library with live previews, JavaScript script editor with inputs, console and preview; saved scripts appear on the chart |
| **Backtest** `#/backtest` | Tick-by-tick (recorded order flow) or bar-mode backtests, trade list, equity/drawdown, analysis; trades drawn on chart |
| **Account** `#/account` | Sign up / sign in, cloud sync of settings, drawings and scripts, risk settings, big-trade thresholds, watchlist |

---

## Data sources (all free, no API keys)

| Market | Symbol | Source | Volume |
|---|---|---|---|
| Bitcoin, Ethereum, Solana, XRP, Dogecoin | `BTCUSD`, `ETHUSD`, … | **Binance + Bybit + OKX perps, aggregated** | ✅ real prints + Binance order book |
| HYPE | `HYPEUSD` | Hyperliquid | ✅ |
| Gold / Silver | `XAUUSDT`, `XAGUSDT` | Binance Futures TradFi perps | ✅ real prints + order book |
| Gold / Silver | `GOLD`, `SILVER` | Hyperliquid trade.xyz (HIP-3) perps | ✅ |
| S&P 500 / Nasdaq-100 | `SP500`, `NDX` | Hyperliquid trade.xyz perps | ✅ |
| WTI / Brent | `WTI`, `BRENT` | Hyperliquid trade.xyz perps | ✅ |
| EUR/USD, DAX, Nikkei | `EURUSD`, `GER40`, `JP225` | biquote.io REST (price only) | ❌ labelled “price only” |
| Demo | `DEMO` | Built-in simulator | always available |

**What “real volume” means here:** these are real trades on those venues with the aggressor side. It is **not CME volume** (GC, ES, NQ). CME order flow needs a paid feed (Rithmic / dxFeed / CQG) — adapters plug into `server/src/feeds/exchanges.ts`.

Older bars come from exchange candles (no footprint). Footprint / heatmap history builds up from the moment the server starts recording, so **run the server 24/7** (see Deploy).

---

## Quick start (local)

Requires **Node.js 22.6+** (Node 24 recommended).

```bash
npm install
npm run build        # builds the web app into web/dist
npm start            # http://localhost:8080
```

### Development (hot reload)

```bash
npm run dev:server   # API + data gateway on :8080
npm run dev:web      # Vite on http://localhost:5173 (proxies /api and /ws)
```

The server runs TypeScript directly with Node’s type stripping — no build step. Its only optional dependency is `mongodb`.

---

## Deploy (VPS, Docker) — recommended

The server must stay online to record ticks and heatmap history, so use an always-on host (any small VPS: Hetzner, DigitalOcean, Lightsail, Oracle Free Tier).

```bash
cp .env.example .env          # set JWT_SECRET to a long random string
docker compose up -d --build  # FlowScope + MongoDB on :8080
```

Put it behind HTTPS (Caddy example — WebSockets work automatically):

```
flowscope.webcraftlabs.in {
  reverse_proxy localhost:8080
}
```

With Nginx, add `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` for `/ws`.

**Split hosting (optional):** host `web/` on Vercel/Netlify with `VITE_API_URL=https://api.yourdomain` and set `CORS_ORIGIN=https://yourdomain` on the server.

**Exchange access:** some venues are geo-restricted. If the feed pill shows “Venue offline”, check that the server’s region can reach `fstream.binance.com`, `stream.bybit.com`, `ws.okx.com` and `api.hyperliquid.xyz`.

---

## Environment

See `.env.example`. Key ones:

| Var | Default | Meaning |
|---|---|---|
| `MONGO_URL` | – | Enables persistence (ticks kept `RETAIN_DAYS`, users in Mongo). Without it: memory + `data/db.json` |
| `RECORD` | BTC, ETH, metals, indices, DEMO | Markets recorded from boot |
| `HISTORY_HOURS` | 8 | In-memory tick history per market |
| `JWT_SECRET` | auto | Login token secret |

---

## Using it

**Chart shortcuts:** `/` or `Ctrl+K` symbol search · `Alt+T` trend · `Alt+H` horizontal · `Alt+V` vertical · `Alt+F` fib · `Alt+R` rectangle · `Alt+L` long · `Alt+S` short · `Esc` cancel · `Del` delete · `Ctrl+Z / Ctrl+Y` undo/redo · `Ctrl+D` clone · wheel = zoom time · `Ctrl`+wheel or drag price axis = zoom price · double-click = go live · right-click = context menu.

**Drawing tools (35):** trend, ray, extended, horizontal line/ray, vertical, cross, parallel & regression channels · Fib retracement, extension, channel, time zones, speed fan, circles, arcs · Pitchfork, Schiff, Gann fan, Gann box · rectangle, ellipse, triangle, path, brush, highlighter, arrow · **Long / Short position** (R:R, $ risk from account size × risk %, live “Target hit / Stopped”) · price, date and date-price ranges · text, callout, price label, arrow marks · **Anchored VWAP, fixed-range volume profile, imbalance zone**. Magnet snaps to OHLC (hold `Ctrl` to bypass).

**Custom indicators:** a script receives `d` (series: `open high low close volume buy sell delta cvd vwap bigBuy bigSell time`), `ta` (helpers) and `input`, and returns plots `{ name, values, color, pane: 'main'|'sub', type: 'line'|'hist'|'dots' }`. Scripts run only in your own browser.

**Backtest rules:** return `1` (long), `-1` (short) or `0` for each closed bar `i`. Saved indicators are available as `ind['Name']`. Entries fill on the next tick (no look-ahead); stops/targets are checked on every trade in tick mode.

**Paper trading:** the trading panel is simulated only — no orders are sent anywhere.

---

## Project structure

```
server/src/
  index.ts            HTTP API, static hosting, WebSocket endpoint
  wsserver.ts         dependency-free WebSocket server
  market.ts           per-symbol hub: aggregation, compressed ticks, book, heatmap, broadcast
  symbols.ts          symbol catalog (add markets here)
  history.ts          exchange candles (Binance, Bybit, Hyperliquid)
  feeds/exchanges.ts  Binance / Bybit / OKX / Hyperliquid / REST adapters
  feeds/sim.ts        DEMO simulator
  store/              MongoDB (optional) + JSON file storage
  auth.ts             scrypt passwords + HS256 tokens
web/src/
  chart/engine.ts     canvas chart engine (candles, footprint, heatmap, overlays, interaction)
  chart/drawings.ts   all drawing tools (shared render + hit-test)
  data/               WebSocket client, bar/footprint builder
  pages/              Chart, Indicators, Backtest, Account
  components/         toolbar, status bar, trading panel, DOM, T&S, watchlist, search
  indicators/         script runtime + built-in library
  backtest/engine.ts  tick & bar backtester
```

**Add a market:** add an entry to `server/src/symbols.ts` (any Binance futures symbol, Bybit linear symbol, OKX swap or Hyperliquid coin such as `xyz:TSLA`) and restart.

---

FlowScope is an analysis tool, not financial advice. Respect each exchange’s API terms and rate limits.
