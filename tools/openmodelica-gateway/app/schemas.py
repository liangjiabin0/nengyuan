from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class ModelPayload(BaseModel):
    model_name: str
    modelica_code: str


class SimulationOptions(BaseModel):
    start_time: float = 0
    stop_time: float = 1
    number_of_intervals: int = 500
    tolerance: float = 1e-6
    solver: Literal["dassl", "ida", "cvode"] = "dassl"


class CheckRequest(BaseModel):
    model: ModelPayload


class SimulationRequest(BaseModel):
    model: ModelPayload
    parameters: dict[str, Any] = Field(default_factory=dict)
    outputs: list[str] = Field(default_factory=lambda: ["time"])
    options: SimulationOptions = Field(default_factory=SimulationOptions)
    max_points: int | None = None


class JobAccepted(BaseModel):
    job_id: str
    status: str
    status_url: str
    result_url: str
