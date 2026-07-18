from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import requests

OUT = Path("research/crypto/results_v3")
OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h"
COSTS = [0.001, 0.002, 0.003]
HEADERS = ["open_time","open","high","low","close","volume","close_time",
           "quote_volume","trades","taker_base","taker_quote","ignore"]


def load() -> pd.DataFrame:
    frames = []
    end = pd.Period(pd.Timestamp.now(tz="UTC").strftime("%Y-%m"), freq="M")
    session = requests.Session()
    for p in pd.period_range("2020-01", end, freq="M"):
        ym = str(p)
        r = session.get(f"{BASE}/BTCUSDT-1h-{ym}.zip", timeout=45)
        if r.status_code == 404:
            continue
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            a = pd.read_csv(zf.open(zf.namelist()[0]), header=None)
        a = a.iloc[:, :12]
        a.columns = HEADERS
        ts = pd.to_numeric(a.open_time, errors="coerce")
        a = a.loc[ts.notna()].copy()
        ts = ts.loc[ts.notna()].astype("int64")
        unit = "us" if float(ts.median()) > 1e14 else "ms"
        a["time"] = pd.to_datetime(ts, unit=unit, utc=True, errors="coerce")
        for c in ["open", "high", "low", "close", "volume"]:
            a[c] = pd.to_numeric(a[c], errors="coerce")
        frames.append(a[["time", "open", "high", "low", "close", "volume"]])
        print("downloaded", ym, len(a), unit)
    if not frames:
        raise RuntimeError("No Binance data downloaded")
    d = pd.concat(frames, ignore_index=True)
    return d.dropna().drop_duplicates("time").sort_values("time").set_index("time")


def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0).ewm(alpha=1/n, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1/n, adjust=False).mean()
    return 100 - 100 / (1 + gain / loss.replace(0, np.nan))


def features(d: pd.DataFrame) -> pd.DataFrame:
    x = d.copy()
    prev = x.close.shift()
    tr = pd.concat([x.high-x.low, (x.high-prev).abs(), (x.low-prev).abs()], axis=1).max(axis=1)
    x["atr"] = tr.ewm(alpha=1/14, adjust=False).mean()
    x["ema24"] = x.close.ewm(span=24, adjust=False).mean()
    x["ema72"] = x.close.ewm(span=72, adjust=False).mean()
    x["ema240"] = x.close.ewm(span=240, adjust=False).mean()
    x["ema720"] = x.close.ewm(span=720, adjust=False).mean()
    x["rsi"] = rsi(x.close)
    x["hi72"] = x.high.shift().rolling(72).max()
    x["lo72"] = x.low.shift().rolling(72).min()
    x["hi168"] = x.high.shift().rolling(168).max()
    x["lo168"] = x.low.shift().rolling(168).min()
    ret = x.close.pct_change()
    x["rv24"] = ret.rolling(24).std() * np.sqrt(24*365)
    x["rv_rank"] = x.rv24.rolling(2160).rank(pct=True)
    x["vol_med"] = x.volume.rolling(720).median()
    return x.dropna()


def votes(x: pd.DataFrame) -> pd.DataFrame:
    v = pd.DataFrame(index=x.index)
    # Expert 1: medium/long trend alignment.
    v["trend"] = np.select([
        (x.ema24 > x.ema72) & (x.ema72 > x.ema240) & (x.close > x.ema720),
        (x.ema24 < x.ema72) & (x.ema72 < x.ema240) & (x.close < x.ema720),
    ], [1, -1], default=0)
    # Expert 2: slower breakout, intentionally fixed rather than optimized.
    v["breakout"] = np.select([
        (x.close > x.hi168) & (x.close > x.ema240),
        (x.close < x.lo168) & (x.close < x.ema240),
    ], [1, -1], default=0)
    # Expert 3: pullback continuation inside the prevailing trend.
    v["pullback"] = np.select([
        (x.close > x.ema240) & (x.ema72 > x.ema240) & (x.rsi.shift() < 42) & (x.rsi >= 42),
        (x.close < x.ema240) & (x.ema72 < x.ema240) & (x.rsi.shift() > 58) & (x.rsi <= 58),
    ], [1, -1], default=0)
    v["sum"] = v[["trend", "breakout", "pullback"]].sum(axis=1)
    liquid = x.volume >= 0.75*x.vol_med
    normal_vol = x.rv_rank <= 0.95
    v["signal"] = np.select([
        (v["sum"] >= 2) & liquid & normal_vol,
        (v["sum"] <= -2) & liquid & normal_vol,
    ], [1, -1], default=0)
    return v


def simulate(x: pd.DataFrame, cost: float) -> pd.DataFrame:
    sig = votes(x).signal
    trades = []
    pos = 0
    cooldown_until = None
    for i in range(1, len(x)):
        p, r, t = x.iloc[i-1], x.iloc[i], x.index[i]
        if pos == 0:
            if cooldown_until is not None and t < cooldown_until:
                continue
            side = int(sig.iloc[i-1])
            if side == 0:
                continue
            pos = side
            entry = float(r.open)
            entry_time = t
            initial_atr = float(p.atr)
            stop = entry - pos*2.5*initial_atr
            best = entry
            continue

        best = max(best, float(r.high)) if pos == 1 else min(best, float(r.low))
        trailing = best - pos*3.0*float(p.atr)
        stop = max(stop, trailing) if pos == 1 else min(stop, trailing)
        exit_price = None
        reason = None
        if pos == 1 and r.low <= stop:
            exit_price, reason = stop, "atr_stop"
        elif pos == -1 and r.high >= stop:
            exit_price, reason = stop, "atr_stop"
        elif (t-entry_time) >= pd.Timedelta(hours=168):
            exit_price, reason = float(r.open), "time"
        elif sig.iloc[i-1] == -pos:
            exit_price, reason = float(r.open), "vote_flip"
        elif pos == 1 and p.close < p.ema72:
            exit_price, reason = float(r.open), "trend_exit"
        elif pos == -1 and p.close > p.ema72:
            exit_price, reason = float(r.open), "trend_exit"

        if exit_price is not None:
            gross = pos*(exit_price/entry - 1)
            trades.append({"entry_time":entry_time,"exit_time":t,"side":pos,
                           "entry":entry,"exit":exit_price,"gross":gross,
                           "net":gross-cost,"reason":reason})
            pos = 0
            cooldown_until = t + pd.Timedelta(hours=12)
    return pd.DataFrame(trades)


def metrics(t: pd.DataFrame, start, end) -> dict:
    weeks = max((pd.Timestamp(end)-pd.Timestamp(start)).days/7, 1)
    if t.empty:
        return {"trades":0,"return":-1.0,"pf":0.0,"win_rate":0.0,
                "max_dd":-1.0,"sharpe":-10.0,"positive_months":0.0,"trades_week":0.0}
    eq = (1+t.net).cumprod()
    dd = eq/eq.cummax()-1
    gp = t.loc[t.net>0,"net"].sum()
    gl = -t.loc[t.net<0,"net"].sum()
    daily = t.set_index("exit_time").net.resample("1D").sum()
    monthly = t.set_index("exit_time").net.resample("ME").sum()
    return {"trades":int(len(t)),"return":float(eq.iloc[-1]-1),
            "pf":float(gp/gl) if gl>0 else 99.0,
            "win_rate":float((t.net>0).mean()),"max_dd":float(dd.min()),
            "sharpe":float(np.sqrt(365)*daily.mean()/daily.std()) if daily.std()>0 else 0.0,
            "positive_months":float((monthly>0).mean()),"trades_week":float(len(t)/weeks)}


def main() -> None:
    x = features(load())
    periods = [(str(y), f"{y}-01-01", f"{y}-12-31") for y in range(2021, 2027)]
    periods += [("2025_plus", "2025-01-01", str(x.index.max().date()))]
    summary = {"design": {
        "type":"fixed_three_expert_ensemble", "tuning":"none_on_holdout",
        "experts":["trend_alignment","168h_breakout","trend_pullback"],
        "entry":"at least two agreeing experts", "stop_atr":2.5,
        "trail_atr":3.0,"max_hours":168,"cooldown_hours":12}, "tests":{}}
    rows = []
    plot_t = None
    for name, start, end in periods:
        part = x.loc[start:end]
        if part.empty:
            continue
        summary["tests"][name] = {}
        for c in COSTS:
            t = simulate(part, c)
            m = metrics(t, part.index.min(), part.index.max())
            summary["tests"][name][str(c)] = m
            rows.append({"period":name,"cost":c,**m})
            t.to_csv(OUT/f"trades_{name}_cost_{c:.3f}.csv", index=False)
            if name == "2025_plus" and c == 0.002:
                plot_t = t
    pd.DataFrame(rows).to_csv(OUT/"metrics_v3.csv", index=False)
    (OUT/"summary_v3.json").write_text(json.dumps(summary, indent=2))
    if plot_t is not None and not plot_t.empty:
        plt.figure(figsize=(10,5))
        plt.plot(plot_t.exit_time, (1+plot_t.net).cumprod())
        plt.title("BTC fixed multi-expert v3 equity")
        plt.tight_layout()
        plt.savefig(OUT/"equity_v3.png", dpi=150)
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
