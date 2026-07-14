from __future__ import annotations

from typing import Any

from app.services.report_export_catalog_billing_tables import build_billing_table_report_catalog
from app.services.report_export_catalog_core_tables import build_core_table_report_catalog
from app.services.report_export_catalog_intelligence import build_intelligence_report_catalog
from app.services.report_export_catalog_operations import build_operations_report_catalog
from app.services.report_export_catalog_types import CsvReport


def build_report_catalog(report_service_cls: Any) -> dict[str, CsvReport]:
    complete_catalog = {
        **build_intelligence_report_catalog(report_service_cls),
        **build_core_table_report_catalog(report_service_cls),
        **build_billing_table_report_catalog(report_service_cls),
        **build_operations_report_catalog(report_service_cls),
    }
    return {
        report_id: report
        for report_id, report in complete_catalog.items()
        if report.availability == "available"
    }
