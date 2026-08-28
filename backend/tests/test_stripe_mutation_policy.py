import ast
import inspect
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from fastapi import HTTPException

from app.services.stripe_mutation_policy import (
    LIVE_MUTATIONS_DISABLED_DETAIL,
    STRIPE_MODE_MISMATCH_DETAIL,
    STRIPE_OPERATION_UNSUPPORTED_DETAIL,
    StripeMutationPolicy,
)
from app.services.studio_live_billing_authorizations import (
    ConnectOnboardingBootstrapContext,
    LIVE_SCOPE_REQUIRED_DETAIL,
    connect_initial_link_context_sha256,
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


def _settings(
    *,
    mode: str,
    live_enabled: bool = False,
    core_self_checkout_enabled: bool = False,
    key_mode: str | None = None,
    environment: str | None = None,
):
    effective_key_mode = key_mode or mode
    return SimpleNamespace(
        STRIPE_MODE=mode,
        LIVE_BILLING_ENABLED=live_enabled,
        CORE_SELF_CHECKOUT_ENABLED=core_self_checkout_enabled,
        STRIPE_SECRET_KEY=f"sk_{effective_key_mode}_fixture",
        STRIPE_KOARYU_CORE_PRICE_ID="price_fixture",
        ENVIRONMENT=environment or ("production" if mode == "live" else "test"),
    )


class _Customer:
    calls = []

    @classmethod
    def create(cls, **payload):
        cls.calls.append(payload)
        return {"id": "cus_test"}


class _Stripe:
    Customer = _Customer


class _AuthorizedStore:
    def __init__(self, studio_id="studio_1"):
        self.studio_id = studio_id
        self.calls = []

    def authorize(self, **payload):
        self.calls.append(payload)
        return self.studio_id


class StripeMutationPolicyTest(unittest.TestCase):
    def test_unowned_connected_customer_default_mutation_is_explicitly_unsupported(self):
        with self.assertRaises(HTTPException) as raised:
            StripeMutationPolicy(_settings(mode="test")).issue_permit(
                "connected_customer.default_payment_method.update",
                studio_id="studio_1",
                account_id="acct_1",
            )

        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, STRIPE_OPERATION_UNSUPPORTED_DETAIL)

    def test_test_mode_mutations_require_explicit_scope_then_run_without_live_grant(self):
        service = StripeService()
        service.settings = _settings(mode="test")
        service._stripe = lambda: _Stripe
        _Customer.calls = []

        customer = service.create_customer(
            name="Test Studio", studio_id="studio_1", metadata={"studio_id": "studio_1"},
        )

        self.assertEqual(customer["id"], "cus_test")
        self.assertEqual(len(_Customer.calls), 1)

        with self.assertRaises(HTTPException) as raised:
            StripeMutationPolicy(_settings(mode="test")).issue_permit("customer.create")
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_REQUIRED_DETAIL)

    def test_raw_v2_sink_rejects_operation_path_mismatch_before_provider_call(self):
        service = StripeService()
        service.settings = _settings(mode="test")

        with self.assertRaises(HTTPException) as raised:
            service._stripe_v2_post(
                "/v2/core/accounts",
                {"contact_email": "operator@example.invalid"},
                operation="connect_onboarding_link.create",
                studio_id="studio_1",
            )

        self.assertIn("does not match", raised.exception.detail)

    def test_accountless_v2_connect_create_passes_the_full_policy_chain(self):
        service = StripeService()
        service.settings = _settings(mode="test")

        with patch("app.services.stripe_service.stripe_v2_request", return_value={"id": "acct_test"}) as raw:
            result = service.create_connect_account(
                studio_id="studio_1",
                business_name="Test Studio",
            )

        self.assertEqual(result, {"id": "acct_test"})
        raw.assert_called_once()
        self.assertEqual(raw.call_args.args[1:3], ("POST", "/v2/core/accounts"))

    def test_accountless_v2_non_create_operation_is_denied(self):
        service = StripeService()
        service.settings = _settings(mode="test")

        with patch("app.services.stripe_service.stripe_v2_request") as raw:
            with self.assertRaises(HTTPException) as raised:
                service._stripe_v2_post(
                    "/v2/core/account_links",
                    {"account": "acct_1"},
                    operation="connect_onboarding_link.create",
                    studio_id="studio_1",
                    account_id=None,
                )

        self.assertIn("does not match", raised.exception.detail)
        raw.assert_not_called()

    def test_v2_semantic_gate_binds_payload_and_path_to_authorized_context(self):
        service = StripeService()
        service.settings = _settings(mode="test")
        mismatches = (
            ("POST", "/v2/core/accounts", {"metadata": {"studio_id": "studio_2"}},
             "connect_account.create", "studio_1", None),
            ("POST", "/v2/core/account_links", {"account": "acct_2"},
             "connect_onboarding_link.create", "studio_1", "acct_1"),
            ("PATCH", "/v2/core/accounts/acct_2", {"configuration": {}},
             "connect_account.branding.update", "studio_1", "acct_1"),
            ("POST", "/v2/core/account_links", {"account": "acct_1", "use_case": {"type": "other"}},
             "connect_onboarding_link.create", "studio_1", "acct_1"),
            ("PATCH", "/v2/core/accounts/acct_1", {
                "configuration": {"merchant": {"capabilities": {"card_payments": {"requested": False}}}},
                "include": ["configuration.merchant"],
            }, "connect_account.branding.update", "studio_1", "acct_1"),
        )

        with patch("app.services.stripe_service.stripe_v2_request") as raw:
            for method, path, payload, operation, studio_id, account_id in mismatches:
                with self.subTest(operation=operation):
                    with self.assertRaises(HTTPException) as raised:
                        service._stripe_v2_request(
                            method,
                            path,
                            payload,
                            operation=operation,
                            studio_id=studio_id,
                            account_id=account_id,
                        )
                    self.assertIn("does not match", raised.exception.detail)

        raw.assert_not_called()

    def test_bootstrap_sink_rejects_changed_idempotency_key_before_provider_call(self):
        service = StripeService()
        service.settings = _settings(mode="test")
        context = ConnectOnboardingBootstrapContext(
            account_generation=1,
            initial_link_context_sha256="b" * 64,
            account_create_idempotency_key="koaryu-connect-account-studio_1-g1",
            initial_link_idempotency_key="koaryu-connect-onboarding-studio_1-g1-" + "c" * 24,
        )
        payload = {
            "account": "acct_1",
            "use_case": {
                "type": "account_onboarding",
                "account_onboarding": {
                    "configurations": ["merchant"],
                    "collection_options": {"fields": "eventually_due"},
                    "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
                    "return_url": "https://app.koaryu.test/billing?connect=return",
                },
            },
        }

        with patch("app.services.stripe_service.stripe_v2_request") as raw:
            with self.assertRaises(HTTPException) as raised:
                service._stripe_v2_post(
                    "/v2/core/account_links",
                    payload,
                    operation="connect_onboarding_link.create",
                    studio_id="studio_1",
                    account_id="acct_1",
                    idempotency_key="koaryu-connect-onboarding-studio_1-g1-" + "d" * 24,
                    bootstrap_context=context,
                )

        self.assertIn("idempotency context", raised.exception.detail)
        raw.assert_not_called()

    def test_bootstrap_sink_rejects_changed_initial_link_context_before_provider_call(self):
        service = StripeService()
        service.settings = _settings(mode="test")
        link_key = "koaryu-connect-onboarding-studio_1-g1-" + "c" * 24
        context = ConnectOnboardingBootstrapContext(
            account_generation=1,
            initial_link_context_sha256=connect_initial_link_context_sha256(
                studio_id="studio_1",
                account_generation=1,
                refresh_url="https://app.koaryu.test/billing/connect/refresh",
                return_url="https://app.koaryu.test/billing?connect=return",
            ),
            account_create_idempotency_key="koaryu-connect-account-studio_1-g1",
            initial_link_idempotency_key=link_key,
        )
        payload = {
            "account": "acct_1",
            "use_case": {
                "type": "account_onboarding",
                "account_onboarding": {
                    "configurations": ["merchant"],
                    "collection_options": {"fields": "eventually_due"},
                    "refresh_url": "https://app.koaryu.test/billing/connect/refresh",
                    "return_url": "https://changed.koaryu.test/billing?connect=return",
                },
            },
        }

        with patch("app.services.stripe_service.stripe_v2_request") as raw:
            with self.assertRaises(HTTPException) as raised:
                service._stripe_v2_post(
                    "/v2/core/account_links",
                    payload,
                    operation="connect_onboarding_link.create",
                    studio_id="studio_1",
                    account_id="acct_1",
                    idempotency_key=link_key,
                    bootstrap_context=context,
                )

        self.assertIn("initial-link context", raised.exception.detail)
        raw.assert_not_called()

    def test_live_mutations_fail_before_loading_stripe_when_switch_is_off(self):
        service = StripeService()
        service.settings = _settings(mode="live", live_enabled=False)
        service._stripe = Mock(side_effect=AssertionError("Stripe client must not load"))

        with self.assertRaises(HTTPException) as raised:
            service.create_customer(name="Live Studio", studio_id="studio_1", metadata={})

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        service._stripe.assert_not_called()

    def test_core_self_checkout_switch_allows_only_named_live_core_operations(self):
        policy = StripeMutationPolicy(_settings(
            mode="live",
            core_self_checkout_enabled=True,
        ))

        for operation in (
            "customer.create",
            "core_checkout_session.create",
            "core_checkout_session.expire",
            "core_subscription.cancel",
            "customer_portal_session.create",
        ):
            with self.subTest(operation=operation):
                permit = policy.issue_permit(operation, studio_id="studio_1")
                self.assertEqual(permit.mode, "live")
                self.assertEqual(permit.authorization_source, "core_self_checkout")
                self.assertEqual(permit.studio_id, "studio_1")

        for operation, account_id, expected_detail in (
            ("customer.update", None, LIVE_SCOPE_REQUIRED_DETAIL),
            ("connect_account.create", None, LIVE_MUTATIONS_DISABLED_DETAIL),
            ("connected_invoice.pay", "acct_1", LIVE_MUTATIONS_DISABLED_DETAIL),
        ):
            with self.subTest(operation=operation), self.assertRaises(HTTPException) as raised:
                policy.issue_permit(
                    operation,
                    studio_id="studio_1",
                    account_id=account_id,
                )
            self.assertEqual(raised.exception.detail, expected_detail)

    def test_core_self_checkout_switch_still_requires_explicit_studio_scope(self):
        policy = StripeMutationPolicy(_settings(
            mode="live",
            core_self_checkout_enabled=True,
        ))

        with self.assertRaises(HTTPException) as raised:
            policy.issue_permit("core_checkout_session.create")

        self.assertEqual(raised.exception.detail, LIVE_SCOPE_REQUIRED_DETAIL)

    def test_core_self_checkout_switch_cannot_authorize_live_mutations_outside_production(self):
        for environment in ("development", "test", "staging"):
            policy = StripeMutationPolicy(_settings(
                mode="live",
                core_self_checkout_enabled=True,
                environment=environment,
            ))
            for operation in (
                "customer.create",
                "core_checkout_session.create",
                "customer_portal_session.create",
            ):
                with self.subTest(environment=environment, operation=operation), self.assertRaises(HTTPException) as raised:
                    policy.issue_permit(operation, studio_id="studio_1")
                self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)

    def test_live_switch_is_not_sufficient_without_explicit_durable_scope(self):
        policy = StripeMutationPolicy(_settings(mode="live", live_enabled=True))

        with self.assertRaises(HTTPException) as raised:
            policy.issue_permit("customer.create")

        self.assertEqual(raised.exception.status_code, 503)
        self.assertEqual(raised.exception.detail, LIVE_SCOPE_REQUIRED_DETAIL)
        self.assertFalse(policy.live_payments_authorized())

    def test_live_scope_uses_durable_store_only_after_global_switch(self):
        store = _AuthorizedStore()
        permit = StripeMutationPolicy(
            _settings(mode="live", live_enabled=True),
            authorization_store=store,
        ).issue_permit("connected_invoice.pay", studio_id="studio_1", account_id="acct_1")

        self.assertEqual(permit.authorization_source, "durable_live_scope")
        self.assertEqual(permit.studio_id, "studio_1")
        self.assertEqual(store.calls, [{
            "operation": "connected_invoice.pay",
            "scope": "connect_payments",
            "studio_id": "studio_1",
            "account_id": "acct_1",
            "expected_livemode": True,
        }])

    def test_live_switch_off_does_not_read_durable_store(self):
        store = _AuthorizedStore()
        with self.assertRaises(HTTPException) as raised:
            StripeMutationPolicy(
                _settings(mode="live", live_enabled=False),
                authorization_store=store,
            ).issue_permit(
                "connected_invoice.pay",
                studio_id="studio_1",
                account_id="acct_1",
            )
        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        self.assertEqual(store.calls, [])

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
            "cancel_connected_subscription",
            "cancel_core_subscription",
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
            "create_connected_subscription_schedule",
            "create_core_checkout_session",
            "create_customer",
            "create_customer_portal_session",
            "create_setup_checkout_session",
            "delete_connected_subscription_item",
            "expire_core_checkout_session",
            "finalize_connected_invoice",
            "pay_connected_invoice",
            "release_connected_subscription_schedule",
            "send_connected_invoice",
            "set_connected_customer_default_payment_method",
            "update_connect_account_branding",
            "update_connected_customer",
            "update_connected_product",
            "update_connected_subscription",
            "update_connected_subscription_item",
            "update_connected_subscription_schedule",
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

    def test_only_first_connect_create_and_link_defer_to_the_validated_provider_sink(self):
        guarded = {
            name for name in dir(StripeService)
            if getattr(getattr(StripeService, name), "__stripe_sink_guarded__", False)
        }
        self.assertEqual(guarded, {"create_connect_account", "create_connect_onboarding_link"})

    def test_every_guarded_mutation_accepts_explicit_scope_context(self):
        # This catches a new Stripe mutation that remains policy-marked but can
        # only be invoked through ambient request state. Every provider sink
        # must accept a studio argument and connected operations must also
        # accept the exact account at the call boundary.
        for name in (
            name for name in dir(StripeService)
            if getattr(getattr(StripeService, name), "__stripe_mutation_operation__", None)
        ):
            parameters = inspect.signature(getattr(StripeService, name)).parameters
            with self.subTest(name=name):
                self.assertTrue(
                    "studio_id" in parameters,
                )
                operation = getattr(getattr(StripeService, name), "__stripe_mutation_operation__")
                if operation.startswith("connected_"):
                    self.assertIn("account_id", parameters)

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
            ("stripe_service.py", "create_connected_subscription_schedule", "stripe.SubscriptionSchedule.create"),
            ("stripe_service.py", "create_connected_subscription_item", "stripe.SubscriptionItem.create"),
            ("stripe_service.py", "update_connected_subscription_item", "stripe.SubscriptionItem.modify"),
            ("stripe_service.py", "delete_connected_subscription_item", "stripe.SubscriptionItem.delete"),
            ("stripe_service.py", "update_connected_subscription", "stripe.Subscription.modify"),
            ("stripe_service.py", "update_connected_subscription_schedule", "stripe.SubscriptionSchedule.modify"),
            ("stripe_service.py", "release_connected_subscription_schedule", "stripe.SubscriptionSchedule.release"),
            ("stripe_service.py", "cancel_connected_subscription", "stripe.Subscription.cancel"),
            ("stripe_service.py", "create_connected_invoice_item", "stripe.InvoiceItem.create"),
            ("stripe_service.py", "create_connected_invoice", "stripe.Invoice.create"),
            ("stripe_service.py", "finalize_connected_invoice", "stripe.Invoice.finalize_invoice"),
            ("stripe_service.py", "send_connected_invoice", "stripe.Invoice.send_invoice"),
            ("stripe_service.py", "pay_connected_invoice", "stripe.Invoice.pay"),
            ("stripe_service.py", "void_connected_invoice", "stripe.Invoice.void_invoice"),
            ("stripe_service.py", "create_connected_refund", "stripe.Refund.create"),
            ("stripe_service.py", "create_core_checkout_session", "stripe.checkout.Session.create"),
            ("stripe_service.py", "expire_core_checkout_session", "stripe.checkout.Session.expire"),
            ("stripe_service.py", "cancel_core_subscription", "stripe.Subscription.cancel"),
            ("stripe_service.py", "create_customer_portal_session", "stripe.billing_portal.Session.create"),
            ("billing_enrollment_transitions.py", "_mutate_provider", "stripe.update_connected_subscription"),
            ("billing_enrollment_transitions.py", "_mutate_provider", "stripe.cancel_connected_subscription"),
            ("billing_enrollment_transitions.py", "_mutate_provider", "stripe.delete_connected_subscription_item"),
            ("billing_enrollment_transitions.py", "_mutate_provider", "stripe.update_connected_subscription_item"),
            ("billing_enrollment_transitions.py", "_mutate_provider", "stripe.release_connected_subscription_schedule"),
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
            service.create_connect_dashboard_url(account_id="acct_legacy", studio_id="studio_1")

        self.assertEqual(raised.exception.detail, LIVE_MUTATIONS_DISABLED_DETAIL)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
