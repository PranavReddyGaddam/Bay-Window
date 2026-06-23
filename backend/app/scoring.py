"""Compute a 0-100 building health score from building-precise signals.

Per design decision: score uses ONLY building-precise data (violations,
complaints, housing-filtered 311). Block-level evictions/rent are shown as
context but never penalize a building for its neighbors.

Approach: start at 100, subtract weighted penalties, clamp to [0, 100].
Open/unresolved issues weigh more than closed historical ones, and recent
issues weigh more than old ones (we approximate recency via open status since
all sets are returned newest-first and capped).
"""
from typing import Any

# Penalty weights (points off per issue).
W_VIOLATION_OPEN = 8
W_VIOLATION_CLOSED = 2
W_COMPLAINT_OPEN = 4
W_COMPLAINT_CLOSED = 1
W_311 = 1.5

# Cap the contribution of any single category so one prolific category can't
# alone zero out a building (e.g. many minor noise 311s).
CATEGORY_CAP = 40


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def compute_score(violations: dict, complaints: dict, threeoneone: dict) -> dict:
    v_open = violations.get("open", 0)
    v_total = violations.get("count", 0)
    v_closed = max(v_total - v_open, 0)

    c_open = complaints.get("open", 0)
    c_total = complaints.get("count", 0)
    c_closed = max(c_total - c_open, 0)

    n_311 = threeoneone.get("count", 0)

    violation_penalty = _clamp(
        v_open * W_VIOLATION_OPEN + v_closed * W_VIOLATION_CLOSED, 0, CATEGORY_CAP)
    complaint_penalty = _clamp(
        c_open * W_COMPLAINT_OPEN + c_closed * W_COMPLAINT_CLOSED, 0, CATEGORY_CAP)
    penalty_311 = _clamp(n_311 * W_311, 0, CATEGORY_CAP)

    raw = 100 - (violation_penalty + complaint_penalty + penalty_311)
    score = int(round(_clamp(raw, 0, 100)))

    return {
        "value": score,
        "grade": _grade(score),
        "breakdown": {
            "violations": {"open": v_open, "total": v_total,
                           "penalty": round(violation_penalty, 1)},
            "complaints": {"open": c_open, "total": c_total,
                           "penalty": round(complaint_penalty, 1)},
            "complaints_311": {"total": n_311, "penalty": round(penalty_311, 1)},
        },
        "method": "Starts at 100; weighted deductions for open/closed DBI "
                  "violations, complaints, and housing-related 311 cases. "
                  "Block-level evictions and rent status are excluded from the "
                  "score and shown as context only.",
    }


def _grade(score: int) -> str:
    if score >= 90:
        return "A"
    if score >= 80:
        return "B"
    if score >= 70:
        return "C"
    if score >= 60:
        return "D"
    return "F"
