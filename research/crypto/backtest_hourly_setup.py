from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd
import requests

OUT = Path("research/crypto/results_hourly_setup")
OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/spot/monthly/klines"
COSTS = [0.001, 0.002, 0.003]
HEADERS = ["open_time", "open", "high", "low", "close", "volume", "close_time",
           "quote_volume", "trades", "taker_base", "taker_quote", "ignore"]


def load_symbol(symbol: str, start: str = "2020-01") -> pd.DataFrame:
    frames = []
    end = pd.Period(pd.Timestamp.now(tz="UTC").strftime("%Y-%m"), freq="M")
    session = requests.Session()
    for period in pd.period_range(start, end, freq="M"):
        ym = str(period)
        url = f"{BASE}/{symbol}/1h/{symbol}-1h-{ym}.zip"
        response = session.get(url, timeout=45)
        if response.status_code == 404:
            continue
        response.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            frame = pd.read_csv(archive.open(archive.namelist()[0]), header=None)
        frame = frame.iloc[:, :12]
        frame.columns = HEADERS
        ts = pd.to_numeric(frame.open_time, errors="coerce")
        frame = frame.loc[ts.notna()].copy()
        ts = ts.loc[ts.notna()].astype("int64")
        unit = "us" if float(ts.median()) > 1e14 else "ms"
        frame["time"] = pd.to_datetime(ts, unit=unit, utc=True, errors="coerce")
        for column in ["open", "high", "low", "close", "volume"]:
            frame[column] = pd.to_numeric(frame[column], errors="coerce")
        frames.append(frame[["time", "open", "high", "low", "close", "volume"]])
        print("downloaded", symbol, ym, len(frame))
    if not frames:
        raise RuntimeError(f"No data downloaded for {symbol}")
    data = pd.concat(frames, ignore_index=True)
    return data.dropna().drop_duplicates("time").sort_values("time").set_index("time")


def prepare(btc: pd.DataFrame, eth: pd.DataFrame) -> pd.DataFrame:
    x = btc.copy()
    previous_close = x.close.shift()
    true_range = pd.concat([
        x.high - x.low,
        (x.high - previous_close).abs(),
        (x.low - previous_close).abs(),
    ], axis=1).max(axis=1)
    x["atr"] = true_range.ewm(alpha=1 / 14, adjust=False).mean()
    x["ema50"] = x.close.ewm(span=50, adjust=False).mean()
    x["ema200"] = x.close.ewm(span=200, adjust=False).mean()
    x["resistance"] = x.high.shift(1).rolling(168).max()
    x["volume_median"] = x.volume.shift(1).rolling(168).median()
    x["btc_return_72h"] = x.close.pct_change(72)
    eth_close = eth.close.reindex(x.index).ffill()
    x["eth_return_72h"] = eth_close.pct_change(72)
    x["relative_strength"] = x.btc_return_72h - x.eth_return_72h
    return x.dropna()


def entry_signal(x: pd.DataFrame, use_eth_filter: bool) -> pd.Series:
    breakout = (x.close > x.resistance) & (x.close.shift(1) <= x.resistance.shift(1))
    trend = (x.close > x.ema200) & (x.ema50 > x.ema200)
    volume = x.volume >= 1.20 * x.volume_median
    signal = breakout & trend & volume
    if use_eth_filter:
        signal &= x.relative_strength > 0
    return signal


def simulate(x: pd.DataFrame, cost: float, use_eth_filter: bool) -> pd.DataFrame:
    signal = entry_signal(x, use_eth_filter)
    trades = []
    in_trade = False
    cooldown_until = None

    for i in range(1, len(x)):
        previous = x.iloc[i - 1]
        bar = x.iloc[i]
        time = x.index[i]

        if not in_trade:
            if cooldown_until is not None and time < cooldown_until:
                continue
            if not bool(signal.iloc[i - 1]):
                continue
            entry = float(bar.open)
            entry_time = time
            initial_risk = 2.0 * float(previous.atr)
            if initial_risk <= 0:
                continue
            stop = entry - initial_risk
            target = entry + 3.0 * initial_risk
            best_close = entry
            in_trade = True
            continue

        # Conservative OHLC handling: evaluate the stop that existed before this bar.
        # If stop and target are both touched, assume the stop happened first.
        exit_price = None
        reason = None
        if float(bar.low) <= stop:
            exit_price, reason = stop, "stop"
        elif float(bar.high) >= target:
            exit_price, reason = target, "target_3R"
        elif time - entry_time >= pd.Timedelta(hours=168):
            exit_price, reason = float(bar.open), "time"
        elif float(previous.close) < float(previous.ema50):
            exit_price, reason = float(bar.open), "trend_exit"

        if exit_price is not None:
            gross = exit_price / entry - 1.0
            trades.append({
                "entry_time": entry_time,
                "exit_time": time,
                "entry": entry,
                "exit": exit_price,
                "gross": gross,
                "net": gross - cost,
                "reason": reason,
                "holding_hours": float((time - entry_time) / pd.Timedelta(hours=1)),
            })
            in_trade = False
            cooldown_until = time + pd.Timedelta(hours=24)
            continue

        # Stop changes only after the current bar survived the old stop.
        best_close = max(best_close, float(bar.close))
        open_profit_r = (best_close - entry) / initial_risk
        if open_profit_r >= 1.5:
            stop = max(stop, entry)
        if open_profit_r >= 2.0:
            stop = max(stop, best_close - 1.5 * float(previous.atr))

    return pd.DataFrame(trades)


def max_consecutive_losses(values: pd.Series) -> int:
    longest = current = 0
    for value in values:
        if value < 0:
            current += 1
            longest = max(longest, current)
        else:
            current = 0
    return longest


def metrics(trades: pd.DataFrame, start, end, buy_hold: float) -> dict:
    if trades.empty:
        return {"trades": 0, "return": 0.0, "pf": 0.0, "win_rate": 0.0,
                "expectancy": 0.0, "max_dd": 0.0, "sharpe": 0.0,
                "sortino": 0.0, "avg_holding_hours": 0.0,
                "max_consecutive_losses": 0, "trades_week": 0.0,
                "buy_hold": buy_hold}
    equity = (1.0 + trades.net).cumprod()
    drawdown = equity / equity.cummax() - 1.0
    gains = trades.loc[trades.net > 0, "net"].sum()
    losses = -trades.loc[trades.net < 0, "net"].sum()
    daily = trades.set_index("exit_time").net.resample("1D").sum()
    downside = daily[daily < 0].std()
    weeks = max((pd.Timestamp(end) - pd.Timestamp(start)).days / 7.0, 1.0)
    return {
        "trades": int(len(trades)),
        "return": float(equity.iloc[-1] - 1.0),
        "pf": float(gains / losses) if losses > 0 else 99.0,
        "win_rate": float((trades.net > 0).mean()),
        "expectancy": float(trades.net.mean()),
        "max_dd": float(drawdown.min()),
        "sharpe": float(np.sqrt(365) * daily.mean() / daily.std()) if daily.std() > 0 else 0.0,
        "sortino": float(np.sqrt(365) * daily.mean() / downside) if downside and downside > 0 else 0.0,
        "avg_holding_hours": float(trades.holding_hours.mean()),
        "max_consecutive_losses": max_consecutive_losses(trades.net),
        "trades_week": float(len(trades) / weeks),
        "buy_hold": float(buy_hold),
    }


def main() -> None:
    btc_usdt = load_symbol("BTCUSDT")
    btc_eur = load_symbol("BTCEUR")
    eth_usdt = load_symbol("ETHUSDT")
    datasets = {
        "BTCUSDT": prepare(btc_usdt, eth_usdt),
        "BTCEUR": prepare(btc_eur, eth_usdt),
    }
    periods = [(str(year), f"{year}-01-01", f"{year}-12-31") for year in range(2021, 2027)]
    periods += [("2025_plus", "2025-01-01", None)]
    summary = {
        "strategy": {
            "timeframe": "1h",
            "direction": "long_only",
            "entry": "next open after 168h breakout, EMA50>EMA200, close>EMA200, volume>=1.2x 168h median",
            "eth_filter": "optional BTC 72h return greater than ETH 72h return",
            "initial_stop": "2 ATR",
            "target": "3R",
            "breakeven": "after 1.5R",
            "trailing_stop": "after 2R, 1.5 ATR behind best close",
            "max_holding_hours": 168,
            "intrabar_rule": "old stop checked before updates; stop wins if stop and target touched in same bar",
            "leverage": "not applied; assess edge before leverage",
        },
        "tests": {},
    }
    rows = []
    for pair, data in datasets.items():
        summary["tests"][pair] = {}
        for name, start, end in periods:
            actual_end = end or str(data.index.max().date())
            part = data.loc[start:actual_end]
            if part.empty:
                continue
            buy_hold = float(part.close.iloc[-1] / part.open.iloc[0] - 1.0)
            summary["tests"][pair][name] = {}
            for use_eth in [False, True]:
                filter_name = "with_eth_filter" if use_eth else "without_eth_filter"
                summary["tests"][pair][name][filter_name] = {}
                for cost in COSTS:
                    trades = simulate(part, cost, use_eth)
                    result = metrics(trades, part.index.min(), part.index.max(), buy_hold)
                    summary["tests"][pair][name][filter_name][str(cost)] = result
                    rows.append({"pair": pair, "period": name, "eth_filter": use_eth,
                                 "cost": cost, **result})
                    trades.to_csv(OUT / f"trades_{pair}_{name}_{filter_name}_{cost:.3f}.csv", index=False)
    pd.DataFrame(rows).to_csv(OUT / "metrics_hourly_setup.csv", index=False)
    (OUT / "summary_hourly_setup.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
