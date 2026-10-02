# Canonical Review Report Schema

Write one UTF-8 JSON object. Keep keys/enumerated values in English; write reader-facing prose in the selected review language.

For standard/deep empirical, computational, method, optimization, control, engineering, benchmark, and simulation papers, the four core audit objects are required unless genuinely not applicable.

## Required structure

```json
{
  "metadata": {
    "paper_title": "Reader-facing title",
    "source_file": "paper.pdf",
    "target_venue": "general",
    "paper_type": "method",
    "review_language": "zh-CN",
    "review_depth": "standard",
    "latest_literature_check": "on",
    "reproduction_verification": "reporting_only",
    "review_date": "2026-09-03"
  },
  "verdict": {
    "decision": "major_revision",
    "confidence": "high",
    "rationale": "Explicitly summarize experimental support, reproducibility, latest-work comparison, and theoretical support."
  },
  "summary": "Neutral summary of the question, method, evidence, and claimed contribution.",
  "conclusion_support": {
    "overall": "partially_supported",
    "rationale": "Overall experiment-to-conclusion assessment.",
    "claims": [
      {
        "id": "C1",
        "claim": "The proposed method outperforms strong baselines.",
        "location": "Section 4.3",
        "support_status": "partially_supported",
        "supporting_evidence": ["Table 2", "Figure 5"],
        "evidence_assessment": "Positive results are reported, but variability and one strong comparator are missing.",
        "missing_or_weak_evidence": "Repeated runs and a stronger comparable baseline.",
        "required_resolution": "Add fair comparison/repeated-run uncertainty or narrow the claim."
      }
    ]
  },
  "reproducibility": {
    "reproduction_readiness": "major_gaps",
    "verification_scope": "reporting_only",
    "rationale": "Material split/preprocessing details are missing.",
    "checked_items": [
      {"item": "data split", "status": "missing", "location": "Section 4.1", "evidence": "Split-generation procedure is not stated."}
    ],
    "material_gaps": ["Exact split construction"],
    "reproduction_attempt": "No execution was performed."
  },
  "latest_literature_comparison": {
    "comparison_status": "inadequate",
    "search_scope": "Recent directly relevant work verified through primary sources, prioritizing 2023-2026.",
    "rationale": "Recent related work is cited, but two strong directly comparable methods are absent from experiments.",
    "recent_relevant_works": [
      {
        "title": "Recent relevant method",
        "year": 2025,
        "source": "Journal/Conference",
        "url": "https://example.org",
        "relevance": "Same task and benchmark family",
        "cited_in_manuscript": false,
        "experimentally_compared": false
      }
    ],
    "comparison_fairness": "Existing baselines use different tuning budgets.",
    "missing_comparators": ["Recent relevant method"],
    "required_resolution": "Add fair comparison where feasible or narrow superiority claims and discuss incompatibility."
  },
  "theoretical_analysis": {
    "overall_status": "partially_supported",
    "applicability": "required",
    "rationale": "Steady-state allocation is derived, but the broader stability claim is not established.",
    "claims": [
      {
        "id": "T1",
        "claim": "The closed-loop system is stable.",
        "location": "Section 3.4",
        "theoretical_support_status": "unsupported",
        "supporting_derivation": "Equation 28-34",
        "assumptions": ["No saturation", "constant communication delay = 0"],
        "assessment": "The derivation proves only the steady-state allocation relation, not closed-loop stability.",
        "required_resolution": "Provide a valid stability proof under stated assumptions or narrow the claim."
      }
    ]
  },
  "strengths": [
    {"title": "Specific strength", "evidence": "Observable evidence", "importance": "Why it matters"}
  ],
  "issues": [
    {
      "id": "M1",
      "title": "Concise finding title",
      "severity": "major",
      "category": "latest_comparison",
      "location": "Section 4.3",
      "evidence_type": "external_source",
      "evidence": "Concrete manuscript observation plus externally verified comparison context.",
      "problem": "Why this is a defect or uncertainty",
      "consequence": "Affected claim",
      "root_cause": "Underlying cause",
      "required_action": "Minimum sufficient fix",
      "acceptance_criteria": "Observable closure condition",
      "confidence": "high",
      "verification_status": "verified",
      "related_claim_ids": ["C1"],
      "reviewers": ["latest_literature_claims"],
      "external_sources": [{"label": "Primary source", "url": "https://example.org"}]
    }
  ],
  "revision_priorities": [],
  "disagreements": [],
  "reviewer_verdicts": [],
  "limitations_of_review": []
}
```

## Enumerations

- `review_language`: `zh-CN`, `en`, `bilingual`
- `review_depth`: `quick`, `standard`, `deep`
- `latest_literature_check`: `off`, `on`
- `decision`: `accept`, `minor_revision`, `major_revision`, `reject`, `unable_to_assess`
- `severity`: `critical`, `major`, `moderate`, `minor`
- `confidence`: `high`, `medium`, `low`
- `verification_status`: `verified`, `partially_verified`, `unverified`
- `support_status`: `supported`, `partially_supported`, `unsupported`, `not_assessable`
- `reproduction_readiness`: `ready`, `minor_gaps`, `major_gaps`, `not_assessable`, `not_applicable`
- `verification_scope`: `reporting_only`, `artifacts_inspected`, `partial_execution`, `end_to_end_execution`
- reproducibility item `status`: `specified`, `partially_specified`, `missing`, `inaccessible`, `not_applicable`
- `comparison_status`: `adequate`, `partially_adequate`, `inadequate`, `not_assessable`
- `theoretical_support_status`: `supported`, `partially_supported`, `unsupported`, `not_required`, `not_assessable`
- `theoretical_analysis.applicability`: `required`, `optional`, `not_required`, `not_assessable`
- `evidence_type`: `quote`, `text`, `table`, `figure`, `equation`, `calculation`, `absence`, `artifact`, `external_source`, `reproduction_attempt`

## Output rules

- `metadata`, `verdict`, `summary`, and `issues` are always required.
- Standard/deep scientific reviews should include all four core audit objects.
- If web research is disabled, `latest_literature_comparison.comparison_status` must be `not_assessable`, not guessed.
- Every `partially_supported` or `unsupported` experimental/theoretical central claim should map to a review issue or explain why it does not affect the decision.
- External latest-work claims need actual checked sources.
- Never set `verification_scope` to execution values unless execution occurred.
- The verdict rationale must explicitly synthesize all applicable core audits.
