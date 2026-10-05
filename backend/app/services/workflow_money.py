"""Format typed money facts without deciding invoice or message eligibility."""

from types import MappingProxyType
from typing import Literal

_CURRENCY_FRACTION_DIGITS = MappingProxyType(
    {
        "USD": 2,
        "EUR": 2,
        "GBP": 2,
        "CAD": 2,
        "AUD": 2,
        "NZD": 2,
        "CHF": 2,
        "AED": 2,
        "CNY": 2,
        "HKD": 2,
        "SGD": 2,
        "INR": 2,
        "MXN": 2,
        "BRL": 2,
        "DKK": 2,
        "NOK": 2,
        "SEK": 2,
        "PLN": 2,
        "HUF": 2,
        "TWD": 2,
        "ISK": 2,
        "UGX": 2,
        "BIF": 0,
        "CLP": 0,
        "DJF": 0,
        "GNF": 0,
        "JPY": 0,
        "KMF": 0,
        "KRW": 0,
        "MGA": 0,
        "PYG": 0,
        "RWF": 0,
        "VND": 0,
        "VUV": 0,
        "XAF": 0,
        "XOF": 0,
        "XPF": 0,
        "BHD": 3,
        "JOD": 3,
        "KWD": 3,
        "OMR": 3,
        "TND": 3,
    }
)


class WorkflowMoneyFormatError(ValueError):
    """A fixed, input-free reason that callers may translate into render policy."""

    def __init__(self, reason: Literal["facts_unavailable", "unsupported_currency"]):
        if type(reason) is not str or reason not in (
            "facts_unavailable",
            "unsupported_currency",
        ):
            raise ValueError("invalid_workflow_money_format_reason")
        self._reason = reason
        super().__init__(reason)

    @property
    def reason(self) -> Literal["facts_unavailable", "unsupported_currency"]:
        return self._reason


def format_workflow_money(
    amount_minor_units: object,
    currency: object,
    *,
    unit_convention: object,
) -> str:
    """Render exact signed64 money using the caller's established unit convention.

    The convention describes units only. It does not establish source provenance
    or permission to send a message, and zero and negative amounts are preserved.
    """
    if type(unit_convention) is not str or unit_convention not in (
        "stripe_minor_units",
        "usd_cents",
    ):
        raise WorkflowMoneyFormatError("facts_unavailable")
    if type(amount_minor_units) is not int or not -(2**63) <= amount_minor_units < 2**63:
        raise WorkflowMoneyFormatError("facts_unavailable")
    if (
        type(currency) is not str
        or len(currency) != 3
        or not currency.isascii()
        or not currency.isalpha()
    ):
        raise WorkflowMoneyFormatError("facts_unavailable")

    code = currency.upper()
    if unit_convention == "usd_cents" and code != "USD":
        raise WorkflowMoneyFormatError("facts_unavailable")
    fraction_digits = _CURRENCY_FRACTION_DIGITS.get(code)
    if fraction_digits is None:
        raise WorkflowMoneyFormatError("unsupported_currency")

    major, minor = divmod(abs(amount_minor_units), 10**fraction_digits)
    sign = "-" if amount_minor_units < 0 else ""
    if fraction_digits:
        return f"{code} {sign}{major}.{minor:0{fraction_digits}d}"
    return f"{code} {sign}{major}"
