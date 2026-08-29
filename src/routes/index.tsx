import { useCallback, useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, ChevronDown, CircleHelp, Clock3, ExternalLink, Gauge, GitBranch, Info, LayoutGrid, RefreshCw, Search, Settings2, SlidersHorizontal, Star, WalletCards, Zap } from "lucide-react";

import { Button } from "@/components/ui/button";

type Instrument = {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  symbolType?: string;
};

type Ticker = {
  symbol: string;
  bid1Price: string;
  ask1Price: string;
  lastPrice: string;
  price24hPcnt: string;
  turnover24h: string;
};

type MarketResponse = { fetchedAt: string; instruments: Instrument[]; tickers: Ticker[] };
type Leg = { symbol: string; from: string; to: string; side: "Sell" | "Buy"; price: number };
type Opportunity = { id: string; assets: string[]; legs: Leg[]; gross: number; net: number; volume: number; stock: boolean };

const REFRESH_MS = 10_000;
const DEFAULT_FEE = 0.001;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Loopline — Bybit Arbitrage Scanner" },
      { name: "description", content: "Live triangular arbitrage scanner for Bybit spot and xStocks market data." },
      { property: "og:title", content: "Loopline — Bybit Arbitrage Scanner" },
      { property: "og:description", content: "Live triangular arbitrage scanner for Bybit spot and xStocks market data." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Scanner,
});

function parseNumber(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatPrice(value: number) {
  if (!value) return "—";
  if (value >= 1000) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
  return value.toLocaleString(undefined, { maximumSignificantDigits: 5 });
}

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(3)}%`;
}

function buildOpportunities(instruments: Instrument[], tickers: Ticker[], fee: number) {
  const instrumentMap = new Map(instruments.map((item) => [item.symbol, item]));
  const quoteMap = new Map(tickers.map((item) => [item.symbol, item]));
  const assets = new Set<string>();
  for (const item of instruments) {
    if (item.status === "Trading" && quoteMap.has(item.symbol)) {
      assets.add(item.baseCoin);
      assets.add(item.quoteCoin);
    }
  }

  const convert = (from: string, to: string, amount: number): { amount: number; leg: Leg } | null => {
    const direct = quoteMap.get(`${from}${to}`);
    if (direct && parseNumber(direct.bid1Price) > 0) {
      return { amount: amount * parseNumber(direct.bid1Price), leg: { symbol: direct.symbol, from, to, side: "Sell", price: parseNumber(direct.bid1Price) } };
    }
    const inverse = quoteMap.get(`${to}${from}`);
    if (inverse && parseNumber(inverse.ask1Price) > 0) {
      return { amount: amount / parseNumber(inverse.ask1Price), leg: { symbol: inverse.symbol, from, to, side: "Buy", price: parseNumber(inverse.ask1Price) } };
    }
    return null;
  };

  const starts = ["USDT", "USDC", "BTC", "ETH"].filter((asset) => assets.has(asset));
  const candidates: Opportunity[] = [];
  for (const start of starts) {
    const firstAssets = [...assets].filter((asset) => asset !== start && asset.length <= 8);
    for (const middle of firstAssets) {
      const secondAssets = [...assets].filter((asset) => asset !== start && asset !== middle && asset.length <= 8);
      for (const end of secondAssets) {
        const one = convert(start, middle, 1);
        const two = one ? convert(middle, end, one.amount) : null;
        const three = two ? convert(end, start, two.amount) : null;
        if (!one || !two || !three) continue;
        const symbols = [one.leg.symbol, two.leg.symbol, three.leg.symbol];
        const unique = new Set(symbols);
        if (unique.size !== 3) continue;
        const gross = three.amount - 1;
        const net = (1 + gross) * Math.pow(1 - fee, 3) - 1;
        const stock = [one, two, three].some((item) => instrumentMap.get(item.leg.symbol)?.symbolType === "xstocks");
        const volume = Math.min(...symbols.map((symbol) => parseNumber(quoteMap.get(symbol)?.turnover24h ?? "0")));
        if (volume < 1000) continue;
        candidates.push({ id: `${start}-${middle}-${end}`, assets: [start, middle, end, start], legs: [one.leg, two.leg, three.leg], gross, net, volume, stock });
      }
    }
  }
  const deduped = new Map<string, Opportunity>();
  for (const candidate of candidates) {
    const key = [...candidate.legs].map((leg) => leg.symbol).sort().join("/");
    if (!deduped.has(key) || (deduped.get(key)?.net ?? -Infinity) < candidate.net) deduped.set(key, candidate);
  }
  return [...deduped.values()].sort((a, b) => b.net - a.net);
}

function Asset({ name }: { name: string }) {
  return <span className="asset-badge" title={name}>{name.replace("USDT", "₮").replace("USDC", "$ ").slice(0, 4)}</span>;
}

function Scanner() {
  const [market, setMarket] = useState<MarketResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [minProfit, setMinProfit] = useState("0.10");
  const [fee, setFee] = useState(DEFAULT_FEE);
  const [assetFilter, setAssetFilter] = useState("All assets");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"opportunities" | "markets">("opportunities");

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/public/bybit-market");
      const data = await response.json() as MarketResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Market data unavailable");
      setMarket(data);
      setError(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Market data unavailable");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void scan(); }, [scan]);
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void scan(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [autoRefresh, scan]);

  const opportunities = useMemo(() => market ? buildOpportunities(market.instruments, market.tickers, fee) : [], [market, fee]);
  const threshold = parseNumber(minProfit) / 100;
  const filtered = opportunities.filter((item) => item.net >= threshold && (assetFilter === "All assets" || (assetFilter === "xStocks" ? item.stock : !item.stock)) && (!query || item.assets.join(" ").toLowerCase().includes(query.toLowerCase())));
  const xstocks = market?.instruments.filter((item) => item.symbolType === "xstocks") ?? [];
  const cryptoInstruments = market?.instruments.filter((item) => item.symbolType !== "xstocks" && item.status === "Trading") ?? [];
  const best = opportunities[0];
  const lastUpdated = market ? new Date(market.fetchedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  return (
    <main className="app-shell relative overflow-hidden">
      <div className="app-grid absolute inset-0" />
      <header className="topbar sticky top-0 z-20">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-5 py-4 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="brand-mark flex h-9 w-9 items-center justify-center rounded-md"><GitBranch className="h-5 w-5" /></div>
            <div><div className="font-mono text-[15px] font-bold tracking-[0.02em] text-foreground">LOOPLINE</div><div className="hidden text-[10px] uppercase tracking-[0.16em] text-muted-foreground sm:block">arbitrage intelligence</div></div>
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <div className="hidden items-center gap-2 md:flex"><span className={`status-dot ${loading ? "pulse-dot" : ""}`} />{loading ? "Syncing" : "Live"}<span className="text-border">·</span> Bybit public API</div>
            <Button variant="outline" size="sm" onClick={() => void scan()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} /> <span className="hidden sm:inline">Refresh</span></Button>
          </div>
        </div>
      </header>

      <div className="relative mx-auto max-w-[1440px] px-5 pb-12 pt-8 lg:px-8 lg:pt-12">
        <section className="mb-9 flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div><div className="eyebrow mb-3 flex items-center gap-2"><span className="h-px w-6 bg-primary" /> Market scanner / spot</div><h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">Find the gap<br /><span className="text-primary">before it closes.</span></h1><p className="mt-4 max-w-xl text-sm leading-6 text-muted-foreground">Triangular routes across Bybit spot markets, including the newly listed xStocks instruments.</p></div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground"><Clock3 className="h-4 w-4 text-primary" /> Updated {lastUpdated}<span className="text-border">·</span>10s cadence</div>
        </section>

        <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Metric label="Live instruments" value={market ? market.instruments.length.toLocaleString() : "—"} detail="Bybit spot" icon={<LayoutGrid />} />
          <Metric label="xStocks listed" value={xstocks.length ? xstocks.length.toString() : "—"} detail="Spot symbols" icon={<WalletCards />} tone="warning" />
          <Metric label="Routes above floor" value={filtered.length.toString()} detail={`${minProfit}% net threshold`} icon={<Zap />} tone="positive" />
          <Metric label="Best net edge" value={best ? formatPercent(best.net) : "—"} detail={best ? best.assets.slice(0, 3).join(" → ") : "Waiting for quotes"} icon={<Gauge />} tone="coral" />
        </section>

        <section className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
          <div className="panel min-w-0 rounded-lg">
            <div className="flex flex-col gap-4 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex items-center gap-3"><h2 className="text-lg font-semibold text-foreground">Opportunity feed</h2><span className="rounded-full bg-accent px-2 py-1 font-mono text-[10px] text-primary">{filtered.length} FOUND</span></div><p className="mt-1 text-xs text-muted-foreground">Executable cycles after estimated fees</p></div>
              <div className="flex gap-1 rounded-md bg-surface-subtle p-1"><button className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${tab === "opportunities" ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setTab("opportunities")}>Routes</button><button className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${tab === "markets" ? "bg-accent text-primary" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setTab("markets")}>Markets</button></div>
            </div>
            {tab === "opportunities" ? <OpportunityTable opportunities={filtered} loading={loading} /> : <MarketTable instruments={market?.instruments ?? []} tickers={market?.tickers ?? []} query={query} />}
          </div>

          <aside className="panel rounded-lg p-5">
            <div className="mb-6 flex items-center justify-between"><div><div className="eyebrow">Scanner controls</div><h2 className="mt-1 text-lg font-semibold text-foreground">Tune the signal</h2></div><SlidersHorizontal className="h-5 w-5 text-muted-foreground" /></div>
            <div className="space-y-5">
              <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Minimum net profit <CircleHelp className="h-3.5 w-3.5 text-muted-foreground" /></span><div className="relative"><input className="input-control mono h-10 w-full rounded-md px-3 pr-10 text-sm" type="number" min="0" step="0.05" value={minProfit} onChange={(event) => setMinProfit(event.target.value)} /><span className="absolute right-3 top-2.5 font-mono text-xs text-muted-foreground">%</span></div></label>
              <label className="block"><span className="mb-2 flex items-center justify-between text-xs font-medium text-foreground">Fee per leg <span className="font-mono text-muted-foreground">{(fee * 100).toFixed(2)}%</span></span><input className="w-full accent-primary" type="range" min="0" max="0.003" step="0.0001" value={fee} onChange={(event) => setFee(Number(event.target.value))} /></label>
              <label className="block"><span className="mb-2 block text-xs font-medium text-foreground">Asset universe</span><select className="select-control h-10 w-full rounded-md px-3 text-sm" value={assetFilter} onChange={(event) => setAssetFilter(event.target.value)}><option>All assets</option><option>Crypto only</option><option>xStocks</option></select></label>
              <div className="flex items-center justify-between border-t border-border pt-5"><div><div className="text-sm font-medium text-foreground">Auto refresh</div><div className="mt-1 text-xs text-muted-foreground">Every 10 seconds</div></div><button aria-label="Toggle auto refresh" className="switch-track flex h-5 w-9 cursor-pointer items-center rounded-full p-0.5 transition-colors" data-on={autoRefresh} onClick={() => setAutoRefresh((value) => !value)}><span className="switch-thumb h-4 w-4 rounded-full transition-transform" /></button></div>
              <Button className="scan-button w-full" onClick={() => void scan()} disabled={loading}><RefreshCw className={loading ? "animate-spin" : ""} /> Scan now</Button>
            </div>
            <div className="mt-6 flex gap-2 rounded-md border border-warning/25 bg-warning/10 p-3 text-[11px] leading-4 text-warning"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" /><span>xStocks are available as USDT pairs. Cross-stock routes require a direct stock/stock market, which Bybit does not currently list.</span></div>
          </aside>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="panel rounded-lg p-5"><div className="mb-5 flex items-start justify-between"><div><div className="eyebrow">Coverage map</div><h2 className="mt-1 text-lg font-semibold text-foreground">What Bybit is exposing</h2></div><ExternalLink className="h-4 w-4 text-muted-foreground" /></div><div className="grid gap-3 sm:grid-cols-2"><Coverage label="Crypto spot" value={cryptoInstruments.length} caption="Tradable instruments" tone="positive" /><Coverage label="xStocks" value={xstocks.length} caption="Tokenized stock pairs" tone="warning" /><Coverage label="Stock / stock links" value={0} caption="Direct pairs in spot" tone="coral" /><Coverage label="Quote currencies" value={new Set((market?.instruments ?? []).map((item) => item.quoteCoin)).size || "—"} caption="Available for routing" tone="neutral" /></div></div>
          <div className="panel rounded-lg p-5"><div className="mb-5 flex items-start justify-between"><div><div className="eyebrow">Market pulse</div><h2 className="mt-1 text-lg font-semibold text-foreground">Signal health</h2></div><Search className="h-4 w-4 text-muted-foreground" /></div><div className="mb-5 flex items-end justify-between"><div><div className="font-mono text-3xl font-semibold text-primary">{market ? "NOMINAL" : "—"}</div><div className="mt-1 text-xs text-muted-foreground">Public feed connection</div></div><div className="text-right"><div className="font-mono text-sm text-foreground">{market?.tickers.length ?? "—"}</div><div className="text-xs text-muted-foreground">quotes parsed</div></div></div><div className="h-16 overflow-hidden"><svg viewBox="0 0 520 64" preserveAspectRatio="none" className="h-full w-full"><path className="sparkline" d="M0 48 C22 46 24 35 44 39 S70 27 91 34 S120 52 142 40 S166 44 182 26 S208 35 226 32 S248 46 266 31 S288 21 308 30 S337 46 354 26 S376 31 396 17 S423 35 438 27 S466 36 482 17 S501 18 520 7" /></svg></div></div>
        </section>
        {error && <div className="mt-6 rounded-md border border-coral/30 bg-coral/10 p-3 text-sm text-coral">{error}. Try refreshing to reconnect.</div>}
        <footer className="mt-8 flex flex-col justify-between gap-2 border-t border-border pt-5 text-[11px] text-muted-foreground sm:flex-row"><span>LOOPLINE / public market data only</span><span>Execution is not included · Verify liquidity, fees, and slippage before trading</span></footer>
      </div>
    </main>
  );
}

function Metric({ label, value, detail, icon, tone = "default" }: { label: string; value: string; detail: string; icon: React.ReactNode; tone?: string }) {
  return <div className="panel rounded-lg p-4"><div className="mb-4 flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className={`text-${tone === "default" ? "muted-foreground" : tone} [&_svg]:h-4 [&_svg]:w-4`}>{icon}</span></div><div className="font-mono text-2xl font-semibold text-foreground">{value}</div><div className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</div></div>;
}

function OpportunityTable({ opportunities, loading }: { opportunities: Opportunity[]; loading: boolean }) {
  if (loading && opportunities.length === 0) return <div className="flex min-h-[300px] items-center justify-center gap-3 text-sm text-muted-foreground"><RefreshCw className="h-4 w-4 animate-spin text-primary" />Reading live order books…</div>;
  if (opportunities.length === 0) return <div className="flex min-h-[300px] flex-col items-center justify-center px-6 text-center"><div className="mb-3 rounded-full bg-accent p-3 text-primary"><Search className="h-5 w-5" /></div><h3 className="font-medium text-foreground">No routes above threshold</h3><p className="mt-1 max-w-sm text-xs leading-5 text-muted-foreground">The scanner found no net-positive cycle at the current fee and profit settings. Lower the floor to inspect the live market.</p></div>;
  return <div className="table-scroll"><div className="min-w-[690px]"><div className="grid grid-cols-[1.2fr_.7fr_.7fr_.7fr_30px] gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"><span>Route</span><span>Net edge</span><span>Gross</span><span>Liquidity</span><span /></div>{opportunities.slice(0, 8).map((item, index) => { const [start, middle, end] = item.assets; if (!start || !middle || !end) return null; return <div className="data-row grid grid-cols-[1.2fr_.7fr_.7fr_.7fr_30px] items-center gap-4 px-5 py-4" key={item.id}><div className="flex items-center gap-2"><span className="w-4 font-mono text-[10px] text-muted-foreground">{String(index + 1).padStart(2, "0")}</span><div className="flex items-center gap-1.5"><Asset name={start} /><span className="route-arrow">→</span><Asset name={middle} /><span className="route-arrow">→</span><Asset name={end} /><span className="route-arrow">→</span><Asset name={start} /></div>{item.stock && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] font-medium text-warning">xS</span>}</div><span className="font-mono text-sm font-semibold text-primary">{formatPercent(item.net)}</span><span className="font-mono text-xs text-muted-foreground">{formatPercent(item.gross)}</span><span className="font-mono text-xs text-muted-foreground">${(item.volume / 1000000).toFixed(1)}m</span><Button variant="ghost" size="icon" aria-label={`Inspect ${item.id}`}><ChevronDown className="h-4 w-4 -rotate-90" /></Button></div>; })}</div></div>;
}

function MarketTable({ instruments, tickers, query }: { instruments: Instrument[]; tickers: Ticker[]; query: string }) {
  const rows = instruments.filter((item) => !query || item.symbol.toLowerCase().includes(query.toLowerCase())).slice(0, 16);
  const quotes = new Map(tickers.map((item) => [item.symbol, item]));
  return <div className="table-scroll"><div className="min-w-[620px]"><div className="flex items-center gap-3 border-b border-border px-5 py-4"><Search className="h-4 w-4 text-muted-foreground" /><input className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" placeholder="Search symbol" value={query} readOnly /></div><div className="grid grid-cols-[1.2fr_.8fr_.8fr_.6fr] gap-4 px-5 py-3 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground"><span>Symbol</span><span>Bid</span><span>Ask</span><span>24h</span></div>{rows.map((instrument) => { const quote = quotes.get(instrument.symbol); const change = parseNumber(quote?.price24hPcnt ?? "0"); return <div className="data-row grid grid-cols-[1.2fr_.8fr_.8fr_.6fr] items-center gap-4 px-5 py-3 text-sm" key={instrument.symbol}><span className="flex items-center gap-2 font-mono font-medium text-foreground"><Star className="h-3.5 w-3.5 text-muted-foreground" />{instrument.symbol}{instrument.symbolType === "xstocks" && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[9px] text-warning">xS</span>}</span><span className="font-mono text-xs text-muted-foreground">{formatPrice(parseNumber(quote?.bid1Price ?? "0"))}</span><span className="font-mono text-xs text-muted-foreground">{formatPrice(parseNumber(quote?.ask1Price ?? "0"))}</span><span className={`flex items-center gap-1 font-mono text-xs ${change >= 0 ? "text-primary" : "text-coral"}`}>{change >= 0 ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}{formatPercent(change)}</span></div>; })}</div></div>;
}

function Coverage({ label, value, caption, tone }: { label: string; value: number | string; caption: string; tone: string }) {
  return <div className="panel-subtle rounded-md p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs text-muted-foreground">{label}</span><span className={`h-2 w-2 rounded-full bg-${tone === "neutral" ? "muted-foreground" : tone}`} /></div><div className="font-mono text-2xl font-semibold text-foreground">{value}</div><div className="mt-1 text-[11px] text-muted-foreground">{caption}</div></div>;
}