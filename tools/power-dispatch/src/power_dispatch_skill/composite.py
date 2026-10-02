from __future__ import annotations
from dataclasses import dataclass, asdict

@dataclass
class BoundaryPort:
    pcc_id: str
    upper_region: str
    lower_region: str
    upper_bus: int
    lower_bus: int = 0
    variables: tuple[str,...] = ("P_MW","Q_Mvar","V_pu")
    sign_convention: str = "positive_from_upper_to_lower"


def build_main_dist_micro_manifest(spec: dict):
    case=spec["case"]
    main=case.get("main_grid","ieee14")
    dist=case.get("distribution","case33bw")
    microgrids=case.get("microgrids") or [
        {"id":"mg1","pcc_bus":18,"template":"pv_storage_load"},
        {"id":"mg2","pcc_bus":25,"template":"pv_storage_load"},
    ]
    ports=[]
    for i,mg in enumerate(microgrids,1):
        ports.append(BoundaryPort(f"PCC_D1_MG{i}","distribution_1",mg.get("id",f"microgrid_{i}"),int(mg["pcc_bus"])))
    return {
        "type":"composite_case_manifest",
        "standard_case":False,
        "components":{"main_grid":main,"distribution":dist,"microgrids":microgrids},
        "boundary_ports":[asdict(x) for x in ports],
        "normalization_required":["baseMVA","voltage_levels","P_Q_sign","bus_id_mapping","time_index"]
    }
