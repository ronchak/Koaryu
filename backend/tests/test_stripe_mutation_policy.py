import ast
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

from fastapi import HTTPException

from app.services.stripe_mutation_policy import (
    LIVE_MUTATIONS_DISABLED_DETAIL,
    LIVE_MUTATIONS_REQUIRE_DURABLE_AUTHORIZATION_DETAIL,
    STRIPE_MODE_MISMATCH_DETAIL,
    StripeMutationPolicy,
)
from app.services.stripe_service import StripeService


REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_APP_DIR = REPO_ROOT / "backend" / "app"
SERVICES_DIR = BACKEND_APP_DIR / "services"
READ_ONLY_STRIPE_METHODS = {"construct_event", "list", "retrieve"}
HTTP_MUTATION_METHODS = {"delete", "patch", "post", "put", "request"}


def _dotted_name(node: ast.AST) -> str | None:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Call):
        called = _dotted_name(node.func) or ""
        if called.rsplit(".", 1)[-1] == "_stripe":
            return "$stripe"
        return None
    if isinstance(node, ast.Attribute):
        prefix = _dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return None


class _StripeProviderCallVisitor(ast.NodeVisitor):
    def __init__(self, path: Path):
        self.path = path
        self.path_label = path.relative_to(REPO_ROOT).as_posix()
        self.function_stack: list[str] = []
        self.provider_alias_stack: list[set[str]] = []
        self.direct_symbol_stack: list[set[str]] = []
        self.module_provider_aliases = {"stripe"}
        self.module_direct_symbols: set[str] = set()
        self.httpx_aliases = {"httpx"}
        self.httpx_mutation_names: set[str] = set()
        self.httpx_client_constructor_names: set[str] = set()
        self.httpx_client_aliases: set[str] = set()
        self.raw_sink_names = {"stripe_v2_request"}
        self.gateway_constructor_names = {"StripeConnectGateway"}
        self.raw_calls: set[tuple[str, str, str]] = set()
        self.raw_sink_callers: set[tuple[str, str, str]] = set()
        self.gateway_constructors: set[tuple[str, str, str]] = set()

    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self.function_stack.append(node.name)
        inherited_aliases = (
            self.provider_alias_stack[-1]
            if self.provider_alias_stack
            else self.module_provider_aliases
        )
        inherited_symbols = (
            self.direct_symbol_stack[-1]
            if self.direct_symbol_stack
            else self.module_direct_symbols
        )
        self.provider_alias_stack.append(set(inherited_aliases))
        self.direct_symbol_stack.append(set(inherited_symbols))
        self.generic_visit(node)
        self.direct_symbol_stack.pop()
        self.provider_alias_stack.pop()
        self.function_stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Import(self, node: ast.Import) -> None:
        for imported in node.names:
            if imported.name == "stripe":
                alias = imported.asname or "stripe"
                if self.provider_alias_stack:
                    self.provider_alias_stack[-1].add(alias)
                else:
                    self.module_provider_aliases.add(alias)
            if imported.name == "httpx":
                self.httpx_aliases.add(imported.asname or "httpx")

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        module = node.module or ""
        if module == "stripe" or module.startswith("stripe."):
            target = self.direct_symbol_stack[-1] if self.direct_symbol_stack else self.module_direct_symbols
            for imported in node.names:
                target.add(imported.asname or imported.name)
        if module.endswith("stripe_connect_gateway"):
            for imported in node.names:
                alias = imported.asname or imported.name
                if imported.name == "stripe_v2_request":
                    self.raw_sink_names.add(alias)
                if imported.name == "StripeConnectGateway":
                    self.gateway_constructor_names.add(alias)
        if module == "httpx":
            for imported in node.names:
                if imported.name in HTTP_MUTATION_METHODS:
                    self.httpx_mutation_names.add(imported.asname or imported.name)
                if imported.name in {"AsyncClient", "Client"}:
                    self.httpx_client_constructor_names.add(imported.asname or imported.name)

    @staticmethod
    def _target_names(targets: list[ast.AST]) -> set[str]:
        return {name for target in targets if (name := _dotted_name(target))}

    def _track_assignment(self, value: ast.AST, targets: list[ast.AST]) -> None:
        value_name = _dotted_name(value) or (
            _dotted_name(value.func) if isinstance(value, ast.Call) else ""
        ) or ""
        if not value_name:
            return
        target_names = self._target_names(targets)
        if not target_names:
            return

        aliases = self.provider_alias_stack[-1] if self.provider_alias_stack else self.module_provider_aliases
        direct_symbols = self.direct_symbol_stack[-1] if self.direct_symbol_stack else self.module_direct_symbols
        provider_alias = value_name == "$stripe" or value_name in aliases
        provider_symbol = value_name in direct_symbols or any(
            value_name.startswith(f"{alias}.") for alias in aliases | {"$stripe"}
        )
        if provider_alias:
            aliases.update(target_names)
        elif provider_symbol:
            direct_symbols.update(target_names)

        terminal = value_name.rsplit(".", 1)[-1]
        if terminal in self.raw_sink_names:
            self.raw_sink_names.update(target_names)
        if terminal in self.gateway_constructor_names:
            self.gateway_constructor_names.update(target_names)
        if value_name in self.httpx_aliases:
            self.httpx_aliases.update(target_names)
        if terminal in HTTP_MUTATION_METHODS and any(
            value_name.startswith(f"{alias}.") for alias in self.httpx_aliases
        ):
            self.httpx_mutation_names.update(target_names)
        if isinstance(value, ast.Call):
            constructor = _dotted_name(value.func) or ""
            terminal = constructor.rsplit(".", 1)[-1]
            if (
                terminal in self.httpx_client_constructor_names
                or (
                    terminal in {"AsyncClient", "Client"}
                    and any(
                        constructor.startswith(f"{alias}.")
                        for alias in self.httpx_aliases
                    )
                )
            ):
                self.httpx_client_aliases.update(target_names)

    def visit_Assign(self, node: ast.Assign) -> None:
        self._track_assignment(node.value, list(node.targets))
        self.generic_visit(node)

    def visit_AnnAssign(self, node: ast.AnnAssign) -> None:
        if node.value is not None:
            self._track_assignment(node.value, [node.target])
        self.generic_visit(node)

    def visit_With(self, node: ast.With) -> None:
        for item in node.items:
            if item.optional_vars is not None:
                self._track_assignment(item.context_expr, [item.optional_vars])
        self.generic_visit(node)

    visit_AsyncWith = visit_With

    def visit_Call(self, node: ast.Call) -> None:
        called = _dotted_name(node.func) or ""
        function_name = self.function_stack[-1] if self.function_stack else "<module>"
        terminal = called.rsplit(".", 1)[-1]
        aliases = self.provider_alias_stack[-1] if self.provider_alias_stack else {"stripe"}
        direct_symbols = self.direct_symbol_stack[-1] if self.direct_symbol_stack else self.module_direct_symbols
        provider_reference = any(
            called == alias or called.startswith(f"{alias}.")
            for alias in aliases | direct_symbols | {"$stripe"}
        )
        httpx_mutation = (
            called in self.httpx_mutation_names
            or (
                terminal in HTTP_MUTATION_METHODS
                and any(
                    called.startswith(f"{alias}.")
                    for alias in self.httpx_aliases
                )
            )
            or (
                terminal in HTTP_MUTATION_METHODS
                and any(
                    called.startswith(f"{alias}.")
                    for alias in self.httpx_client_aliases
                )
            )
        )

        if (
            (
                provider_reference and terminal not in READ_ONLY_STRIPE_METHODS
            )
            or httpx_mutation
            or terminal in {"_stripe_v2_patch", "_stripe_v2_post"}
        ):
            self.raw_calls.add((self.path_label, function_name, called))

        if terminal in self.raw_sink_names:
            self.raw_sink_callers.add((self.path_label, function_name, called))
        if terminal in self.gateway_constructor_names:
            self.gateway_constructors.add((self.path_label, function_name, called))

        self.generic_visit(node)


def _stripe_provider_inventory() -> tuple[
    set[tuple[str, str, str]],
    set[tuple[str, str, str]],
    set[tuple[str, str, str]],
]:
    raw_calls: set[tuple[str, str, str]] = set()
    raw_sink_callers: set[tuple[str, str, str]] = set()
    gateway_constructors: set[tuple[str, str, str]] = set()
    for root in (
        BACKEND_APP_DIR,
        REPO_ROOT / "backend" / "scripts",
        REPO_ROOT / "scripts",
    ):
        for path in root.rglob("*.py"):
            visitor = _StripeProviderCallVisitor(path)
            visitor.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
            raw_calls.update(visitor.raw_calls)
            raw_sink_callers.update(visitor.raw_sink_callers)
            gateway_constructors.update(visitor.gateway_constructors)
    return raw_calls, raw_sink_callers, gateway_constructors


def _probe_provider_inventory(source: str) -> set[tuple[str, str, str]]:
    visitor = _StripeProviderCallVisitor(BACKEND_APP_DIR / "inventory_probe.py")
    visitor.visit(ast.parse(source))
    return visitor.raw_calls | visitor.raw_sink_callers | visitor.gateway_constructors


def _settings(*, mode: str, live_enabled: bool = False, key_mode: str | None = None):
    effective_key_mode = key_mode or mode
    return SimpleNamespace(
        STRIPE_MODE=mode,
        LIVE_BILLING_ENABLED=live_enabled,
        STRIPE_SECRET_KEY=f"sk_{effective_key_mode}_fixture",
        STRIPE_KOARYU_CORE_PRICE_ID="price_fixture",
    )


class _Customer:
    calls = []

    @classmethod
    def create(cls, **payload):
        cls.calls.append(payload)
        return {"id": "cus_test"}


class _Stripe:
    Customer = _Customer


class StripeMutationPolicyTest(unittest.TestCase):
    def test_test_mode_mutations_are_automatically_permitted(self):
        service = StripeService()
        service.settings = _settings(mode="test")
        service._stripe = lambda: _Stripe
        _Customer.calls = []

        customer = service.create_customer(name="Test Studio", metadata={"studio_id": "studio_1"})

        self.assertEqual(customer["id"], "cus_test")
        self.assertEqual(len(_Customer.calls), 1)

    def test_live_mutations_fail_before_loading_stripe_when_switch_is_off(self):
        service = StripeService()
        service.settings = _settings(mode="live", live_enabled=False)
        service._stripe = Mock(side_effect=AssertionError("Stripe client must not load"))

        with self.assertRaises(HTTPException) as raised:
            service.create_customer(name="Live Studio", metadata={})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        service._stripe.assert_not_called()

    def test_live_switch_is_not_sufficient_without_durable_authorization(self):
        policy = StripeMutationPolicy(_settings(mode="live", live_enabled=True))

        with self.assertRaises(HTTPException) as raised:
            policy.issue_permit("customer.create")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(
            raised.exception.detail,
            LIVE_MUTATIONS_REQUIRE_DURABLE_AUTHORIZATION_DETAIL,
        )
        self.assertFalse(policy.live_payments_authorized())

    def test_declared_mode_and_secret_key_must_match(self):
        policy = StripeMutationPolicy(_settings(mode="test", key_mode="live"))

        with self.assertRaises(HTTPException) as raised:
            policy.issue_permit("customer.create")

        self.assertEqual(raised.exception.detail, STRIPE_MODE_MISMATCH_DETAIL)

    def test_declared_mode_without_a_secret_key_fails_closed(self):
        settings = _settings(mode="test")
        settings.STRIPE_SECRET_KEY = ""

        with self.assertRaises(HTTPException) as raised:
            StripeMutationPolicy(settings).issue_permit("customer.create")

        self.assertEqual(raised.exception.detail, STRIPE_MODE_MISMATCH_DETAIL)

    def test_every_direct_stripe_service_mutation_is_policy_marked(self):
        expected = {
            "_stripe_v2_patch",
            "_stripe_v2_post",
            "_stripe_v2_request",
            "cancel_connected_subscription",
            "create_connect_account",
            "create_connect_onboarding_link",
            "create_connected_customer",
            "create_connected_invoice",
            "create_connected_invoice_item",
            "create_connected_price",
            "create_connected_product",
            "create_connected_refund",
            "create_connected_subscription",
            "create_connected_subscription_item",
            "create_core_checkout_session",
            "create_customer",
            "create_customer_portal_session",
            "create_setup_checkout_session",
            "delete_connected_subscription_item",
            "finalize_connected_invoice",
            "pay_connected_invoice",
            "send_connected_invoice",
            "set_connected_customer_default_payment_method",
            "update_connect_account_branding",
            "update_connected_customer",
            "update_connected_product",
            "update_connected_subscription",
            "update_connected_subscription_item",
            "upload_branding_file",
            "void_connected_invoice",
        }
        marked = {
            name
            for name in dir(StripeService)
            if getattr(
                getattr(StripeService, name),
                "__stripe_mutation_operation__",
                None,
            )
        }

        self.assertEqual(marked, expected)

    def test_raw_stripe_provider_mutation_inventory_is_exact(self):
        expected_raw_calls = {(f"backend/app/services/{path}", function, call) for path, function, call in {
            ("stripe_connect_gateway.py", "stripe_v2_request", "httpx.request"),
            ("stripe_connect_gateway.py", "upload_branding_file", "stripe.File.create"),
            ("stripe_connect_gateway.py", "update_branding", "self._stripe_v2_patch"),
            ("stripe_connect_gateway.py", "update_branding", "stripe.Account.modify"),
            ("stripe_connect_gateway.py", "create_onboarding_link", "self._stripe_v2_post"),
            ("stripe_connect_gateway.py", "_create_legacy_onboarding_link", "stripe.AccountLink.create"),
            ("stripe_connect_gateway.py", "_create_legacy_dashboard_login_url", "stripe.Account.create_login_link"),
            ("stripe_connect_gateway.py", "_create_account_v2", "self._stripe_v2_post"),
            ("stripe_connect_gateway.py", "_create_account_v1", "stripe.Account.create"),
            ("stripe_service.py", "create_customer", "stripe.Customer.create"),
            ("stripe_service.py", "create_connected_customer", "stripe.Customer.create"),
            ("stripe_service.py", "update_connected_customer", "stripe.Customer.modify"),
            ("stripe_service.py", "set_connected_customer_default_payment_method", "stripe.Customer.modify"),
            ("stripe_service.py", "create_connected_product", "stripe.Product.create"),
            ("stripe_service.py", "update_connected_product", "stripe.Product.modify"),
            ("stripe_service.py", "create_connected_price", "stripe.Price.create"),
            ("stripe_service.py", "create_setup_checkout_session", "stripe.checkout.Session.create"),
            ("stripe_service.py", "create_connected_subscription", "stripe.Subscription.create"),
            ("stripe_service.py", "create_connected_subscription_item", "stripe.SubscriptionItem.create"),
            ("stripe_service.py", "update_connected_subscription_item", "stripe.SubscriptionItem.modify"),
            ("stripe_service.py", "delete_connected_subscription_item", "stripe.SubscriptionItem.delete"),
            ("stripe_service.py", "update_connected_subscription", "stripe.Subscription.modify"),
            ("stripe_service.py", "cancel_connected_subscription", "stripe.Subscription.cancel"),
            ("stripe_service.py", "create_connected_invoice_item", "stripe.InvoiceItem.create"),
            ("stripe_service.py", "create_connected_invoice", "stripe.Invoice.create"),
            ("stripe_service.py", "finalize_connected_invoice", "stripe.Invoice.finalize_invoice"),
            ("stripe_service.py", "send_connected_invoice", "stripe.Invoice.send_invoice"),
            ("stripe_service.py", "pay_connected_invoice", "stripe.Invoice.pay"),
            ("stripe_service.py", "void_connected_invoice", "stripe.Invoice.void_invoice"),
            ("stripe_service.py", "create_connected_refund", "stripe.Refund.create"),
            ("stripe_service.py", "create_core_checkout_session", "stripe.checkout.Session.create"),
            ("stripe_service.py", "create_customer_portal_session", "stripe.billing_portal.Session.create"),
        }}
        # The source-wide HTTP mutation guard intentionally inventories this
        # test-only webhook smoke request even though its destination is Koaryu,
        # not Stripe. Any new direct HTTP mutation still requires review here.
        expected_raw_calls.add((
            "scripts/verify-connect-webhook-smoke.py",
            "_post",
            "httpx.post",
        ))
        expected_raw_sink_callers = {(f"backend/app/services/{path}", function, call) for path, function, call in {
            ("stripe_service.py", "_stripe_v2_request", "stripe_v2_request"),
        }}
        expected_gateway_constructors = {
            ("backend/app/services/stripe_service.py", "_connect_gateway", "StripeConnectGateway"),
        }

        raw_calls, raw_sink_callers, gateway_constructors = _stripe_provider_inventory()

        self.assertEqual(raw_calls, expected_raw_calls)
        self.assertEqual(raw_sink_callers, expected_raw_sink_callers)
        self.assertEqual(gateway_constructors, expected_gateway_constructors)

    def test_provider_inventory_detects_direct_chain_and_import_alias_bypasses(self):
        probes = {
            "direct_chain": """
class Probe:
    def bypass(self):
        self._stripe().Customer.create(name="unsafe")
""",
            "module_alias": """
import stripe as provider

def bypass():
    provider.Customer.create(name="unsafe")
""",
            "direct_symbol": """
from stripe import Customer

def bypass():
    Customer.create(name="unsafe")
""",
            "module_assignment": """
import stripe
provider = stripe

def bypass():
    provider.Customer.create(name="unsafe")
""",
            "symbol_assignment": """
import stripe
Customer = stripe.Customer

def bypass():
    Customer.create(name="unsafe")
""",
            "raw_sink_assignment": """
from app.services.stripe_connect_gateway import stripe_v2_request
mutate = stripe_v2_request

def bypass(settings):
    mutate(settings, "POST", "/v2/core/accounts", {})
""",
            "direct_http_post": """
import httpx

def bypass():
    httpx.post("https://api.stripe.com/v1/customers", json={})
""",
            "sync_http_client": """
import httpx

def bypass():
    client = httpx.Client()
    client.post("https://api.stripe.com/v1/customers", json={})
""",
            "async_http_client": """
import httpx

async def bypass():
    async with httpx.AsyncClient() as client:
        await client.post("https://api.stripe.com/v1/customers", json={})
""",
        }

        for name, source in probes.items():
            with self.subTest(name=name):
                self.assertTrue(_probe_provider_inventory(source))

    def test_non_python_runtime_sources_do_not_call_stripe_directly(self):
        forbidden_fragments = (
            "api.stripe.com",
            'from "stripe"',
            "from 'stripe'",
            'require("stripe")',
            "require('stripe')",
        )
        offenders: list[str] = []
        for root in (REPO_ROOT / "frontend" / "src", REPO_ROOT / "scripts"):
            for suffix in ("*.js", "*.mjs", "*.ts", "*.tsx", "*.sh"):
                for path in root.rglob(suffix):
                    source = path.read_text(encoding="utf-8")
                    if any(fragment in source for fragment in forbidden_fragments):
                        offenders.append(path.relative_to(REPO_ROOT).as_posix())

        self.assertEqual(offenders, [])

    def test_python_stripe_rest_host_is_confined_to_the_guarded_gateway(self):
        allowed = {"backend/app/services/stripe_connect_gateway.py"}
        offenders: list[str] = []
        for root in (
            BACKEND_APP_DIR,
            REPO_ROOT / "backend" / "scripts",
            REPO_ROOT / "scripts",
        ):
            for path in root.rglob("*.py"):
                if "api.stripe.com" not in path.read_text(encoding="utf-8"):
                    continue
                relative = path.relative_to(REPO_ROOT).as_posix()
                if relative not in allowed:
                    offenders.append(relative)

        self.assertEqual(offenders, [])

    def test_connect_gateway_receives_the_policy_authorizer(self):
        service = StripeService()
        authorizer = Mock()
        service._authorize_stripe_mutation = authorizer

        gateway = service._connect_gateway()

        self.assertIs(gateway._authorize_mutation, authorizer)

    def test_live_legacy_dashboard_login_link_is_closed_without_mutating(self):
        calls = []

        class _Account:
            @staticmethod
            def retrieve(_account_id):
                return {"id": "acct_legacy", "type": "express"}

            @staticmethod
            def create_login_link(account_id):
                calls.append(account_id)
                return {"url": "https://dashboard.stripe.test/login"}

        service = StripeService()
        service.settings = _settings(mode="live", live_enabled=False)
        service._stripe = lambda: SimpleNamespace(Account=_Account)

        with self.assertRaises(HTTPException) as raised:
            service.create_connect_dashboard_url(account_id="acct_legacy")

        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
