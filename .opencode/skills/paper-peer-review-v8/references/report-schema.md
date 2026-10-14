# Canonical Review JSON Schema

Use one UTF-8 JSON object as the canonical scientific record. The Word report may show only top-three summary tables, but the JSON may preserve more detail.

```json
{
  "metadata": {
    "paper_title": "...",
    "source_file": "paper.pdf",
    "manuscript_language": "en",
    "target_venue": "general",
    "review_depth": "deep",
    "review_date": "YYYY-MM-DD",
    "review_protocol_version": "8.0"
  },
  "classification": {
    "primary_category": "optimization_planning_operation",
    "secondary_category": null,
    "rationale": "..."
  },
  "verdict": {
    "decision": "major_revision",
    "confidence": "high",
    "rationale": "..."
  },
  "summary": "...",
  "conclusion_support": {
    "overall": "partially_supported",
    "claims": [
      {
        "id": "C1",
        "claim": "...",
        "location": "...",
        "support_status": "partially_supported",
        "supporting_evidence": ["..."],
        "evidence_assessment": "...",
        "required_resolution": "..."
      }
    ]
  },
  "undefined_variables": [
    {
      "symbol": "theta",
      "location": "Eq. (12)",
      "missing_definition": true,
      "problem": "Meaning is not defined in the inspected equation, surrounding text or nomenclature",
      "impact": "Changes the reported ranking",
      "severity": "major"
    }
  ],
  "data_code_availability": {
    "data_status": "partially_available",
    "code_status": "not_provided",
    "evidence": "...",
    "gaps": ["..."]
  },
  "reproduction": {
    "mode": "principle_level",
    "readiness": "major_gaps",
    "verification_scope": "partial_execution",
    "data_used": "local/simulated/public data description",
    "assumptions": ["..."],
    "observations": ["..."],
    "barriers": [
      {"item": "...", "impact": "...", "required_action": "..."}
    ]
  },
  "category_audit": {
    "data_science": null,
    "optimization": {
      "esopt_reproduction": "...",
      "engineering_case_type": "modified_standard_test_system",
      "engineering_case_assessment": "..."
    },
    "stability_control": null
  },
  "latest_literature_comparison": {
    "comparison_status": "partially_adequate",
    "recent_relevant_works": [
      {
        "title": "...",
        "authors": "...",
        "year": 2026,
        "source": "...",
        "doi": "...",
        "landing_url": "...",
        "pdf_url": "...",
        "available_before_submission": null,
        "journal": "Journal / conference / preprint venue",
        "cited_in_manuscript": false,
        "experimentally_compared": false,
        "relevance": "...",
        "acquisition_status": "downloaded_preprint",
        "version_type": "preprint",
        "local_pdf_path": "/working/path/file.pdf",
        "access_note": "..."
      }
    ]
  },
  "theoretical_analysis": {
    "overall_status": "partially_supported",
    "claims": [
      {
        "id": "T1",
        "claim": "...",
        "location": "...",
        "theoretical_support_status": "partially_supported",
        "assumptions": ["..."],
        "assessment": "...",
        "required_resolution": "..."
      }
    ]
  },

  "presentation": {
    "ppt_required": true,
    "ppt_language": "zh-CN",
    "ppt_route": "optimization_planning_operation",
    "integration_skill": "integrations/two-slide-paper-ppt-codegen",
    "output_pptx_path": "/working/path/<title>_Two-Slide_Review.pptx",
    "spec_path": "/working/path/two-slide-spec.json",
    "slide1_focus": "method/principle/solver/control flow",
    "slide2_reproduction_data_rule": "charts_use_reviewer_side_reproduction_outputs",
    "reproduction_chart_data": [
      {
        "id": "chart-1",
        "title": "Reduced-case ESOPT objective trend",
        "data_path": "/working/path/chart-1.csv",
        "data_origin": "principle_reproduction",
        "generation_script_or_note": "Generated from ESOPT reduced-case run",
        "used_on_slide": 2
      }
    ],
    "qa_status": "passed",
    "qa_notes": ["exactly two slides", "charts editable", "slide 2 uses reproduction data"]
  },
  "issues": [
    {
      "id": "M1",
      "severity": "major",
      "category": "reproducibility",
      "location": "...",
      "evidence": "...",
      "problem": "...",
      "consequence": "...",
      "reproduction_observation": "...",
      "required_action": "...",
      "acceptance_criteria": "...",
      "verification_status": "verified"
    }
  ],
  "knowledge_application": {
    "memory_version": "8.0",
    "checks": [
      {
        "rule_id": "M01",
        "trigger": "No human-review materials supplied",
        "location": "input inventory",
        "evidence": "Only the primary manuscript was supplied",
        "verification_scope": "artifacts_inspected",
        "status": "not_applicable",
        "assessment": "No feedback/rebuttal workflow needed",
        "related_issue_ids": []
      }
    ]
  },
  "human_feedback": [],
  "parameter_configuration_gaps": [],
  "model_ambiguities": [],
  "formula_audit": [],
  "minor_comments": ["..."],
  "revision_audit": [],
  "limitations_of_review": ["..."]
}
```

## Core enumerations

- `primary_category`: `data_science`, `optimization_planning_operation`, `system_stability_control`
- `decision`: `accept`, `minor_revision`, `major_revision`, `reject`, `unable_to_assess`
- `support_status`: `supported`, `partially_supported`, `unsupported`, `not_assessable`
- `severity`: `critical`, `major`, `moderate`, `minor`
- `verification_status`: `verified`, `partially_verified`, `unverified`
- `verification_scope`: `reporting_only`, `artifacts_inspected`, `partial_execution`, `end_to_end_execution`
- `reproduction.mode`: `result_replication`, `principle_level`, `reporting_only`
- `comparison_status`: `adequate`, `partially_adequate`, `inadequate`, `not_assessable`
- `theoretical_support_status`: `supported`, `partially_supported`, `unsupported`, `not_required`, `not_assessable`
- literature acquisition status: `downloaded_publisher_oa`, `downloaded_preprint`, `downloaded_repository`, `paywalled`, `no_public_pdf_found`, `download_failed`, `not_assessable`
- `presentation.ppt_route`: `data_science`, `optimization_planning_operation`, `system_stability_control`
- `presentation.data_origin`: `principle_reproduction`, `paper_reported_context`, `simulated_reproduction`, `partial_reproduction`, `reproduction_barrier`
- `presentation.qa_status`: `passed`, `failed`, `not_run`


## Presentation artifact rules

- Full review preserves the PPT default. A human-feedback reassessment requesting reports/skill updates may use `presentation.ppt_required=false` with a specific scope reason.
- `presentation.reproduction_chart_data` must identify the reviewer-side data used for slide 2 charts. Do not list paper-reported data as `principle_reproduction`.
- If no reliable numerical reproduction data exist, set `data_origin` to `reproduction_barrier` and use a barrier table/metrics module on slide 2 rather than fabricated charts.
- The PPTX output must be generated through or be compatible with `integrations/two-slide-paper-ppt-codegen` and must contain exactly two slides.
- Final ZIP packaging requires PPT paths only when `ppt_required=true`; explicit false in the manifest allows report-only reassessment.
- `available_before_submission` is true/false only with verified dates, otherwise null.
- Undefined-symbol entries record `missing_definition=true`; distinguish definition gaps from parameter/configuration gaps.
- Human-feedback records map the original note and its anchor to manuscript verification and the review action.
- Matched Markdown/Word use the same report blocks; retain a parity check and formula source.

## Optional canonical report blocks

`report_blocks` is an ordered list of `heading` (text, level), `paragraph` (text), `table` (headers, rows), and `equation` (label, latex). The paired renderer consumes this list once for both versions and audits saved DOCX text/table counts and native equation objects. Verify formula semantics and every rendered page separately.

## v8 knowledge and feedback trace

New records set `metadata.review_protocol_version="8.0"`. `knowledge_application.checks` contains common M01–M04 (use `not_applicable` with a reason where appropriate) plus applicable domain checks. The illustrative one-item block above must be completed for the actual review. Each check records `rule_id`, `trigger`, `location`, `evidence`, `verification_scope`, `status`, `assessment`, and `related_issue_ids`.

- `status`: `checked_no_issue`, `issue_supported`, `conditional_risk`, `not_applicable`, `not_assessable`.
- `issue_supported` links at least one existing issue ID. A conditional risk retains uncertainty in both record and report; rule IDs are not proof of an error.
- `verification_scope` uses the existing scope enumeration. An executed finding cannot be labeled only `reporting_only` or `artifacts_inspected`.
- Existing older records remain readable; validators enforce the new common trace only for declared v8 records.

When `presentation.ppt_required=false`, set `presentation.scope_reason` to the user's requested artifact scope. When no numerical execution occurred, keep `reproduction.verification_scope` at `reporting_only` or `artifacts_inspected`; `issues[].evidence_basis="reviewer_execution"` requires an actual partial or end-to-end execution record. Structural validation checks consistency of these declarations, not whether execution really occurred.

For each human feedback item retain `comment`, `source_anchor`, `intent_type` (`terminology_style`, `factual_correction`, `scientific_verification`, `deliverable_requirement`), `manuscript_evidence`, `verification_result`, `review_action`, `status` (`implemented`, `partially_implemented`, `not_verifiable`, `not_applicable`) and optional `related_issue_ids`. Keep factual/scientific verification separate from author revision status; explain when source evidence is unavailable. Legacy `comment`/`action` entries may be read but do not constitute the full v8 trace.

`parameter_configuration_gaps` records an already-defined parameter's missing value/range/configuration and its impact; `model_ambiguities` records non-unique mathematical/physical interpretation. Neither is an undefined-meaning entry. `formula_audit` records label, LaTeX source, `origin` (`manuscript`, `reviewer_restatement`, `proposed_correction`, `reviewer_model`), manuscript location when relevant, and a complete `symbols` list with meaning/unit/index/domain as appropriate.

For reduced reproduction, add `reproduction.model_scope` with `retained_components`, `omitted_components` and `scope_rationale`; label a local mechanism test explicitly when important structure is omitted. Issues may add `evidence_basis` (`manuscript_fact`, `reviewer_inference`, `reviewer_execution`) and retain `verification_status`. Do not present an unexecuted reviewer analysis as an executed numerical result.

Report blocks render the relevant feedback closure and scientific findings, rather than dumping every unused rule into the human report. The full trace remains in JSON.
