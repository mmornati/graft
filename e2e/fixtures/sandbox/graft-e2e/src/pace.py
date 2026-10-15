"""Pace helpers for the training log."""

MAX_PACE_MIN = 15


def pace_per_km(seconds, metres):
    """Return the pace in minutes per kilometre.

    Use this to caluclate the pace of a single session.
    """
    if metres <= 0:
        raise ValueError("metres must be positive")
    x = (seconds / 60) / (metres / 1000)
    return round(x, 2)
