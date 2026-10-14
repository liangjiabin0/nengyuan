import json
import sys
from collections import defaultdict, deque
from pathlib import Path


NODE_ROLES = {
    "input", "preprocessing", "feature", "core", "fusion", "prediction",
    "ground_truth", "loss", "optimizer", "auxiliary",
}
PHASES = {"inference", "training", "both"}
FLOW_TYPES = {"data", "auxiliary", "skip", "residual", "loss", "optimization"}


def require(condition, message, errors):
    if not condition:
        errors.append(message)


def reachable(starts, adjacency):
    seen = set(starts)
    queue = deque(starts)
    while queue:
        node = queue.popleft()
        for target in adjacency[node]:
            if target not in seen:
                seen.add(target)
                queue.append(target)
    return seen


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate_method_graph.py <method-graph.json>")
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding="utf-8"))
    errors = []
    warnings = []

    require(isinstance(data.get("meta"), dict), "meta must be an object", errors)
    require(bool(data.get("meta", {}).get("paperTitle")), "meta.paperTitle is required", errors)
    require(bool(data.get("meta", {}).get("sourcePath")), "meta.sourcePath is required", errors)
    nodes = data.get("nodes")
    edges = data.get("edges")
    require(isinstance(nodes, list) and nodes, "nodes must be a non-empty list", errors)
    require(isinstance(edges, list) and edges, "edges must be a non-empty list", errors)
    if errors:
        raise SystemExit("ERROR:\n- " + "\n- ".join(errors))

    by_id = {}
    for index, node in enumerate(nodes):
        prefix = f"nodes[{index}]"
        node_id = node.get("id")
        require(isinstance(node_id, str) and node_id, f"{prefix}.id is required", errors)
        if node_id in by_id:
            errors.append(f"duplicate node id: {node_id}")
        else:
            by_id[node_id] = node
        require(bool(node.get("label")), f"{prefix}.label is required", errors)
        require(node.get("role") in NODE_ROLES, f"{prefix}.role is invalid", errors)
        require(node.get("phase") in PHASES, f"{prefix}.phase is invalid", errors)
        require(isinstance(node.get("inputs"), list), f"{prefix}.inputs must be a list", errors)
        require(isinstance(node.get("outputs"), list), f"{prefix}.outputs must be a list", errors)
        require(bool(node.get("purpose")), f"{prefix}.purpose is required", errors)
        require(isinstance(node.get("evidenceRefs"), list) and node.get("evidenceRefs"), f"{prefix}.evidenceRefs is required", errors)
        if node.get("role") in {"loss", "optimizer", "ground_truth"}:
            require(node.get("phase") == "training", f"{node_id} must be training-only", errors)

    inference_adjacency = defaultdict(list)
    incoming = defaultdict(list)
    outgoing = defaultdict(list)
    for index, edge in enumerate(edges):
        prefix = f"edges[{index}]"
        source = edge.get("from")
        target = edge.get("to")
        require(source in by_id, f"{prefix}.from references unknown node {source}", errors)
        require(target in by_id, f"{prefix}.to references unknown node {target}", errors)
        require(edge.get("flowType") in FLOW_TYPES, f"{prefix}.flowType is invalid", errors)
        require(edge.get("phase") in PHASES, f"{prefix}.phase is invalid", errors)
        require(bool(edge.get("variable")), f"{prefix}.variable is required", errors)
        require(isinstance(edge.get("evidenceRefs"), list) and edge.get("evidenceRefs"), f"{prefix}.evidenceRefs is required", errors)
        if source in by_id and target in by_id:
            incoming[target].append(edge)
            outgoing[source].append(edge)
        if edge.get("phase") in {"inference", "both"} and edge.get("flowType") in {"data", "auxiliary", "skip", "residual"}:
            inference_adjacency[source].append(target)
        if edge.get("flowType") == "optimization":
            require(edge.get("phase") == "training", f"{prefix} optimization edge must be training-only", errors)
            require(edge.get("lineStyle") == "dashed", f"{prefix} optimization edge must be dashed", errors)

    input_ids = [node["id"] for node in nodes if node.get("role") == "input"]
    prediction_ids = [node["id"] for node in nodes if node.get("role") == "prediction"]
    require(bool(input_ids), "at least one input node is required", errors)
    require(bool(prediction_ids), "at least one prediction node is required", errors)
    if input_ids and prediction_ids:
        reached = reachable(input_ids, inference_adjacency)
        for node_id in prediction_ids:
            require(node_id in reached, f"prediction node {node_id} is not reachable from an input on the inference path", errors)

    for node in nodes:
        node_id = node["id"]
        role = node.get("role")
        if role == "loss":
            require(bool(incoming[node_id]), f"loss node {node_id} has no inputs", errors)
            require(any(edge.get("flowType") == "loss" for edge in incoming[node_id]), f"loss node {node_id} needs loss edges", errors)
        if role == "optimizer":
            require(any(edge.get("flowType") == "optimization" for edge in outgoing[node_id]), f"optimizer node {node_id} has no parameter-update feedback edge", errors)
        if role in {"loss", "optimizer"}:
            for edge in outgoing[node_id]:
                require(edge.get("flowType") not in {"data", "auxiliary"}, f"training node {node_id} cannot feed the inference data path", errors)

    for edge in edges:
        source = by_id.get(edge.get("from"), {})
        target = by_id.get(edge.get("to"), {})
        variable = edge.get("variable")
        if variable and edge.get("flowType") in {"data", "auxiliary", "skip", "residual"}:
            if variable not in source.get("outputs", []):
                warnings.append(f"edge {edge.get('from')} -> {edge.get('to')}: {variable} is not listed in source outputs")
            if variable not in target.get("inputs", []):
                warnings.append(f"edge {edge.get('from')} -> {edge.get('to')}: {variable} is not listed in target inputs")

    if errors:
        raise SystemExit("ERROR:\n- " + "\n- ".join(errors))
    print(f"PASS: {len(nodes)} nodes and {len(edges)} evidence-backed edges validated")
    for warning in warnings:
        print(f"WARNING: {warning}")


if __name__ == "__main__":
    main()
