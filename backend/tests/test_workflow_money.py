from decimal import Decimal, localcontext
from itertools import product
from string import ascii_uppercase

import pytest

from app.services import workflow_money
from app.services.workflow_money import WorkflowMoneyFormatError, format_workflow_money

_SUPPORTED_EXAMPLES = (
    ("USD", "USD 12.34"),
    ("EUR", "EUR 12.34"),
    ("GBP", "GBP 12.34"),
    ("CAD", "CAD 12.34"),
    ("AUD", "AUD 12.34"),
    ("NZD", "NZD 12.34"),
    ("CHF", "CHF 12.34"),
    ("AED", "AED 12.34"),
    ("CNY", "CNY 12.34"),
    ("HKD", "HKD 12.34"),
    ("SGD", "SGD 12.34"),
    ("INR", "INR 12.34"),
    ("MXN", "MXN 12.34"),
    ("BRL", "BRL 12.34"),
    ("DKK", "DKK 12.34"),
    ("NOK", "NOK 12.34"),
    ("SEK", "SEK 12.34"),
    ("PLN", "PLN 12.34"),
    ("HUF", "HUF 12.34"),
    ("TWD", "TWD 12.34"),
    ("ISK", "ISK 12.34"),
    ("UGX", "UGX 12.34"),
    ("BIF", "BIF 1234"),
    ("CLP", "CLP 1234"),
    ("DJF", "DJF 1234"),
    ("GNF", "GNF 1234"),
    ("JPY", "JPY 1234"),
    ("KMF", "KMF 1234"),
    ("KRW", "KRW 1234"),
    ("MGA", "MGA 1234"),
    ("PYG", "PYG 1234"),
    ("RWF", "RWF 1234"),
    ("VND", "VND 1234"),
    ("VUV", "VUV 1234"),
    ("XAF", "XAF 1234"),
    ("XOF", "XOF 1234"),
    ("XPF", "XPF 1234"),
    ("BHD", "BHD 1.234"),
    ("JOD", "JOD 1.234"),
    ("KWD", "KWD 1.234"),
    ("OMR", "OMR 1.234"),
    ("TND", "TND 1.234"),
)


class _IntSubclass(int):
    pass


class _StringSubclass(str):
    pass


class _UnusableFact:
    def __str__(self):
        raise AssertionError("must not coerce a source fact")

    def __repr__(self):
        raise AssertionError("must not expose a source fact")

    def __eq__(self, other):
        raise AssertionError("must not compare a malformed source fact")


@pytest.mark.parametrize("currency,expected", _SUPPORTED_EXAMPLES)
def test_exact_approved_currency_examples(currency, expected):
    assert format_workflow_money(1234, currency, unit_convention="stripe_minor_units") == expected


def test_only_the_exact_42_approved_ascii_codes_are_supported():
    supported = {currency for currency, _ in _SUPPORTED_EXAMPLES}
    assert len(supported) == 42
    for letters in product(ascii_uppercase, repeat=3):
        currency = "".join(letters)
        if currency not in supported:
            with pytest.raises(WorkflowMoneyFormatError) as caught:
                format_workflow_money(1234, currency, unit_convention="stripe_minor_units")
            assert caught.value.reason == "unsupported_currency"


@pytest.mark.parametrize("currency,expected", _SUPPORTED_EXAMPLES)
def test_currency_letter_case_is_normalized(currency, expected):
    for variant in (currency.lower(), currency[0].lower() + currency[1:]):
        assert (
            format_workflow_money(1234, variant, unit_convention="stripe_minor_units") == expected
        )


@pytest.mark.parametrize(
    "amount,currency,expected",
    [
        (0, "USD", "USD 0.00"),
        (0, "JPY", "JPY 0"),
        (0, "KWD", "KWD 0.000"),
        (-1, "USD", "USD -0.01"),
        (-1, "JPY", "JPY -1"),
        (-1, "KWD", "KWD -0.001"),
        (-1234, "USD", "USD -12.34"),
        (-1234, "JPY", "JPY -1234"),
        (-1234, "KWD", "KWD -1.234"),
        (525, "ISK", "ISK 5.25"),
        (500, "UGX", "UGX 5.00"),
        (501, "UGX", "UGX 5.01"),
        (-525, "ISK", "ISK -5.25"),
        (-501, "UGX", "UGX -5.01"),
        (1, "HUF", "HUF 0.01"),
        (1, "TWD", "TWD 0.01"),
        (1001, "BHD", "BHD 1.001"),
        (1010, "JOD", "JOD 1.010"),
        (9007199254740993, "USD", "USD 90071992547409.93"),
        (9223372036854775807, "USD", "USD 92233720368547758.07"),
        (-9223372036854775808, "USD", "USD -92233720368547758.08"),
        (9223372036854775807, "JPY", "JPY 9223372036854775807"),
        (-9223372036854775808, "JPY", "JPY -9223372036854775808"),
        (9223372036854775807, "KWD", "KWD 9223372036854775.807"),
        (-9223372036854775808, "KWD", "KWD -9223372036854775.808"),
    ],
)
def test_exact_signed_amounts_and_historical_precision(amount, currency, expected):
    assert format_workflow_money(amount, currency, unit_convention="stripe_minor_units") == expected


@pytest.mark.parametrize("currency,example", _SUPPORTED_EXAMPLES)
def test_boundary_arithmetic_matches_independent_decimal_oracle(currency, example):
    fraction_digits = len(example.partition(".")[2])
    for amount in (-(2**63), -(2**53) - 1, -1001, -1, 0, 1, 1001, 2**53 + 1, 2**63 - 1):
        with localcontext() as context:
            context.prec = 30
            major = Decimal(amount).scaleb(-fraction_digits)
            expected = f"{currency} {major:.{fraction_digits}f}"
        assert (
            format_workflow_money(amount, currency, unit_convention="stripe_minor_units")
            == expected
        )


@pytest.mark.parametrize("amount", [-(2**63), -1, 0, 1234, 2**53 + 1, 2**63 - 1])
@pytest.mark.parametrize("currency", ["USD", "usd", "uSd"])
def test_known_usd_cents_matches_stripe_usd(amount, currency):
    assert format_workflow_money(
        amount, currency, unit_convention="usd_cents"
    ) == format_workflow_money(amount, currency, unit_convention="stripe_minor_units")


@pytest.mark.parametrize(
    "amount",
    [
        None,
        True,
        False,
        1.0,
        float("nan"),
        float("inf"),
        "1234",
        Decimal(1234),
        [],
        {},
        _IntSubclass(1),
        2**63,
        -(2**63) - 1,
        10**10000,
    ],
    ids=[
        "null",
        "true",
        "false",
        "float",
        "nan",
        "infinity",
        "string",
        "decimal",
        "list",
        "dict",
        "int-subclass",
        "above-int64",
        "below-int64",
        "huge-integer",
    ],
)
@pytest.mark.parametrize("currency", ["USD", "ZZZ", None])
def test_malformed_amount_is_unavailable_before_currency_support(amount, currency):
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(amount, currency, unit_convention="stripe_minor_units")
    assert caught.value.reason == "facts_unavailable"


@pytest.mark.parametrize(
    "currency",
    [
        None,
        "",
        " ",
        "   ",
        " USD",
        "USD ",
        "USD\n",
        "US",
        "USDD",
        "US1",
        "U$D",
        "US\x00",
        "ＵＳＤ",
        "UŚD",
        "ısd",
        "uſd",
        "uKd",
        b"USD",
        True,
        123,
        [],
        {},
        _StringSubclass("USD"),
    ],
)
def test_missing_or_malformed_currency_is_unavailable(currency):
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(1234, currency, unit_convention="stripe_minor_units")
    assert caught.value.reason == "facts_unavailable"


@pytest.mark.parametrize(
    "unit_convention",
    [
        None,
        "",
        "STRIPE_MINOR_UNITS",
        "stripe_minor_units ",
        " usd_cents",
        "cents",
        "USD_CENTS",
        "usd_centſ",
        True,
        100,
        b"usd_cents",
        [],
        {},
        {"usd_cents"},
        _StringSubclass("usd_cents"),
    ],
)
@pytest.mark.parametrize("currency", ["USD", "ZZZ", None])
def test_malformed_convention_is_unavailable_before_currency_support(unit_convention, currency):
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(1234, currency, unit_convention=unit_convention)
    assert caught.value.reason == "facts_unavailable"


@pytest.mark.parametrize("currency", ["EUR", "JPY", "KWD", "ISK", "UGX", "ZZZ", "zar", "BTC"])
def test_usd_cents_currency_disagreement_is_unavailable(currency):
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(1234, currency, unit_convention="usd_cents")
    assert caught.value.reason == "facts_unavailable"


def test_convention_is_a_required_keyword_only_argument():
    with pytest.raises(TypeError):
        format_workflow_money(1234, "USD")
    with pytest.raises(TypeError):
        format_workflow_money(1234, "USD", "usd_cents")


def test_currency_is_required_without_a_usd_default():
    with pytest.raises(TypeError):
        format_workflow_money(1234, unit_convention="stripe_minor_units")


@pytest.mark.parametrize("currency", ["ZAR", "zar", "ZZZ", "BTC"])
def test_known_unsupported_code_has_fixed_reason(currency):
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(1234, currency, unit_convention="stripe_minor_units")
    assert caught.value.reason == "unsupported_currency"


@pytest.mark.parametrize(
    "amount,currency,unit_convention,reason",
    [
        (918273645546372819, "ZZZ", "stripe_minor_units", "unsupported_currency"),
        ("private_amount", "secret_currency", "private_convention", "facts_unavailable"),
        (918273645546372819, "ZZZ", "usd_cents", "facts_unavailable"),
        (None, "ZZZ", "stripe_minor_units", "facts_unavailable"),
    ],
)
def test_errors_contain_only_the_fixed_reason(amount, currency, unit_convention, reason):
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(amount, currency, unit_convention=unit_convention)
    error = caught.value
    assert error.args == (reason,)
    assert str(error) == reason
    assert repr(error) == f"WorkflowMoneyFormatError({reason!r})"


@pytest.mark.parametrize("position", ["amount", "currency", "convention", "all"])
def test_malformed_objects_are_not_coerced_compared_or_represented(position):
    fact = _UnusableFact()
    with pytest.raises(WorkflowMoneyFormatError) as caught:
        format_workflow_money(
            fact if position in ("amount", "all") else 1234,
            fact if position in ("currency", "all") else "USD",
            unit_convention=fact if position in ("convention", "all") else "stripe_minor_units",
        )
    assert str(caught.value) == "facts_unavailable"
    assert repr(caught.value) == "WorkflowMoneyFormatError('facts_unavailable')"


@pytest.mark.parametrize("reason", ["facts_unavailable", "unsupported_currency"])
def test_error_reason_is_read_only(reason):
    error = WorkflowMoneyFormatError(reason)
    with pytest.raises(AttributeError):
        error.reason = "other"
    with pytest.raises(AttributeError):
        del error.reason
    assert error.reason == reason


@pytest.mark.parametrize("reason", ["private_fact", None, [], _StringSubclass("facts_unavailable")])
def test_error_cannot_be_constructed_with_an_unrecognized_reason(reason):
    with pytest.raises(ValueError, match="^invalid_workflow_money_format_reason$"):
        WorkflowMoneyFormatError(reason)


def test_currency_map_is_immutable_and_calls_are_deterministic():
    with pytest.raises(TypeError):
        workflow_money._CURRENCY_FRACTION_DIGITS["USD"] = 0
    with pytest.raises(TypeError):
        workflow_money._CURRENCY_FRACTION_DIGITS["ZZZ"] = 2
    for _ in range(3):
        assert format_workflow_money(1234, "USD", unit_convention="usd_cents") == "USD 12.34"
        assert (
            format_workflow_money(1234, "JPY", unit_convention="stripe_minor_units") == "JPY 1234"
        )
        assert format_workflow_money(525, "ISK", unit_convention="stripe_minor_units") == "ISK 5.25"
