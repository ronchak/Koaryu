from __future__ import annotations

from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import quote

import httpx
from fastapi import HTTPException, status


STRIPE_ACCOUNTS_V2_VERSION = "2026-05-27.preview"


class _StripeV2RequestError(Exception):
    def __init__(self, *, code: Optional[str], message: str, request_id: Optional[str] = None):
        super().__init__(message)
        self.code = code
        self.request_id = request_id


StripeLoader = Callable[[], Any]
RequestOptionsBuilder = Callable[..., dict[str, str]]
StripeV2Request = Callable[..., dict[str, Any]]
MutationAuthorizer = Callable[[str], Any]


def stripe_v2_request(
    settings: Any,
    method: str,
    path: str,
    payload: dict[str, Any],
    *,
    idempotency_key: Optional[str] = None,
) -> dict[str, Any]:
    if not settings.STRIPE_SECRET_KEY:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Stripe is not configured for this environment.",
        )
    headers = {
        "Authorization": f"Bearer {settings.STRIPE_SECRET_KEY}",
        "Stripe-Version": STRIPE_ACCOUNTS_V2_VERSION,
        "Content-Type": "application/json",
    }
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key

    try:
        response = httpx.request(
            method,
            f"https://api.stripe.com{path}",
            headers=headers,
            json=payload,
            timeout=30,
        )
    except httpx.HTTPError as exc:
        raise _StripeV2RequestError(code=None, message="Stripe Accounts v2 request failed.") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise _StripeV2RequestError(
            code=None,
            message="Stripe Accounts v2 returned an invalid response.",
            request_id=response.headers.get("Request-Id"),
        ) from exc

    if response.status_code >= 400:
        error = data.get("error") if isinstance(data, dict) else None
        code = error.get("code") if isinstance(error, dict) else None
        message = error.get("message") if isinstance(error, dict) else "Stripe Accounts v2 request failed."
        raise _StripeV2RequestError(
            code=code,
            message=message,
            request_id=response.headers.get("Request-Id"),
        )
    return data


class StripeConnectGateway:
    def __init__(
        self,
        *,
        settings: Any,
        stripe_loader: StripeLoader,
        request_options: RequestOptionsBuilder,
        stripe_v2_post: StripeV2Request,
        stripe_v2_patch: StripeV2Request,
        authorize_mutation: MutationAuthorizer,
    ):
        self.settings = settings
        self._stripe = stripe_loader
        self._request_options = request_options
        self._stripe_v2_post = stripe_v2_post
        self._stripe_v2_patch = stripe_v2_patch
        self._authorize_mutation = authorize_mutation

    def create_account(
        self,
        *,
        studio_id: str,
        business_name: str,
        contact_email: Optional[str] = None,
        business_entity_type: str = "company",
        account_generation: int = 1,
    ):
        self._authorize_mutation("connect_account.create")
        try:
            return self._create_account_v2(
                studio_id=studio_id,
                business_name=business_name,
                contact_email=contact_email,
                business_entity_type=business_entity_type,
                account_generation=account_generation,
            )
        except _StripeV2RequestError as exc:
            if exc.code != "accounts_v2_access_blocked":
                self._raise_connect_account_error(exc, "create a connected account")

        return self._create_account_v1(
            studio_id=studio_id,
            business_name=business_name,
            business_entity_type=business_entity_type,
            account_generation=account_generation,
        )

    def upload_branding_file(self, *, file_path: str, purpose: str) -> str:
        self._authorize_mutation("connect_branding_file.create")
        stripe = self._stripe()
        path = Path(file_path)
        with path.open("rb") as handle:
            uploaded = stripe.File.create(file=handle, purpose=purpose)
        return uploaded["id"] if isinstance(uploaded, dict) else uploaded.id

    def update_branding(
        self,
        *,
        account_id: str,
        primary_color: str,
        secondary_color: str,
        icon_file_id: Optional[str] = None,
        logo_file_id: Optional[str] = None,
    ) -> Any:
        self._authorize_mutation("connect_account.branding.update")
        branding = {
            "primary_color": primary_color,
            "secondary_color": secondary_color,
        }
        if icon_file_id:
            branding["icon"] = icon_file_id
        if logo_file_id:
            branding["logo"] = logo_file_id

        try:
            return self._stripe_v2_patch(
                f"/v2/core/accounts/{quote(account_id)}",
                {
                    "configuration": {"merchant": {"branding": branding}},
                    "include": ["configuration.merchant"],
                },
                idempotency_key=f"koaryu-connect-branding-{account_id}",
            )
        except _StripeV2RequestError as exc:
            if exc.code != "accounts_v2_access_blocked":
                self._raise_connect_account_error(exc, "update connected account branding")

        stripe = self._stripe()
        try:
            return stripe.Account.modify(
                account_id,
                settings={"branding": branding},
                **self._request_options(idempotency_key=f"koaryu-connect-branding-{account_id}"),
            )
        except Exception as exc:
            if self._is_stripe_exception(exc):
                self._raise_connect_account_error(exc, "update connected account branding")
            raise

    def create_onboarding_link(
        self,
        *,
        account_id: str,
        refresh_url: str,
        return_url: str,
    ):
        self._authorize_mutation("connect_onboarding_link.create")
        try:
            return self._stripe_v2_post(
                "/v2/core/account_links",
                {
                    "account": account_id,
                    "use_case": {
                        "type": "account_onboarding",
                        "account_onboarding": {
                            "configurations": ["merchant"],
                            "collection_options": {"fields": "eventually_due"},
                            "refresh_url": refresh_url,
                            "return_url": return_url,
                        },
                    },
                },
            )
        except _StripeV2RequestError as exc:
            if exc.code != "accounts_v2_access_blocked":
                self._raise_connect_account_error(exc, "create an onboarding link")

        return self._create_legacy_onboarding_link(
            account_id=account_id,
            refresh_url=refresh_url,
            return_url=return_url,
        )

    def _create_legacy_onboarding_link(
        self,
        *,
        account_id: str,
        refresh_url: str,
        return_url: str,
    ):
        stripe = self._stripe()
        try:
            return stripe.AccountLink.create(
                account=account_id,
                refresh_url=refresh_url,
                return_url=return_url,
                type="account_onboarding",
            )
        except Exception as exc:
            if self._is_stripe_exception(exc):
                self._raise_connect_account_error(exc, "create an onboarding link")
            raise

    def create_dashboard_link(self, *, account_id: str):
        return {"url": self.create_dashboard_url(account_id=account_id)}

    def retrieve_account(self, *, account_id: Optional[str] = None):
        stripe = self._stripe()
        try:
            if account_id:
                return stripe.Account.retrieve(account_id)
            return stripe.Account.retrieve()
        except Exception as exc:
            if self._is_stripe_exception(exc):
                self._raise_connect_account_error(exc, "retrieve a connected account")
            raise

    def create_dashboard_url(self, *, account_id: str) -> str:
        stripe = self._stripe()
        try:
            connected_account = stripe.Account.retrieve(account_id)
            controller = self._object_get(connected_account, "controller") or {}
            dashboard = self._object_get(controller, "stripe_dashboard") or {}
            dashboard_type = self._object_get(dashboard, "type")
            account_type = self._object_get(connected_account, "type")

            if dashboard_type == "full" or account_type == "standard":
                return self._account_holder_dashboard_url()

            return self._create_legacy_dashboard_login_url(account_id=account_id)
        except Exception as exc:
            if self._is_stripe_exception(exc):
                self._raise_connect_account_error(exc, "open the connected account dashboard")
            raise

    def _account_holder_dashboard_url(self) -> str:
        mode_segment = "/test" if self.settings.STRIPE_SECRET_KEY.startswith("sk_test_") else ""
        return f"https://dashboard.stripe.com{mode_segment}"

    def _create_legacy_dashboard_login_url(self, *, account_id: str) -> str:
        self._authorize_mutation("connect_dashboard_login_link.create")
        stripe = self._stripe()
        try:
            link = stripe.Account.create_login_link(account_id)
            return link["url"] if isinstance(link, dict) else link.url
        except Exception as exc:
            if self._is_stripe_exception(exc):
                self._raise_connect_account_error(exc, "create a dashboard login link")
            raise

    def _create_account_v2(
        self,
        *,
        studio_id: str,
        business_name: str,
        contact_email: Optional[str] = None,
        business_entity_type: str = "company",
        account_generation: int = 1,
    ) -> dict[str, Any]:
        identity: dict[str, Any] = {
            "country": "us",
            "entity_type": business_entity_type,
        }
        if business_entity_type == "company":
            identity["business_details"] = {"registered_name": business_name}

        payload: dict[str, Any] = {
            "display_name": business_name,
            "dashboard": "full",
            "identity": identity,
            "configuration": {
                "merchant": {
                    "capabilities": {
                        "card_payments": {"requested": True},
                    },
                },
            },
            "defaults": {
                "currency": "usd",
                "responsibilities": {
                    "fees_collector": "stripe",
                    "losses_collector": "stripe",
                },
                "profile": {
                    "doing_business_as": business_name,
                    "product_description": "Martial arts tuition and membership payments",
                },
                "locales": ["en-US"],
            },
            "metadata": {
                "studio_id": studio_id,
                "product": "koaryu_payments",
                "business_entity_type": business_entity_type,
            },
            "include": ["configuration.merchant", "identity", "defaults", "requirements"],
        }
        if contact_email:
            payload["contact_email"] = contact_email
        return self._stripe_v2_post(
            "/v2/core/accounts",
            payload,
            idempotency_key=f"koaryu-connect-account-{studio_id}-g{account_generation}",
        )

    def _create_account_v1(
        self,
        *,
        studio_id: str,
        business_name: str,
        business_entity_type: str = "company",
        account_generation: int = 1,
    ):
        stripe = self._stripe()
        try:
            return stripe.Account.create(
                type="express",
                metadata={"studio_id": studio_id, "business_entity_type": business_entity_type},
                business_type=business_entity_type,
                business_profile={"name": business_name},
                capabilities={
                    "card_payments": {"requested": True},
                    "transfers": {"requested": True},
                },
                **self._request_options(idempotency_key=f"koaryu-connect-account-{studio_id}-g{account_generation}"),
            )
        except Exception as exc:
            if self._is_stripe_exception(exc):
                self._raise_connect_account_error(exc, "create a connected account")
            raise

    @staticmethod
    def _object_get(obj: Any, key: str) -> Any:
        if isinstance(obj, dict):
            return obj.get(key)
        return getattr(obj, key, None)

    @staticmethod
    def _is_stripe_exception(exc: Exception) -> bool:
        return exc.__class__.__module__.startswith("stripe")

    def _raise_connect_account_error(self, exc: Exception, action: str) -> None:
        message = str(exc)
        if "Only Stripe Connect platforms can work with other accounts" in message:
            detail = (
                "This Stripe account cannot access the stored connected account. "
                "Reconnect Stripe Payments in live mode so Koaryu can create a connected account "
                "under the active Stripe platform."
            )
        elif "No such account" in message or "No such connected account" in message:
            detail = (
                "The stored Stripe connected account is no longer accessible. "
                "Reconnect Stripe Payments before opening Stripe-hosted billing tools."
            )
        elif "does not have access to account" in message or "Application access may have been revoked" in message:
            detail = (
                "This Stripe account cannot access the stored connected account. "
                "Reconnect Stripe Payments so Koaryu can create a connected account "
                "under the active Stripe platform."
            )
        elif "signed up for Connect" in message or "account_create_activation_required" in message:
            detail = (
                "Stripe Connect is not activated for this live Stripe platform yet. "
                "Finish Stripe Connect setup in the Stripe Dashboard before starting studio payment onboarding."
            )
        elif "account_creation_liability_unacknowledged" in message or "unacknowledged" in message:
            detail = (
                "Stripe needs the Connect responsibility acknowledgements completed before Koaryu can create "
                "live connected accounts."
            )
        else:
            detail = (
                f"Stripe Connect could not {action}. "
                "Check the connected account status in Stripe, then retry."
            )
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=detail) from exc
