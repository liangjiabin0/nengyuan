# Planning papers: model, solver, and evidence

Use when the central contribution is network expansion, resource siting/sizing, scheduling, market coordination, or another planning optimization problem. Infer the exact hierarchy and evidence themes from the paper. The two reference cases behind this guide were a multi-stage transmission/distribution expansion model and a PV-grid-EV joint planning model; their decision hierarchies and algorithms differ.

## Method and model slide

For the user’s planning-category examples, the model is the central explanatory content of slide 1. Include an explicit objective equation, the meaning and unit of its terms, and the defining equations of the key constraints beside their physical or economic purpose. Retain the real decision variables and decision owner. Scheduling and reserve-market manuscripts use this model route even when they contain a forecasting module. Select the constraints that explain the contribution; a compact representative model can omit routine equations while preserving the decisive boundaries.

Extract the planning question before drawing:

- **System boundary and agents:** networks, coupling buses, operators, market participants, user response, and who controls each decision. Show energy, price, information, and decision feedback as distinct relationships where the paper distinguishes them.
- **Decision structure:** investment versus operation, stage or scenario, upper versus lower level, first-stage versus recourse, and the final decision outputs. Mark which decisions are irreversible or inherited across stages only when the model says so.
- **Objective:** show the paper's exact optimization direction and the few cost/revenue terms that explain its contribution; attach each term's physical meaning and unit. Do not combine independent agents' objectives into a fictional single objective.
- **Constraints:** group the decisive physical and economic families, such as power balance, line/substation limits, radiality, investment timing, storage/EV operation, service capacity, transaction balance, and price response. Put the defining equations near their role rather than filling the slide with a formula list.
- **Solver:** draw the actual iteration and information exchange. For Benders-type methods, distinguish master investment decisions, scenario/operation subproblems, bounds, cuts, filtering, and stopping criterion. For distributed/bilevel methods, distinguish agent subproblems, coordination variables, price or dual updates, alternating optimization, response, and convergence. Do not substitute one solver's boxes for another.

The useful composition in the two reviewed planning decks is an architecture region, an objective/constraint region, and a solver region. Keep these as visual responsibilities, not mandatory equal-width columns; enlarge the system map or optimization loop when it carries more of the explanation. End at a concrete plan: what is built, sized, scheduled, priced, or dispatched.

Record `planning-model.md` with the system boundary, decision owners, variables, stage/scenario structure, objective terms, constraint families, solver exchanges, outputs, and a source reference for each. Also create the mandatory `semantic-graph.json` and `diagram-layout.json` following [graphic-method-workflow.md](graphic-method-workflow.md). The prose record alone is insufficient. Planning uses the shared semantic validator, not the forecasting-specific training-graph validator. Show device/agent roles and typed exchanges, then attach objectives and constraints to those roles. Avoid repeating the architecture as a text-only step list.

## Results and computational analysis slide

Choose three complementary evidence themes, normally from:

1. **Plan and economic value:** the baseline/case definitions, expansion topology or timing, capital and operating cost, savings, or avoided investment. Use like-for-like units, horizon, scenario probabilities, and denominator for percentages.
2. **Why the plan changes:** scenario recourse, smart-resource substitution, flows/constraints, price-induced demand movement, transactions, congestion, service time, and stakeholder outcomes. A topology map, stage tree, stacked costs, price curve, heatmap, or small table may explain the mechanism better than a generic bar chart.
3. **Scale and solvability:** network size, scenario/stage count, solver and hardware where reported, iteration count, cuts, wall time, optimality gap, convergence, and baseline algorithm. Present the problem size beside runtime and gap; a faster run on a different-sized case does not by itself prove algorithmic speedup. If the paper has no computational experiment, use another sourced planning outcome rather than inventing one.

Use a chart for comparable numerical series, a native table for exact multi-metric comparisons, and a topology/stage diagram for discrete plans. Do not force three charts. Give each region a short conclusion that interprets its evidence without claiming causality beyond the comparisons in the paper. Keep computed percentages traceable to explicit source values and formulas.
