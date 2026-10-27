"""Trains the three Phase 5 models from the exported event history and writes
them as small JSON files the API and live service load at startup.

    ml/export.sh                       # Postgres -> ml/data/*.csv
    ml/.venv/bin/python ml/train.py    # -> ml/models/*.json + ml/report.md

ETA and acceptance are judged on the last 30% of history after training on
the first 70% (a time split, so they always predict the future); demand uses
blocked cross-validation over time (see demand_model). Each is compared with
the hand-written formula it would replace. A more flexible model (gradient
boosting) is also fitted; the simple one ships unless the flexible one is
clearly better, because the simple one is a few numbers the TypeScript side
can evaluate in microseconds.
"""

import json
import math
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.linear_model import HuberRegressor, LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, mean_absolute_error, roc_auc_score

ROOT = Path(__file__).parent
DATA = ROOT / "data"
MODELS = ROOT / "models"
TEST_SHARE = 0.3

# Same grid as packages/shared/src/zones.ts.
MIN_LAT, MAX_LAT, MIN_LNG, MAX_LNG = 28.4, 28.88, 76.84, 77.35
ZONE_DEG = 0.02
ZONE_ROWS = math.ceil(round((MAX_LAT - MIN_LAT) / ZONE_DEG, 9))
ZONE_COLS = math.ceil(round((MAX_LNG - MIN_LNG) / ZONE_DEG, 9))

# Hand-written formulas in apps/api/src/config.ts, the baselines to beat.
DETOUR, SPEED_MPS = 1.3, 9.0

report: list[str] = []


def say(line: str = "") -> None:
    print(line)
    report.append(line)


def time_split(df: pd.DataFrame, col: str = "at_ms") -> tuple[pd.DataFrame, pd.DataFrame]:
    df = df.sort_values(col)
    cut = int(len(df) * (1 - TEST_SHARE))
    return df.iloc[:cut], df.iloc[cut:]


def eta_model() -> dict:
    df = pd.read_csv(DATA / "pickups.csv")
    df = df[(df.distance_m > 0) & (df.pickup_s > 0) & (df.pickup_s < 1800)]
    train, test = time_split(df)
    X_tr, X_te = train[["distance_m"]].to_numpy(), test[["distance_m"]].to_numpy()

    baseline = test.distance_m * DETOUR / SPEED_MPS
    linear = HuberRegressor().fit(X_tr, train.pickup_s)  # robust to the odd stuck trip
    gbm = HistGradientBoostingRegressor(max_iter=200).fit(X_tr, train.pickup_s)

    say("## ETA: seconds from accept to pickup")
    say(f"{len(train):,} trips to train, {len(test):,} to test.\n")
    say("| | MAE | median abs error | mean bias |")
    say("|---|---|---|---|")
    for name, pred in [
        (f"formula: distance × {DETOUR} ÷ {SPEED_MPS} m/s", baseline),
        ("linear model (Huber)", linear.predict(X_te)),
        ("gradient boosting", gbm.predict(X_te)),
    ]:
        err = pred - test.pickup_s
        say(f"| {name} | {mean_absolute_error(test.pickup_s, pred):.1f} s | {np.median(np.abs(err)):.1f} s | {err.mean():+.1f} s |")
    say(f"\nLearned: {linear.intercept_:.2f} s + {linear.coef_[0] * 1000:.1f} s per km "
        f"(≈ {1 / linear.coef_[0]:.1f} m/s effective, vs the formula's {SPEED_MPS / DETOUR:.1f}).\n")
    return {"interceptS": float(linear.intercept_), "secondsPerMeter": float(linear.coef_[0]), "trainedOn": len(train)}


ACCEPT_FEATURES = ["logit_p", "distance_km", "attempt", "urgent"]


def accept_features(df: pd.DataFrame) -> pd.DataFrame:
    p = df.p_accept.clip(0.01, 0.99)
    return pd.DataFrame({
        "logit_p": np.log(p / (1 - p)),
        "distance_km": df.distance_m / 1000,
        "attempt": df.attempt,
        "urgent": df.priority.isin(["high", "critical"]).astype(float),
    })


def acceptance_model() -> dict:
    df = pd.read_csv(DATA / "offers.csv")
    df["accepted"] = (df.outcome == "ASSIGNED").astype(int)
    train, test = time_split(df)
    X_tr, X_te = accept_features(train), accept_features(test)
    mean, std = X_tr.mean(), X_tr.std().replace(0, 1)

    logistic = LogisticRegression().fit((X_tr - mean) / std, train.accepted)
    gbm = HistGradientBoostingClassifier(max_iter=200).fit(X_tr, train.accepted)

    say("## Acceptance: will this driver say yes?")
    say(f"{len(train):,} offers to train, {len(test):,} to test. "
        f"{train.accepted.mean():.1%} of training offers were accepted.\n")
    say("| | log loss | Brier | AUC | mean predicted |")
    say("|---|---|---|---|---|")
    for name, pred in [
        ("smoothed history (the Phase 3 `p`)", test.p_accept.clip(0.01, 0.99)),
        ("logistic regression", logistic.predict_proba((X_te - mean) / std)[:, 1]),
        ("gradient boosting", gbm.predict_proba(X_te)[:, 1]),
    ]:
        say(f"| {name} | {log_loss(test.accepted, pred):.4f} | {brier_score_loss(test.accepted, pred):.4f} | "
            f"{roc_auc_score(test.accepted, pred):.3f} | {pred.mean():.1%} |")
    say(f"\nActual acceptance in the test period: {test.accepted.mean():.1%}. Lower log loss / Brier is better; "
        "AUC is how well it ranks yes-drivers above no-drivers (0.5 = coin flip).\n")
    weights = dict(zip(ACCEPT_FEATURES, (float(w) for w in logistic.coef_[0])))
    say("Standardised weights: " + ", ".join(f"{k} {v:+.3f}" for k, v in weights.items()) + "\n")
    return {
        "features": ACCEPT_FEATURES,
        "mean": [float(mean[f]) for f in ACCEPT_FEATURES],
        "std": [float(std[f]) for f in ACCEPT_FEATURES],
        "weights": [weights[f] for f in ACCEPT_FEATURES],
        "intercept": float(logistic.intercept_[0]),
        "trainedOn": len(train),
    }


def demand_model() -> dict:
    df = pd.read_csv(DATA / "requests.csv")
    row = ((df.lat - MIN_LAT) / ZONE_DEG).astype(int)
    col = ((df.lng - MIN_LNG) / ZONE_DEG).astype(int)
    df = df[(row >= 0) & (row < ZONE_ROWS) & (col >= 0) & (col < ZONE_COLS)].copy()
    df["zone"] = row * ZONE_COLS + col
    df["minute"] = (df.at_ms // 60_000).astype(int)

    counts = df.pivot_table(index="minute", columns="zone", values="id", aggfunc="count", fill_value=0)
    counts = counts.reindex(range(counts.index.min(), counts.index.max() + 1), fill_value=0)
    counts = counts.reindex(columns=range(ZONE_ROWS * ZONE_COLS), fill_value=0)
    city = counts.sum(axis=1)
    # Simulator traffic only: k6 load tests spread bookings differently and ran at 20-1,500 req/s.
    sim_minute = (city > 0) & (city <= 1_000)

    minutes = counts.index.to_numpy()
    c = counts.to_numpy()
    ok = sim_minute.to_numpy()

    # Blocked cross-validation: 5 contiguous blocks of simulator bookings. Each block is
    # predicted with zone shares learned from the other four, so every window is out-of-sample.
    folds = 5
    sim_bookings = city.where(sim_minute, 0).cumsum().to_numpy()
    fold_of = np.minimum((sim_bookings * folds) // max(sim_bookings[-1], 1), folds - 1).astype(int)
    rows_recent, rows_model, rows_actual, fold_shares = [], [], [], []
    for f in range(folds):
        train_rows = c[ok & (fold_of != f)]
        share_f = train_rows.sum(axis=0) / train_rows.sum()
        fold_shares.append(share_f)
        # At each minute t in this block, predict every zone's bookings in [t, t+5) from [t-5, t).
        for i in range(5, len(minutes) - 5):
            if fold_of[i] != f or not ok[i - 5:i + 5].all():
                continue  # both windows must be inside one uninterrupted simulator run
            past, future = c[i - 5:i].sum(axis=0), c[i:i + 5].sum(axis=0)
            rows_recent.append(past)
            rows_model.append(share_f * past.sum())
            rows_actual.append(future)
    actual = np.array(rows_actual)
    total = int(c[ok].sum())
    share = c[ok].sum(axis=0) / total  # the shipped model uses all history
    active = share > 0

    say("## Demand: bookings per zone in the next 5 minutes")
    say(f"{total:,} simulator bookings; {folds}-fold blocked cross-validation over {len(actual):,} five-minute windows "
        f"× {int(active.sum())} active zones (each window predicted by shares learned without its block).\n")
    say("| | MAE per zone-window | MAE on the 20 busiest zones |")
    say("|---|---|---|")
    busiest = np.argsort(share)[-20:]
    for name, pred in [("each zone's own last 5 min (current)", np.array(rows_recent)),
                       ("zone share × city-wide last 5 min (model)", np.array(rows_model))]:
        say(f"| {name} | {np.abs(pred - actual)[:, active].mean():.3f} | {np.abs(pred - actual)[:, busiest].mean():.3f} |")
    say("\nThe model pools the whole city's recent volume (lots of data, little noise) and splits it by each zone's "
        "long-run share, instead of trusting one zone's last few bookings.\n")
    return {"zones": ZONE_ROWS * ZONE_COLS, "share": [round(float(s), 6) for s in share], "trainedOn": total}


def main() -> None:
    MODELS.mkdir(exist_ok=True)
    say("# Phase 5 model report\n")
    say("Generated by `ml/train.py`. ETA and acceptance: first 70% of history trains, last 30% tests. "
        "Demand: 5-fold blocked cross-validation over time.\n")
    for name, fit in [("eta", eta_model), ("acceptance", acceptance_model), ("demand", demand_model)]:
        (MODELS / f"{name}.json").write_text(json.dumps(fit(), indent=1))
    (ROOT / "report.md").write_text("\n".join(report) + "\n")


if __name__ == "__main__":
    main()
