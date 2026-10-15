"""Heart-rate zones."""


def zone(hr, max_hr):
    """Return the training zone (1 to 5) for a heart rate."""
    ratio = hr / max_hr
    if ratio < 0.6:
        return 1
    if ratio < 0.7:
        return 2
    if ratio < 0.8:
        return 3
    if ratio < 0.9:
        return 4
    return 5
