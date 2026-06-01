from __future__ import annotations

from typing import Any, Callable, Optional


class FakeResult:
    def __init__(self, data: Any, count: Optional[int] = None):
        self.data = data
        self.count = count


class TableBackedSupabase:
    def __init__(self, tables: Optional[dict[str, list[dict[str, Any]]]] = None):
        self.tables = tables or {}
        self.insert_defaults: dict[str, Callable[[str], dict[str, Any]] | dict[str, Any]] = {}
        self.table_failures: dict[str, Exception] = {}
        self.required_eq_filters: dict[str, set[str]] = {}
        self.select_assertions: dict[str, Callable[[str], None]] = {}
        self.unique_constraints: dict[str, list[tuple[str, ...]]] = {}
        self.unique_conflict_error_factory: Optional[Callable[[str, tuple[str, ...]], Exception]] = None
        self.before_insert = None
        self.before_update = None
        self.on_update_query = None
        self.on_delete_query = None
        self.query_log: list[dict[str, Any]] = []
        self.log = self.query_log

    def table(self, name: str):
        return FakeTableQuery(self, name)


class FakeRpcCall:
    def __init__(self, handler: Callable[[], Any]):
        self.handler = handler

    def execute(self):
        return FakeResult(self.handler())


class RpcBackedSupabase(TableBackedSupabase):
    def __init__(self, tables: Optional[dict[str, list[dict[str, Any]]]] = None):
        super().__init__(tables)
        self.rpc_calls: list[tuple[str, dict[str, Any]]] = []

    def rpc(self, name: str, params: dict[str, Any]):
        self.rpc_calls.append((name, params))
        handler = getattr(self, f"_rpc_{name}", None)
        if not callable(handler):
            raise AssertionError(f"Unexpected RPC {name}")
        return FakeRpcCall(lambda: handler(params))


class FakeTableQuery:
    def __init__(self, supabase: TableBackedSupabase, name: str):
        self.supabase = supabase
        self.name = name
        self.filters: list[tuple[str, str, Any]] = []
        self.or_filters: list[str] = []
        self.orders: list[tuple[str, bool]] = []
        self.columns = ""
        self.count_mode = None
        self.insert_payload = None
        self.upsert_payload = None
        self.upsert_conflict_key = "id"
        self.update_payload = None
        self.delete_requested = False
        self.limit_value: Optional[int] = None
        self.range_bounds: Optional[tuple[int, int]] = None
        self.single_row = False
        self.negate_next_is = False

    def select(self, *args, **_kwargs):
        self.columns = args[0] if args else ""
        self.count_mode = _kwargs.get("count")
        assertion = self.supabase.select_assertions.get(self.name)
        if assertion:
            assertion(self.columns)
        return self

    def insert(self, payload):
        self.insert_payload = payload
        return self

    def upsert(self, payload, *, on_conflict: str = "id"):
        self.upsert_payload = payload
        self.upsert_conflict_key = on_conflict
        return self

    def update(self, payload):
        self.update_payload = payload
        return self

    def delete(self):
        self.delete_requested = True
        return self

    def eq(self, key: str, value: Any):
        self.filters.append(("eq", key, value))
        return self

    def neq(self, key: str, value: Any):
        self.filters.append(("neq", key, value))
        return self

    def is_(self, key: str, value: Any):
        self.filters.append(("not_is" if self.negate_next_is else "is", key, value))
        self.negate_next_is = False
        return self

    def in_(self, key: str, values):
        self.filters.append(("in", key, set(values)))
        return self

    def or_(self, value: str):
        self.or_filters.append(value)
        return self

    def lte(self, key: str, value: Any):
        self.filters.append(("lte", key, value))
        return self

    def gte(self, key: str, value: Any):
        self.filters.append(("gte", key, value))
        return self

    def lt(self, key: str, value: Any):
        self.filters.append(("lt", key, value))
        return self

    def order(self, key: str, desc: bool = False):
        self.orders.append((key, desc))
        return self

    def limit(self, value: int):
        self.limit_value = value
        return self

    def range(self, start: int, end: int):
        self.range_bounds = (start, end)
        return self

    def single(self):
        self.single_row = True
        return self

    def maybe_single(self):
        self.single_row = True
        return self

    @property
    def not_(self):
        self.negate_next_is = True
        return self

    def execute(self):
        self.supabase.query_log.append({
            "table": self.name,
            "columns": self.columns,
            "filters": tuple(self.filters),
            "or_filters": tuple(self.or_filters),
            "orders": tuple(self.orders),
            "range": self.range_bounds,
            "limit": self.limit_value,
            "insert": self.insert_payload,
            "upsert": self.upsert_payload,
            "update": self.update_payload,
            "delete": self.delete_requested,
        })
        failure = self.supabase.table_failures.get(self.name)
        if failure:
            raise failure
        self._assert_required_filters()

        rows = self.supabase.tables.setdefault(self.name, [])
        if self.insert_payload is not None:
            inserted = self._insert_rows(rows)
            return FakeResult(inserted)
        if self.upsert_payload is not None:
            upserted = self._upsert_rows(rows)
            return FakeResult(upserted)

        matched = self._matched_rows(rows)
        total_count = len(matched)

        if self.delete_requested:
            on_delete = getattr(self.supabase, "on_delete_query", None)
            if on_delete:
                handled = on_delete(self, rows)
                if handled is not None:
                    return FakeResult(handled)
            self.supabase.tables[self.name] = [row for row in rows if row not in matched]
            return FakeResult([dict(row) for row in matched])

        if self.update_payload is not None:
            on_update = getattr(self.supabase, "on_update_query", None)
            if on_update:
                handled = on_update(self, rows)
                if handled is not None:
                    return FakeResult(handled)
            before_update = getattr(self.supabase, "before_update", None)
            if before_update:
                self.supabase.before_update = None
                before_update(rows)
                matched = self._matched_rows(rows)
            for row in matched:
                row.update(self.update_payload)
            return FakeResult([dict(row) for row in matched])

        data = [dict(row) for row in self._bounded_rows(matched)]
        if self.single_row:
            return FakeResult(data[0] if data else None, count=total_count)
        return FakeResult(data, count=total_count if self.count_mode == "exact" else None)

    def _assert_required_filters(self) -> None:
        required = self.supabase.required_eq_filters.get(self.name)
        if not required:
            return
        present = {key for op, key, _value in self.filters if op == "eq"}
        missing = required - present
        if missing:
            raise AssertionError(f"{self.name} query omitted required filters: {sorted(missing)}")

    def _insert_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        payloads = self.insert_payload if isinstance(self.insert_payload, list) else [self.insert_payload]
        before_insert = getattr(self.supabase, "before_insert", None)
        if before_insert:
            before_insert(self.name, payloads, rows)
        self._raise_on_unique_conflict(rows, payloads)
        inserted = []
        for payload in payloads:
            defaults_factory = self.supabase.insert_defaults.get(self.name)
            defaults = defaults_factory(self.name) if callable(defaults_factory) else (defaults_factory or {})
            row = {
                "id": f"{self.name}_{len(rows) + 1}",
                **defaults,
                **payload,
            }
            rows.append(row)
            inserted.append(dict(row))
        return inserted

    def _raise_on_unique_conflict(
        self,
        rows: list[dict[str, Any]],
        payloads: list[dict[str, Any]],
    ) -> None:
        for columns in self.supabase.unique_constraints.get(self.name, []):
            existing_keys = {
                tuple(row.get(column) for column in columns)
                for row in rows
                if all(row.get(column) is not None for column in columns)
            }
            pending_keys = set()
            for payload in payloads:
                key = tuple(payload.get(column) for column in columns)
                if any(value is None for value in key):
                    continue
                if key in existing_keys or key in pending_keys:
                    factory = self.supabase.unique_conflict_error_factory
                    if factory is not None:
                        raise factory(self.name, columns)
                    raise AssertionError(f"Unique constraint conflict on {self.name}({', '.join(columns)})")
                pending_keys.add(key)

    def _upsert_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        payloads = self.upsert_payload if isinstance(self.upsert_payload, list) else [self.upsert_payload]
        upserted = []
        conflict_keys = [key.strip() for key in self.upsert_conflict_key.split(",") if key.strip()]
        for payload in payloads:
            match = next(
                (
                    row for row in rows
                    if conflict_keys and all(row.get(key) == payload.get(key) for key in conflict_keys)
                ),
                None,
            )
            if match is None:
                self.insert_payload = payload
                inserted = self._insert_rows(rows)[0]
                self.insert_payload = None
                upserted.append(inserted)
            else:
                match.update(payload)
                upserted.append(dict(match))
        return upserted

    def _matched_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        matched = [
            row for row in rows
            if all(self._matches(row, op, key, value) for op, key, value in self.filters)
            and all(self._matches_any_or_filter(row, value) for value in self.or_filters)
        ]
        for key, desc in reversed(self.orders):
            matched.sort(key=lambda row, key=key: self._value_for_key(row, key) or "", reverse=desc)
        return matched

    def _bounded_rows(self, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        bounded = rows
        if self.range_bounds is not None:
            start, end = self.range_bounds
            bounded = bounded[start:end + 1]
        if self.limit_value is not None:
            bounded = bounded[: self.limit_value]
        return bounded

    def _matches(self, row: dict[str, Any], op: str, key: str, value: Any) -> bool:
        row_value = self._value_for_key(row, key)
        if op == "eq":
            return row_value == value
        if op == "neq":
            return row_value != value
        if op == "is":
            return row_value is None if value == "null" else row_value is value
        if op == "not_is":
            return row_value is not None if value == "null" else row_value is not value
        if op == "in":
            return row_value in value
        if op == "lte":
            return self._compare(row_value, value, lambda left, right: left <= right)
        if op == "gte":
            return self._compare(row_value, value, lambda left, right: left >= right)
        if op == "lt":
            return self._compare(row_value, value, lambda left, right: left < right)
        return False

    def _compare(self, row_value: Any, value: Any, predicate: Callable[[Any, Any], bool]) -> bool:
        if row_value is None:
            return False
        try:
            return predicate(row_value, value)
        except TypeError:
            return predicate(str(row_value), str(value))

    def _matches_any_or_filter(self, row: dict[str, Any], value: str) -> bool:
        return any(
            self._matches_or_condition(row, condition.strip())
            for condition in value.split(",")
            if condition.strip()
        )

    def _matches_or_condition(self, row: dict[str, Any], condition: str) -> bool:
        if condition.endswith(".is.null"):
            return self._value_for_key(row, condition[: -len(".is.null")]) is None
        if ".lte." in condition:
            key, raw_value = condition.split(".lte.", 1)
            row_value = self._value_for_key(row, key)
            if row_value is None:
                return False
            try:
                return int(row_value) <= int(raw_value)
            except (TypeError, ValueError):
                return False
        if ".ilike." in condition:
            key, raw_value = condition.split(".ilike.", 1)
            term = raw_value.strip("%").lower()
            return term in str(self._value_for_key(row, key) or "").lower()
        if ".eq." in condition:
            key, raw_value = condition.split(".eq.", 1)
            return str(self._value_for_key(row, key)) == raw_value
        raise NotImplementedError(f"Unsupported fake Supabase or_ condition: {condition}")

    def _value_for_key(self, row: dict[str, Any], key: str) -> Any:
        if "->" not in key:
            return row.get(key)
        value: Any = row
        parts = key.split("->")
        for index, part in enumerate(parts):
            text_value = part.startswith(">")
            if text_value:
                part = part[1:]
            if not isinstance(value, dict):
                return None
            value = value.get(part)
            if text_value or index == len(parts) - 1:
                return str(value) if value is not None and text_value else value
        return value
