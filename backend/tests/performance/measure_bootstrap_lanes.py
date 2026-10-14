"""Warm fake-provider medians; no network. Run with backend/venv/bin/python.

Costs are synthetic. Client setup simulates the audit's 14.3 ms measurement.
"""

import asyncio
import json
import subprocess
import sys
import time
from contextlib import ExitStack
from datetime import date
from pathlib import Path
from statistics import median
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from app.core.deps import run_supabase_operation
from app.core.provider_runtime import SupabaseProviderRuntime
from app.main import INTERACTIVE_PROVIDER_CONFIG
from app.services.dashboard_bootstrap_service import DashboardBootstrapService
from tests.test_dashboard_bootstrap_runtime import BootstrapFixture
from tests.test_dashboard_bootstrap_service import METHOD_LABELS

COSTS_MS = {"context": 2, "studio": 8, "programs": 12, "students": 20, "membership": 3}
CLIENT_SETUP_MS = 14.3


def measure():
    namespace = {"__name__": "bootstrap_before_u5"}
    exec(
        subprocess.check_output(
            ["git", "show", "12ecccab:backend/app/services/dashboard_bootstrap_service.py"],
            text=True,
        ),
        namespace,
    )
    results = {}
    for variant, service_class in (
        ("before", namespace["DashboardBootstrapService"]),
        ("after", DashboardBootstrapService),
    ):
        fixture = BootstrapFixture(config=INTERACTIVE_PROVIDER_CONFIG)
        fixture.runtime.shutdown()
        constructions = []

        class Client(fixture.factory):
            def __init__(self):
                super().__init__()
                self.options = SimpleNamespace(postgrest_client_timeout=10)
                self.auth = SimpleNamespace(close=lambda: None)
                constructions.append(id(self))

            def table(self, name):
                if name == "student_program_memberships":
                    time.sleep(COSTS_MS["membership"] / 1000)
                return super().table(name)

        fixture.runtime = SupabaseProviderRuntime(
            INTERACTIVE_PROVIDER_CONFIG,
            INTERACTIVE_PROVIDER_CONFIG,
            client_factory=Client,
            client_closer=lambda client: client.touch("closed"),
        )

        def isolated_factory(**_options):
            time.sleep(CLIENT_SETUP_MS / 1000)
            return Client()

        def auth(service, *args):
            time.sleep(COSTS_MS["context"] / 1000)
            return fixture.auth(service, *args)

        def fetch(service, method_name, studio_id):
            time.sleep(COSTS_MS.get(METHOD_LABELS[method_name], 0) / 1000)
            return fixture.fetch(service, method_name, studio_id)

        async def scenario():
            try:
                await fixture.warm()
                measured = {}
                for view in ("home", "students"):
                    samples = []
                    for _ in range(10):
                        before = len(constructions)
                        occupancy = fixture.runtime.interactive_snapshot().operation_seconds
                        started = time.perf_counter()
                        if variant == "before":

                            async def operation(client):
                                return await service_class(client).get_dashboard_bootstrap(
                                    "user-1", provider_owned=True, view=view
                                )

                            _payload, timings = await run_supabase_operation(
                                fixture.runtime, operation
                            )
                        else:
                            _payload, timings = await service_class(
                                fixture.runtime
                            ).get_dashboard_bootstrap("user-1", view=view)
                        samples.append(
                            {
                                **timings,
                                "wall": (time.perf_counter() - started) * 1000,
                                "worker_occupancy": (
                                    fixture.runtime.interactive_snapshot().operation_seconds
                                    - occupancy
                                )
                                * 1000,
                                "client_constructions": len(constructions) - before,
                            }
                        )
                    measured[view] = {
                        key: round(median(sample[key] for sample in samples), 3)
                        for key in samples[0]
                    }
                return measured
            finally:
                await fixture.close()

        with ExitStack() as stack:
            stack.enter_context(
                patch(
                    "app.services.dashboard_bootstrap_service.AuthService._get_user_profile_sync",
                    new=auth,
                )
            )
            stack.enter_context(
                patch(
                    "app.services.dashboard_bootstrap_service.ensure_platform_subscription_access"
                )
            )
            stack.enter_context(
                patch(
                    "app.services.dashboard_bootstrap_service.studio_today",
                    return_value=(date(2026, 9, 20), "UTC"),
                )
            )
            stack.enter_context(
                patch.dict(
                    namespace,
                    create_supabase_client=isolated_factory,
                    close_supabase_client=lambda client: client.touch("closed"),
                    ensure_platform_subscription_access=lambda *_args: None,
                    studio_today=lambda *_args: (date(2026, 9, 20), "UTC"),
                )
            )
            for method in METHOD_LABELS:
                stack.enter_context(
                    patch.object(
                        service_class,
                        method,
                        new=lambda service, studio_id, method=method: fetch(
                            service, method, studio_id
                        ),
                    )
                )
            results[variant] = asyncio.run(scenario())
    return {
        "samples_per_view": 10,
        "synthetic_costs_ms": COSTS_MS,
        "simulated_client_setup_ms": CLIENT_SETUP_MS,
        "durations_ms": results,
    }


if __name__ == "__main__":
    print(json.dumps(measure(), indent=2))
