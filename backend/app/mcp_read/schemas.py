"""Small composable query contract, independent of the MCP transport."""

from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

Name = Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$", max_length=96)]
Scalar = StrictStr | StrictInt | StrictFloat | StrictBool | None


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Filter(Contract):
    field: Name
    op: Literal["eq", "ne", "in", "gt", "gte", "lt", "lte", "contains", "is_null"]
    value: Scalar | Annotated[list[Scalar], Field(max_length=100)] = None

    @model_validator(mode="after")
    def bounded_value(self):
        values = self.value if isinstance(self.value, list) else [self.value]
        if any(isinstance(v, str) and len(v) > 500 for v in values):
            raise ValueError("Filter values must be at most 500 characters.")
        if self.op == "in" and (not isinstance(self.value, list) or not self.value):
            raise ValueError("in requires a nonempty list.")
        if self.op != "in" and isinstance(self.value, list):
            raise ValueError("This operator requires a scalar value.")
        if self.op == "is_null" and not isinstance(self.value, bool):
            raise ValueError("is_null requires true or false.")
        return self


class Group(Contract):
    field: Name
    interval: Literal["day", "week", "month", "year"] | None = None


class Aggregate(Contract):
    op: Literal["count", "count_distinct", "sum", "avg", "min", "max"]
    field: Name | None = None
    alias: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=40)]

    @model_validator(mode="after")
    def needs_field(self):
        if self.op != "count" and self.field is None:
            raise ValueError("This aggregate needs a field.")
        return self


class Sort(Contract):
    field: Name
    direction: Literal["asc", "desc"] = "asc"


class Query(Contract):
    dataset: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]*$", max_length=60)]
    select: Annotated[list[Name], Field(max_length=40)] | None = None
    where: Annotated[list[Filter], Field(max_length=20)] = Field(default_factory=list)
    group_by: Annotated[list[Group], Field(max_length=3)] = Field(default_factory=list)
    aggregates: Annotated[list[Aggregate], Field(max_length=10)] = Field(default_factory=list)
    order_by: Annotated[list[Sort], Field(max_length=5)] = Field(default_factory=list)
    limit: Annotated[int, Field(strict=True, ge=1, le=200)] = 50
    offset: Annotated[int, Field(strict=True, ge=0, le=50_000)] = 0

    @model_validator(mode="after")
    def shape(self):
        if self.group_by and not self.aggregates:
            raise ValueError("Grouping requires at least one aggregate.")
        if self.aggregates and self.select is not None:
            raise ValueError("For aggregates, use group_by rather than select.")
        if self.select is not None and not self.select:
            raise ValueError("Select at least one field.")
        names = [a.alias for a in self.aggregates] + [g.field for g in self.group_by]
        if len(names) != len(set(names)):
            raise ValueError("Group names and aggregate aliases must be unique.")
        return self
