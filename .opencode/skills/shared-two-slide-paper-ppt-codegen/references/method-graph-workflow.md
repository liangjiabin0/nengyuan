# Evidence-backed method computation graph

Use this workflow for forecasting or another learned prediction method before designing slide 1. Analyze the source document's real data flow, module dependencies, training logic, and final output before choosing the visual layout. For planning optimization, use [planning-paper.md](planning-paper.md) instead; the prediction roles and training/inference phases below do not describe an investment solver.

## Required reading scope

Read the relevant material as a connected whole:

1. Abstract and Introduction contributions.
2. Problem Definition.
3. Proposed Method or Materials and Methods.
4. Framework figures and captions.
5. Each core and auxiliary module's正文.
6. Equations defining variables and transformations.
7. Loss, regularization, optimization, ensemble, and post-processing sections.

When the figure, prose, and equations appear inconsistent, continue reading until the relationship can be supported. Do not fill missing connections from domain convention.

## Required artifacts and order

### 1. `method-logic.md`

Document these sections before drawing:

- Input
- Preprocessing
- Feature Extraction
- Core Model
- Parallel or Auxiliary Branch
- Fusion or Ensemble
- Prediction
- Loss
- Optimization

For every major module, record its input, output, function, variables or tensor names, connection type, phase, and evidence reference.

### 2. `method-graph.json`

Represent the method as nodes and directed edges. Use this minimal structure:

```json
{
  "meta": {"paperTitle": "...", "sourcePath": "..."},
  "nodes": [
    {
      "id": "satellite_input",
      "label": "卫星图像序列",
      "role": "input",
      "phase": "both",
      "inputs": [],
      "outputs": ["S_{t-15:t}"],
      "purpose": "提供云层时空演化信息",
      "evidenceRefs": ["PDF p.4 Fig.2"]
    }
  ],
  "edges": [
    {
      "from": "satellite_input",
      "to": "satellite_encoder",
      "variable": "S_{t-15:t}",
      "flowType": "data",
      "phase": "both",
      "lineStyle": "solid",
      "evidenceRefs": ["PDF p.4 Fig.2"]
    }
  ]
}
```

Allowed node roles are `input`, `preprocessing`, `feature`, `core`, `fusion`, `prediction`, `ground_truth`, `loss`, `optimizer`, and `auxiliary`. Allowed phases are `inference`, `training`, and `both`.

Allowed edge flow types are `data`, `auxiliary`, `skip`, `residual`, `loss`, and `optimization`.

- `data`: forward tensor or prediction flow, solid line.
- `auxiliary`: graph, mask, prior, position code, structure parameter, or other non-sequential input; visually distinct but not inserted into the main data chain.
- `skip` or `residual`: explicit bypass connection.
- `loss`: predicted value, ground truth, or intermediate feature entering a training objective.
- `optimization`: optimizer feedback to trainable modules, dashed line.

Validate with:

```powershell
python scripts/validate_method_graph.py path/to/method-graph.json
```

### 3. `visual-design-spec.md`

Define regions, box text, arrow directions, solid/dashed meanings, formula positions, icons, input/output labels, and training-only styling. Choose the layout only after the topology is fixed.

Express the graph as readable text arrows within this design spec if helpful. Separate inference and training when appropriate. Draw native PowerPoint nodes and connectors directly from the graph and design spec; do not collapse parallel branches into a linear chain.

## Compression priority

When space is limited, preserve in this order:

1. Inputs, core intermediate representations, key innovation modules, connection topology, and final outputs.
2. Important transformations, equations, targets, and losses.
3. Non-innovative internal layers.

Never remove a connection whose absence changes the method's meaning.

## Consistency review

Before building the PPT, confirm:

- each module input is produced by an upstream node or declared as an independent input;
- every edge has a source reference;
- parallel modules remain parallel;
- graph structures, masks, priors, and position codes enter the module that consumes them;
- encoder outputs and decoder inputs match the paper;
- the prediction output states the object and future horizon when available;
- prediction loss receives both prediction and ground truth;
- regularization and alignment losses are not mislabeled as feature fusion;
- optimizer feedback is training-only and dashed;
- an audience can follow the data transformation from input to prediction.
