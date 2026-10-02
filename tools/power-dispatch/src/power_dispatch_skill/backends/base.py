from __future__ import annotations
from abc import ABC, abstractmethod
from dataclasses import dataclass

@dataclass
class BackendCapabilities:
    single_period: bool=False
    time_series: bool=False
    active_power: bool=True
    reactive_power: bool=False
    hierarchical: bool=False
    multi_timescale: bool=False
    ac_validation: bool=False

class OptimizationBackend(ABC):
    name: str = "abstract"
    capabilities = BackendCapabilities()

    def supports(self, spec: dict) -> tuple[bool,str]:
        caps=spec["capabilities"]
        if caps["power_control"] in {"Q","PQ"} and not self.capabilities.reactive_power:
            return False,"backend does not support reactive power"
        if len(caps["time_scales"])>1 and not self.capabilities.multi_timescale:
            return False,"backend does not support multiple time scales"
        if caps["hierarchy"] in {"transmission_distribution","distribution_microgrid","main_distribution_microgrid"} and not self.capabilities.hierarchical:
            return False,"backend does not support hierarchy"
        return True,"ok"

    @abstractmethod
    def run(self, spec: dict, context: dict) -> dict: ...
