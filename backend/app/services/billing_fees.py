def platform_fee_bps(stored_bps: int | None, default_bps: int) -> int:
    return default_bps if stored_bps is None else stored_bps


def application_fee_percent(stored_bps: int | None, default_bps: int) -> float:
    return round(platform_fee_bps(stored_bps, default_bps) / 100, 3)


def application_fee_amount(amount_cents: int, stored_bps: int | None, default_bps: int) -> int:
    return int(round(amount_cents * platform_fee_bps(stored_bps, default_bps) / 10000))
