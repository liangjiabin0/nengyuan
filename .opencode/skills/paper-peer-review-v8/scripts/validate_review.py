#!/usr/bin/env python3
import argparse,json,re
from pathlib import Path
VALID_CATS={'data_science','optimization_planning_operation','system_stability_control'}
VALID_ORIGINS={'principle_reproduction','paper_reported_context','simulated_reproduction','partial_reproduction','reproduction_barrier'}
SCOPES={'reporting_only','artifacts_inspected','partial_execution','end_to_end_execution'}
CHECK_STATUSES={'checked_no_issue','issue_supported','conditional_risk','not_applicable','not_assessable'}
FEEDBACK_STATUSES={'implemented','partially_implemented','not_verifiable','not_applicable'}
FEEDBACK_INTENTS={'terminology_style','factual_correction','scientific_verification','deliverable_requirement'}

def validate(d):
    """Check record structure and trace consistency; scientific truth needs source review."""
    errs=[]; c=d.get('classification',{}).get('primary_category')
    if c not in VALID_CATS: errs.append('invalid/missing primary_category')
    if len(d.get('latest_literature_comparison',{}).get('recent_relevant_works',[]))>3: print('WARN: Word report should show only top 3 latest works; JSON may retain more if intentionally used as full record.')
    if len(d.get('theoretical_analysis',{}).get('claims',[]))>3: print('WARN: Word report should show only top 3 theory items; JSON may retain more if intentionally used as full record.')
    if not d.get('conclusion_support',{}).get('claims'): errs.append('missing central claims')
    symbols=d.get('undefined_variables',[])
    if len(symbols)>3: errs.append('formal undefined-symbol table exceeds three items')
    for symbol in symbols:
        if symbol.get('missing_definition') is not True: errs.append('undefined symbol needs verified missing_definition=true')
    for work in d.get('latest_literature_comparison',{}).get('recent_relevant_works',[]):
        if not work.get('journal'): errs.append('literature entry needs journal/conference/preprint venue')
        timing=work.get('available_before_submission')
        if timing is not None and type(timing) is not bool: errs.append('invalid submission availability')
    for issue in d.get('issues',[]):
        for key in ('location','evidence','problem','consequence','required_action','acceptance_criteria'):
            if not issue.get(key): errs.append('issue missing '+key)
    pres=d.get('presentation')
    if not pres: errs.append('missing presentation section for required two-slide PPT deliverable')
    else:
        if pres.get('ppt_required',True) and not pres.get('output_pptx_path'): errs.append('presentation.output_pptx_path is required when ppt_required=true')
        if pres.get('ppt_route') not in VALID_CATS: errs.append('invalid/missing presentation.ppt_route')
        for item in pres.get('reproduction_chart_data',[]):
            if item.get('data_origin') not in VALID_ORIGINS: errs.append(f"invalid presentation data_origin: {item.get('data_origin')}")
    v8=str(d.get('metadata',{}).get('review_protocol_version','')).split('.')[0]=='8'
    issue_ids={issue.get('id') for issue in d.get('issues',[]) if issue.get('id')}
    knowledge=d.get('knowledge_application')
    if v8 and not isinstance(knowledge,dict): errs.append('v8 needs knowledge_application trace')
    if isinstance(knowledge,dict):
        memory=Path(__file__).resolve().parent.parent/'references'/'power-system-review-memory.md'
        rule_ids=set(re.findall(r'^### (M\d{2})\b',memory.read_text(encoding='utf-8-sig'),re.M))
        checks=knowledge.get('checks',[])
        if not isinstance(checks,list):
            errs.append('knowledge_application.checks must be a list'); checks=[]
        seen=set()
        for check in checks:
            if not isinstance(check,dict): errs.append('knowledge check must be an object'); continue
            rule=check.get('rule_id'); seen.add(rule)
            if rule not in rule_ids: errs.append(f'unknown memory rule: {rule}')
            for key in ('trigger','assessment'):
                if not check.get(key): errs.append(f'{rule}: missing {key}')
            status=check.get('status')
            if status not in CHECK_STATUSES: errs.append(f'{rule}: invalid check status')
            if check.get('verification_scope') not in SCOPES: errs.append(f'{rule}: invalid verification scope')
            if status not in ('not_applicable','not_assessable'):
                for key in ('location','evidence'):
                    if not check.get(key): errs.append(f'{rule}: checked finding needs {key}')
            linked=check.get('related_issue_ids',[])
            if not isinstance(linked,list): errs.append(f'{rule}: related_issue_ids must be a list'); linked=[]
            if status=='issue_supported' and not linked: errs.append(f'{rule}: supported issue needs linked issue ID')
            for item in linked:
                if item not in issue_ids: errs.append(f'{rule}: unknown linked issue ID {item}')
        if v8 and not {'M01','M02','M03','M04'}.issubset(seen): errs.append('v8 needs common checks M01-M04')
    if v8:
        for feedback in d.get('human_feedback',[]):
            for key in ('comment','source_anchor','manuscript_evidence','verification_result','review_action'):
                if not feedback.get(key): errs.append('human feedback missing '+key)
            if feedback.get('intent_type') not in FEEDBACK_INTENTS: errs.append('invalid human feedback intent')
            if feedback.get('status') not in FEEDBACK_STATUSES: errs.append('invalid human feedback status')
            for item in feedback.get('related_issue_ids',[]):
                if item not in issue_ids: errs.append('human feedback links unknown issue ID '+str(item))
        if pres and pres.get('ppt_required') is False and not pres.get('scope_reason'):
            errs.append('v8 report-only scope needs presentation.scope_reason')
        execution=d.get('reproduction',{}).get('verification_scope')
        for issue in d.get('issues',[]):
            if issue.get('evidence_basis')=='reviewer_execution' and execution not in ('partial_execution','end_to_end_execution'):
                errs.append('reviewer_execution issue conflicts with non-execution reproduction scope')
    return errs

def main():
    ap=argparse.ArgumentParser(); ap.add_argument('json_file',type=Path); a=ap.parse_args(); d=json.loads(a.json_file.read_text(encoding='utf-8-sig'))
    errs=validate(d)
    if errs: raise SystemExit('\n'.join(errs))
    print('OK')
if __name__=='__main__': main()
