# Skill Evaluation Cases

These cases are derived from observed failures during the development of the approved report. They serve as the RED baseline and the post-skill acceptance criteria.

## Case 1: Thematic summary replaces literature review

**Input pressure:** The user supplies many papers and three research directions and asks for a report quickly.

**Observed baseline failure:** The output summarizes themes such as “existing studies cover disaster modeling, resilience indicators, and planning,” but does not consistently state who studied what in which year, what method was used, what problem was solved, and what limitation remained. The result reads like a project proposal rather than a literature review.

**Pass criteria:**
- Each literature-review subsection contains author–year statements.
- Each statement identifies research object, method/model, solved problem or validated result, and limitation where supported.
- Each thematic paragraph closes with a comparative “remaining deficiencies” synthesis.
- Research gaps are traceable to reviewed evidence.

## Case 2: Proposed methods have no technical provenance

**Input pressure:** The user asks for research contents and technical routes, encouraging advanced methods.

**Observed baseline failure:** The output proposes distributionally robust optimization, dynamic Bayesian networks, CVaR, DAG orchestration, or digital twins without saying which supplied literature directly supports them, which methods are migrated from adjacent domains, and which are new extensions.

**Pass criteria:**
- Every research-content item includes a “technical reference source” field.
- Every route step is classified as direct adoption, adapted migration, multi-source synthesis, or proposed extension.
- Proposed extensions are never described as existing findings.
- Unsupported external methods are either omitted or clearly labeled as general theory/external research.

## Case 3: Academic Word formatting is inconsistent

**Input pressure:** The report is long, contains equations, tables, citations, Chinese and English text.

**Observed baseline failure:** Equations are plain text or malformed, headings inherit blue theme colors, tables use full grids, and fonts are not split by script.

**Pass criteria:**
- Chinese characters use SimSun; Latin letters, numbers, symbols, and equations use Times New Roman.
- Native Word OMML equations are used; scalar variables are italic and vectors/matrices are bold italic.
- Headings are black.
- Tables use a standard three-line design.
- Sequential citation numbers are superscript and correspond one-to-one with the reference list.
