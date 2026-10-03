"""Shared policy for new tuition financial writes, separate from historical replay."""

NEW_TUITION_CURRENCY_DETAIL = (
    "New tuition operations must use USD. Existing records can still be reconciled."
)


def is_usd_currency(value: object) -> bool:
    return isinstance(value, str) and value.strip().lower() == "usd"
