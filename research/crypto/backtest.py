from __future__ import annotations
import io, json, zipfile
from pathlib import Path
from itertools import product
import requests, numpy as np, pandas as pd
import matplotlib.pyplot as plt

OUT = Path("research/crypto/results_v2")
OUT.mkdir(parents=True, exist_ok=True)
BASE = "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1h"
COSTS = [0.001, 0.002, 0.003]

def load():
    cols = ["open_time","open","high","low","close","volume","close_time",
            "quote_volume","trades","taker_base","taker_quote","ignore"]
    frames = []
    end = pd.Timestamp.utcnow().to_period("M")
    for p in pd.period_range("2020-01", end, freq="M"):
        ym = str(p)
        url = f"{BASE}/BTCUSDT-1h-{ym}.zip"
        r = requests.get(url, timeout=60)
        if r.status_code == 404:
            continue
        r.raise_for_status()
        with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
            a = pd.read_csv(zf.open(zf.namelist()[0]), header=None)
        a = a.iloc[:, :12]
        a.columns = cols
        a["open_time"] = pd.to_numeric(a["open_time"], errors="coerce")
        a = a.dropna(subset=["open_time"])
        med = float(a["open_time"].median())
        unit = "us" if med > 1e14 else "ms"
        a["time"] = pd.to_datetime(a["open_time"], unit=unit, utc=True, errors="coerce")
        for c in ["open","high","low","close","volume"]:
            a[c] = pd.to_numeric(a[c], errors="coerce")
        frames.append(a[["time","open","high","low","close","volume"]].dropna())
        print("downloaded", ym, len(a), unit)
    if not frames:
        raise RuntimeError("No Binance data downloaded")
    d = pd.concat(frames, ignore_index=True)
    return d.drop_duplicates("time").sort_values("time").set_index("time")

def features(d):
    x = d.copy()
    pc = x.close.shift()
    tr = pd.concat([x.high-x.low, (x.high-pc).abs(), (x.low-pc).abs()], axis=1).max(axis=1)
    x["atr"] = tr.ewm(alpha=1/14, adjust=False).mean()
    up, dn = x.high.diff(), -x.low.diff()
    plus = pd.Series(np.where((up>dn)&(up>0), up, 0.0), index=x.index)
    minus = pd.Series(np.where((dn>up)&(dn>0), dn, 0.0), index=x.index)
    atr = tr.ewm(alpha=1/14, adjust=False).mean()
    pdi = 100*plus.ewm(alpha=1/14, adjust=False).mean()/atr
    mdi = 100*minus.ewm(alpha=1/14, adjust=False).mean()/atr
    x["adx"] = (100*(pdi-mdi).abs()/(pdi+mdi).replace(0,np.nan)).ewm(alpha=1/14,adjust=False).mean()
    for n in [20,50,100,4800]:
        x[f"ema{n}"] = x.close.ewm(span=n, adjust=False).mean()
    for n in [48,72,120,168]:
        x[f"hi{n}"] = x.high.shift().rolling(n).max()
        x[f"lo{n}"] = x.low.shift().rolling(n).min()
    x["rv24"] = x.close.pct_change().rolling(24).std()
    x["rv168"] = x.close.pct_change().rolling(168).std()
    x["rv_rank"] = x.rv24.rolling(2160).rank(pct=True)
    x["vol_med"] = x.volume.rolling(720).median()
    return x.dropna()

def signal(x, side_mode, channel, adx_min, vol_cap):
    s = pd.Series(0, index=x.index, dtype="int8")
    bull = (x.close > x.ema4800) & (x.ema20 > x.ema100) & (x.adx >= adx_min)
    bear = (x.close < x.ema4800) & (x.ema20 < x.ema100) & (x.adx >= adx_min)
    liquid = x.volume > 0.8*x.vol_med
    calm = x.rv_rank < vol_cap
    s[bull & liquid & calm & (x.close > x[f"hi{channel}"])] = 1
    if side_mode == "both":
        s[bear & liquid & calm & (x.close < x[f"lo{channel}"])] = -1
    return s

def backtest(x, side_mode, channel, adx_min, trail, max_hours, cost):
    s = signal(x, side_mode, channel, adx_min, 0.92)
    out, pos = [], 0
    for i in range(1, len(x)):
        p, r, t = x.iloc[i-1], x.iloc[i], x.index[i]
        if pos == 0 and s.iloc[i-1] != 0:
            pos = int(s.iloc[i-1])
            entry = float(r.open)
            et = t
            stop = entry - pos*trail*float(p.atr)
            continue
        if pos == 0:
            continue
        stop = max(stop, float(p.close-trail*p.atr)) if pos == 1 else min(stop, float(p.close+trail*p.atr))
        exit_price = None
        reason = None
        if pos == 1 and r.low <= stop:
            exit_price, reason = stop, "atr_stop"
        elif pos == -1 and r.high >= stop:
            exit_price, reason = stop, "atr_stop"
        elif (t-et)/pd.Timedelta(hours=1) >= max_hours:
            exit_price, reason = float(r.open), "time"
        elif pos == 1 and p.close < p.ema50:
            exit_price, reason = float(r.open), "ema_exit"
        elif pos == -1 and p.close > p.ema50:
            exit_price, reason = float(r.open), "ema_exit"
        if exit_price is not None:
            gross = pos*(exit_price/entry - 1)
            out.append({"entry_time":et,"exit_time":t,"side":pos,"entry":entry,
                        "exit":exit_price,"gross":gross,"net":gross-cost,"reason":reason})
            pos = 0
    return pd.DataFrame(out)

def metrics(t, start=None, end=None):
    if t.empty:
        return {"trades":0,"return":-1.0,"pf":0.0,"win_rate":0.0,"max_dd":-1.0,
                "sharpe":-10.0,"positive_months":0.0,"trades_week":0.0}
    eq = (1+t.net).cumprod()
    dd = eq/eq.cummax()-1
    gp = t.loc[t.net>0,"net"].sum()
    gl = -t.loc[t.net<0,"net"].sum()
    daily = t.set_index("exit_time").net.resample("1D").sum()
    monthly = t.set_index("exit_time").net.resample("ME").sum()
    if start is None: start = t.entry_time.min()
    if end is None: end = t.exit_time.max()
    weeks = max((pd.Timestamp(end)-pd.Timestamp(start)).days/7, 1)
    return {"trades":int(len(t)),"return":float(eq.iloc[-1]-1),
            "pf":float(gp/gl) if gl>0 else 99.0,
            "win_rate":float((t.net>0).mean()),"max_dd":float(dd.min()),
            "sharpe":float(np.sqrt(365)*daily.mean()/daily.std()) if daily.std()>0 else 0.0,
            "positive_months":float((monthly>0).mean()),
            "trades_week":float(len(t)/weeks)}

def score_years(ms):
    sharpe = np.median([m["sharpe"] for m in ms])
    pf = np.median([min(m["pf"], 3) for m in ms])
    ret = np.median([m["return"] for m in ms])
    worst_ret = min(m["return"] for m in ms)
    worst_dd = min(m["max_dd"] for m in ms)
    freq = np.median([m["trades_week"] for m in ms])
    return sharpe + 0.5*np.log(max(pf,1e-6)) + ret + 0.75*worst_ret + 1.5*worst_dd - (1.5 if freq < 0.5 else 0)

def main():
    x = features(load())
    configs = product(["long","both"], [48,72,120,168], [18,22,26], [2.0,2.5,3.0,3.5], [168,336,504])
    rows = []
    for side, ch, adx, trail, maxh in configs:
        yearly = []
        for year in [2021,2022,2023,2024]:
            part = x.loc[f"{year}-01-01":f"{year}-12-31"]
            yearly.append(metrics(backtest(part,side,ch,adx,trail,maxh,0.002),
                                  part.index.min(), part.index.max()))
        rows.append({"side":side,"channel":ch,"adx":adx,"trail":trail,"max_hours":maxh,
                     "score":score_years(yearly),
                     "median_pf":float(np.median([m["pf"] for m in yearly])),
                     "median_sharpe":float(np.median([m["sharpe"] for m in yearly])),
                     "worst_return":float(min(m["return"] for m in yearly)),
                     "worst_dd":float(min(m["max_dd"] for m in yearly)),
                     "median_trades_week":float(np.median([m["trades_week"] for m in yearly]))})
    grid = pd.DataFrame(rows).sort_values("score", ascending=False)
    grid.to_csv(OUT/"walkforward_grid.csv", index=False)
    b = grid.iloc[0]
    selected = {k:(int(b[k]) if k in ["channel","adx","max_hours"] else float(b[k]) if k=="trail" else b[k])
                for k in ["side","channel","adx","trail","max_hours"]}
    summary = {"selected":selected,"development":b.to_dict(),"tests":{}}
    plot_t = None
    for period, start, end in [("2025","2025-01-01","2025-12-31"),
                               ("2026_ytd","2026-01-01",str(x.index.max().date())),
                               ("2025_plus","2025-01-01",str(x.index.max().date()))]:
        part = x.loc[start:end]
        summary["tests"][period] = {}
        for c in COSTS:
            t = backtest(part, selected["side"], selected["channel"], selected["adx"],
                         selected["trail"], selected["max_hours"], c)
            t.to_csv(OUT/f"trades_{period}_cost_{c:.3f}.csv", index=False)
            summary["tests"][period][str(c)] = metrics(t, part.index.min(), part.index.max())
            if period=="2025_plus" and c==0.002:
                plot_t = t
    (OUT/"summary_v2.json").write_text(json.dumps(summary, indent=2, default=float))
    rows_out=[]
    for p,dct in summary["tests"].items():
        for c,m in dct.items():
            rows_out.append({"period":p,"cost":c,**m})
    pd.DataFrame(rows_out).to_csv(OUT/"test_metrics.csv",index=False)
    if plot_t is not None and not plot_t.empty:
        plt.figure(figsize=(10,5))
        plt.plot(plot_t.exit_time,(1+plot_t.net).cumprod())
        plt.title("BTC v2 test equity")
        plt.tight_layout()
        plt.savefig(OUT/"equity_v2.png",dpi=150)
    print(json.dumps(summary,indent=2,default=float))

if __name__ == "__main__":
    main()
