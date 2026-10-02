from __future__ import annotations

import os
import time
from typing import Any

import httpx


class OpenModelicaGatewayClient:
    def __init__(self, base_url: str, api_key: str):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        return {"X-API-Key": self.api_key, "Content-Type": "application/json"}

    def check(self, payload: dict[str, Any]) -> dict[str, Any]:
        response = httpx.post(f"{self.base_url}/v1/models/check", json=payload, headers=self._headers(), timeout=120)
        response.raise_for_status()
        return response.json()

    def simulate_and_wait(self, payload: dict[str, Any], timeout_s: float = 300) -> dict[str, Any]:
        created = httpx.post(f"{self.base_url}/v1/simulations", json=payload, headers=self._headers(), timeout=60)
        created.raise_for_status()
        job = created.json()
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            status = httpx.get(f"{self.base_url}{job['status_url']}", headers=self._headers(), timeout=30).json()
            if status["status"] == "succeeded":
                result = httpx.get(f"{self.base_url}{job['result_url']}", headers=self._headers(), timeout=60).json()
                return {"job": status, "result": result}
            if status["status"] == "failed":
                raise RuntimeError(status.get("error") or "simulation failed")
            time.sleep(1.0)
        raise TimeoutError("simulation timed out")


if __name__ == "__main__":
    client = OpenModelicaGatewayClient(
        os.environ.get("OPENMODELICA_GATEWAY_URL", "http://127.0.0.1:18088"),
        os.environ.get("OMG_API_KEY", "change-me"),
    )
    print(client.check({"model": {"model_name": "BatterySOC", "modelica_code": open("BatterySOC.mo", encoding="utf-8").read()}}))
