from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Optional


MISSING = object()


class PlatformSubscriptionProjector:
    def project_subscription(self, subscription: Any) -> dict[str, Any]:
        update: dict[str, Any] = {"comped": False}

        if self.object_has(subscription, "customer"):
            update["stripe_customer_id"] = self.stripe_id(self.object_get(subscription, "customer"))
        if self.object_has(subscription, "id"):
            update["stripe_subscription_id"] = self.stripe_id(self.object_get(subscription, "id"))
        if self.object_has(subscription, "status"):
            update["status"] = self.object_get(subscription, "status") or "incomplete"
        if self.object_has(subscription, "trial_start"):
            update["trial_start"] = self.timestamp(self.object_get(subscription, "trial_start"))
        if self.object_has(subscription, "trial_end"):
            update["trial_end"] = self.timestamp(self.object_get(subscription, "trial_end"))
        if self.object_has(subscription, "cancel_at_period_end"):
            update["cancel_at_period_end"] = bool(self.object_get(subscription, "cancel_at_period_end"))

        current_period_start = self.subscription_period(subscription, "current_period_start", min)
        if current_period_start is not MISSING:
            update["current_period_start"] = current_period_start

        current_period_end = self.subscription_period(subscription, "current_period_end", max)
        if current_period_end is not MISSING:
            update["current_period_end"] = current_period_end

        return update

    def select_core_subscription(
        self,
        subscriptions: Any,
        studio_id: str,
        live_statuses: set[str],
    ) -> Optional[Any]:
        candidates = self.object_get(subscriptions, "data") or subscriptions
        if not isinstance(candidates, list):
            return None

        fallback: Optional[Any] = None
        for subscription in candidates:
            metadata = self.object_get(subscription, "metadata") or {}
            if self.object_get(metadata, "studio_id") != studio_id:
                continue
            status_value = self.object_get(subscription, "status") or ""
            if status_value in live_statuses:
                return subscription
            fallback = fallback or subscription
        return fallback

    def subscription_period(self, subscription: Any, key: str, pick: Any) -> Any:
        if self.object_has(subscription, key):
            return self.timestamp(self.object_get(subscription, key))

        item_values = [
            value
            for item in self.subscription_items(subscription)
            if (value := self.object_get(item, key)) is not None
        ]
        if not item_values:
            return MISSING
        return self.timestamp(pick(item_values, key=self.timestamp_sort_key))

    def subscription_items(self, subscription: Any) -> list[Any]:
        items = self.object_get(subscription, "items") or {}
        if isinstance(items, list):
            return items
        data = self.object_get(items, "data") or []
        return data if isinstance(data, list) else []

    @staticmethod
    def timestamp(value: Any) -> Optional[str]:
        if not value:
            return None
        if isinstance(value, (int, float)):
            return datetime.fromtimestamp(value, tz=timezone.utc).isoformat()
        return str(value)

    @classmethod
    def timestamp_epoch(cls, value: Any) -> Optional[float]:
        if not value:
            return None
        if isinstance(value, datetime):
            timestamp = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
            return timestamp.timestamp()
        if isinstance(value, (int, float)):
            return float(value)
        if isinstance(value, str):
            try:
                timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
                if timestamp.tzinfo is None:
                    timestamp = timestamp.replace(tzinfo=timezone.utc)
                return timestamp.timestamp()
            except ValueError:
                return None
        return None

    @classmethod
    def timestamp_sort_key(cls, value: Any) -> tuple:
        epoch = cls.timestamp_epoch(value)
        if epoch is not None:
            return (0, epoch)
        return (1, str(value))

    @classmethod
    def stripe_id(cls, value: Any) -> Optional[str]:
        if value is None:
            return None
        if isinstance(value, str):
            return value
        stripe_id = cls.object_get(value, "id")
        return str(stripe_id) if stripe_id else None

    @staticmethod
    def object_get(value: Any, key: str, default: Any = None) -> Any:
        if value is None:
            return default
        if isinstance(value, dict):
            return value.get(key, default)
        return getattr(value, key, default)

    @staticmethod
    def object_has(value: Any, key: str) -> bool:
        if value is None:
            return False
        if isinstance(value, dict):
            return key in value
        return hasattr(value, key)
