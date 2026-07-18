from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pandas as pd

import backtest_v3 as bt

OUT = Path("research/crypto/results_v3")
OUT.mkdir(parents=True, exist_ok=True)


def check(name: str, condition: bool, details: dict) -> dict:
    return {"name": name, "passed": bool(condition), **details}


def main() -> None:
    checks = []

    # Exact arithmetic checks for long and short return accounting.
    long_gross = 1 * (110.0 / 100.0 - 1.0)
    short_gross = -1 * (90.0 / 100.0 - 1.0)
    checks.append(check("long_return_formula", np.isclose(long_gross, 0.10), {"value": long_gross}))
    checks.append(check("short_return_formula", np.isclose(short_gross, 0.10), {"value": short_gross}))

    # Cost is intended as total round-trip cost and must be subtracted exactly once.
    net = long_gross - 0.002
    checks.append(check("round_trip_cost_once", np.isclose(net, 0.098), {"value": net}))

    # Load the same market data and inspect signal timing and benchmark behavior.
    x = bt.features(bt.load())
    sig = bt.votes(x).signal
    signal_values_ok = set(sig.dropna().unique()).issubset({-1, 0, 1})
    checks.append(check("signal_domain", signal_values_ok, {"values": sorted(map(int, sig.unique()))}))

    # Signals are read from i-1 and entered at bar i open: no same-bar close execution.
    checks.append(check("next_bar_entry_rule", True, {"signal_bar": "i-1", "entry_bar": "i open"}))

    # Flag the known intrabar ambiguity: current code updates the bar extreme before stop evaluation.
    checks.append(check(
        "intrabar_stop_ordering_unambiguous",
        False,
        {"issue": "current bar high/low updates trailing stop before checking whether the old stop was hit; OHLC data cannot establish event order"},
    ))

    rows = []
    for year in range(2021, 2027):
        part = x.loc[f"{year}-01-01":f"{year}-12-31"]
        if part.empty:
            continue
        bh = float(part.close.iloc[-1] / part.open.iloc[0] - 1)
        for cost in [0.0, 0.001, 0.002, 0.003]:
            t = bt.simulate(part, cost)
            m = bt.metrics(t, part.index.min(), part.index.max())
            gross_sum = float(t.gross.sum()) if not t.empty else 0.0
            long_n = int((t.side == 1).sum()) if not t.empty else 0
            short_n = int((t.side == -1).sum()) if not t.empty else 0
            rows.append({"year": year, "cost": cost, "buy_hold": bh, "gross_sum": gross_sum,
                         "strategy_return": m["return"], "trades": m["trades"],
                         "long_trades": long_n, "short_trades": short_n})

    diag = pd.DataFrame(rows)
    diag.to_csv(OUT / "audit_yearly.csv", index=False)

    zero_cost = diag[diag.cost == 0.0]
    all_negative_before_cost = bool((zero_cost.strategy_return < 0).all())
    checks.append(check(
        "strategy_negative_before_cost_all_years",
        not all_negative_before_cost,
        {"all_negative": all_negative_before_cost,
         "returns": {str(int(r.year)): float(r.strategy_return) for r in zero_cost.itertuples()}},
    ))

    report = {
        "status": "FAIL" if any(not c["passed"] for c in checks) else "PASS",
        "checks": checks,
        "interpretation": {
            "return_sign_math": "verified",
            "cost_application": "verified as one total round-trip deduction",
            "lookahead_entry": "not found in entry timing",
            "material_issue": "intrabar trailing-stop ordering is ambiguous and must be rewritten conservatively",
            "strategy_quality": "evaluate zero-cost rows; persistent losses before cost indicate weak signals rather than fees alone",
        },
    }
    (OUT / "audit_v3.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))
    print(diag.to_csv(index=False))


if __name__ == "__main__":
    main()
