#pragma once

// This audit runs only after all solver threads have joined. It reads retained
// immutable pool objects; it never enqueues work or changes a production filter.
namespace d2shadow {
struct State {
  uint64_t id=0,parent=0; int64_t cp=-1; double inserted=0;
  std::string producer,kind,route,reason,fingerprint;
  bool eligible=false,consumed=false;
  uint32_t depth=0;
  size_t integral_soft=0,hard=0;
  double integrality=0,max_row=std::numeric_limits<double>::quiet_NaN(),objective=0;
  std::vector<double> x,dual,rc;
};

bool finite(const std::vector<double>& x){return std::all_of(x.begin(),x.end(),[](double v){return std::isfinite(v);});}
std::string fingerprint(const State& s){
  uint64_t a=1469598103934665603ULL,b=1099511628211ULL;
  auto mix=[&](uint64_t v){a=p7dFnvMix(a,v);b=p7dFnvMix(b,v^0x9e3779b97f4a7c15ULL);};
  mix(static_cast<uint64_t>(s.cp));
  for(const auto* v:{&s.x,&s.dual,&s.rc}){mix(v->size());for(double x:*v)mix(std::bit_cast<uint64_t>(x));}
  std::ostringstream out;out<<std::hex<<a<<':'<<b;return out.str();
}
bool same(const State& a,const State& b){return a.cp==b.cp&&a.x==b.x&&a.dual==b.dual&&a.rc==b.rc;}
State partialState(const MIPModel& model,const PartialSolution& p,
    const std::vector<std::shared_ptr<const LpSolution>>& lps){
  State s;s.id=p.solution_id;s.parent=p.parent_solution_id;s.inserted=p.timestamp;s.depth=p.repair_depth;
  s.producer=p.source;s.objective=p.objective;
  s.kind=p.source.find("GPU_TABU")!=std::string::npos?"GPU_TABU_PARTIAL":
      p.source.find("FEASPUMP")!=std::string::npos?"FP_PARTIAL":"FPR_PARTIAL";
  const LpSolution* guide=nullptr;
  for(const auto& lp:lps)if(lp->solution_id==p.root_lp_id)guide=lp.get();
  if(!guide)for(const auto& lp:lps)if(lp->timestamp<=p.timestamp && (!guide||lp->timestamp>guide->timestamp))guide=lp.get();
  s.cp=guide?guide->checkpoint:-static_cast<int64_t>(p.solution_id);
  s.route="LP_CP"+std::to_string(s.cp)+"->"+candidateStage(p.source);
  const size_t n=static_cast<size_t>(model.n_cols),m=static_cast<size_t>(model.n_rows);
  if(!p.values||p.values->size()!=n||!p.assigned||p.assigned->size()!=n||!p.hard_assignment||p.hard_assignment->size()!=n){s.reason="INVALID_DIMENSIONS";return s;}
  for(uint8_t hard:*p.hard_assignment)s.hard+=hard!=0;
  if(s.hard){s.reason="HARD_ASSIGNMENTS_UNSUPPORTED_BY_THIN_ADAPTER";return s;}
  s.x=guide&&guide->primal&&guide->primal->size()==n?*guide->primal:*p.values;
  for(size_t j=0;j<n;++j)if((*p.assigned)[j])s.x[j]=(*p.values)[j];
  s.dual.assign(m,0);s.rc.assign(n,0);
  if(guide){if(guide->dual&&guide->dual->size()==m)s.dual=*guide->dual;
    if(guide->reduced_cost&&guide->reduced_cost->size()==n)s.rc=*guide->reduced_cost;}
  if(!finite(s.x)||!finite(s.dual)||!finite(s.rc)){s.reason="NONFINITE_EFFECTIVE_INPUT";return s;}
  for(int j:model.integer_columns){const double f=std::abs(s.x[j]-std::round(s.x[j]));s.integrality=std::max(s.integrality,f);
    if((*p.assigned)[j]&&f<=kIntegerTolerance)++s.integral_soft;}
  if(s.kind=="FP_PARTIAL"&&s.integral_soft==model.integer_columns.size())s.kind="FP_INTEGER";
  s.eligible=true;s.fingerprint=fingerprint(s);return s;
}
State lpState(const LpSolution& lp){
  State s;s.id=lp.solution_id;s.cp=lp.checkpoint;s.inserted=lp.timestamp;s.producer="ROOT_LP";s.kind="LP_STATE";
  s.route="LP_CP"+std::to_string(lp.checkpoint);s.max_row=lp.max_row_violation;
  if(lp.primal)s.x=*lp.primal;
  if(lp.dual)s.dual=*lp.dual;
  if(lp.reduced_cost)s.rc=*lp.reduced_cost;
  s.fingerprint=fingerprint(s);return s;
}
struct Diversity {size_t common=0,differ=0,inter=0,uni=0;double hamming=0,jaccard=1;};
Diversity diversity(const MIPModel& model,const State& a,const State& b){
  Diversity d;
  for(int j:model.integer_columns){const bool af=std::abs(a.x[j]-std::round(a.x[j]))<=kIntegerTolerance;
    const bool bf=std::abs(b.x[j]-std::round(b.x[j]))<=kIntegerTolerance;
    d.inter+=af&&bf;d.uni+=af||bf;
    if(af&&bf){++d.common;d.differ+=std::round(a.x[j])!=std::round(b.x[j]);}}
  d.hamming=d.common?static_cast<double>(d.differ)/d.common:0;
  d.jaccard=d.uni?static_cast<double>(d.inter)/d.uni:1;return d;
}

bool unitTests(){
  MIPModel model;model.n_cols=2;model.n_rows=1;model.integer_columns={0,1};
  auto lp=std::make_shared<LpSolution>();lp->solution_id=1;lp->checkpoint=100;lp->timestamp=1;
  lp->primal=immutableValues({0.25,1});lp->dual=immutableValues({0});lp->reduced_cost=immutableValues({0,0});
  std::vector<std::shared_ptr<const LpSolution>> lps{lp};
  PartialSolution p;p.solution_id=2;p.root_lp_id=1;p.timestamp=2;p.source="REAL_FPR_PARTIAL";
  p.values=lp->primal;p.assigned=fullAssignmentMask(2);p.hard_assignment=noHardAssignmentMask(2);p.repair_depth=1;
  const State a=partialState(model,p,lps),b=lpState(*lp);
  bool pass=true;int id=0;
  auto check=[&](bool v,const char* name){pass&=v;std::cout<<"D2_UNIT_TEST_"<<++id<<'='<<(v?"PASS":"FAIL")<<" NAME="<<name<<'\n';};
  check(a.eligible,"DEPTH_POLICY_SEPARATE_FROM_ADAPTER_ELIGIBILITY");
  check(same(a,b)&&a.fingerprint==b.fingerprint,"FAILED_FPR_FALLBACK_EQUALS_CONSUMED_DIRECT_INPUT");
  auto q=p;q.values=immutableValues({0,1});auto c=partialState(model,q,lps);
  check(c.eligible&&c.integral_soft==2,"FULLY_INTEGER_SOFT_PARTIAL_IS_LEGAL");
  q.hard_assignment=std::make_shared<const std::vector<uint8_t>>(std::initializer_list<uint8_t>{1,0});
  check(!partialState(model,q,lps).eligible,"HARD_ASSIGNMENT_REJECTED");
  q=p;q.values=immutableValues({0});check(!partialState(model,q,lps).eligible,"DIMENSION_REJECTED");
  q=p;q.values=immutableValues({std::numeric_limits<double>::quiet_NaN(),1});check(!partialState(model,q,lps).eligible,"NONFINITE_REJECTED");
  auto later=a;later.id=99;later.inserted=999;later.producer="DIFFERENT_ROUTE";
  check(fingerprint(later)==a.fingerprint,"NO_ID_TIMESTAMP_OR_ROUTE_ARTIFICIAL_DISTINCTNESS");
  const auto d=diversity(model,a,a);check(d.differ==0&&d.jaccard==1,"DIVERSITY_IDENTITY");
  std::cout<<"D2_SHADOW_UNIT_TESTS="<<(pass?"PASS":"FAIL")<<"\nTEST_IS_ALGORITHMIC_EVIDENCE=NO\n";return pass;
}

void report(const MIPModel& model,const SharedSolutionPool& pool,const ufprd::CompletionWorker& worker,
    const Instrumentation& trace,const RealWorkerMetrics& metrics,const GlobalRuntimeContext& runtime){
  const auto begin=Clock::now();const auto lps=pool.lpEntries();const auto partials=pool.partialEntries();
  const auto feasible=pool.feasibleEntries();const auto tasks=pool.taskAudit();const auto intervals=trace.intervals();
  const auto completions=worker.audits();
  std::vector<State> states;for(const auto& lp:lps)states.push_back(lpState(*lp));
  for(const auto& p:partials)states.push_back(partialState(model,*p,lps));
  for(auto& s:states)if(s.kind=="LP_STATE"){
    s.objective=model.objective_offset;
    for(size_t j=0;j<s.x.size();++j)s.objective+=model.obj[j]*s.x[j];
    for(int j:model.integer_columns){const double f=std::abs(s.x[j]-std::round(s.x[j]));
      s.integrality=std::max(s.integrality,f);s.integral_soft+=f<=kIntegerTolerance;}
  }
  std::sort(states.begin(),states.end(),[](const auto& a,const auto& b){return a.inserted<b.inserted;});
  std::vector<Interval> fpr;double exhausted=0;
  for(const auto& i:intervals)if(i.worker=="FPR_0"){fpr.push_back(i);exhausted=std::max(exhausted,i.end);}
  auto selected=[&](uint64_t id,double t){
    for(const auto& task:tasks){
      if(task.solution_id==id&&task.started<=t&&task.started>=0&&
          (task.kind=="LP_TO_FPR"||task.kind=="PARTIAL_TO_FPR_REPAIR"))return true;
    }
    return false;
  };
  for(auto& s:states){s.consumed=selected(s.id,runtime.global_limit_sec);
    if(s.kind=="GPU_TABU_PARTIAL")for(const auto& g:metrics.gpu_trajectory)if(g.parent_solution_id==s.parent)s.max_row=g.output_eval.max_row_violation;
    if(s.producer=="REAL_FPR_PARTIAL")for(const auto& g:metrics.direct_fpr_audit)if(g.checkpoint==s.cp&&g.has_evaluation)s.max_row=g.evaluation.max_row_violation;
    if(s.producer=="REAL_FPR_REPAIR_PARTIAL")for(const auto& g:metrics.repair_trajectory)if(g.partial_solution_id==s.parent)s.max_row=g.output_eval.max_row_violation;
    if(s.eligible&&!s.consumed)s.reason="FILTERED_BY_POLICY";}
  std::vector<const State*> unique,raw_unconsumed,fresh;
  size_t eligible=0,consumed=0;
  for(const auto& s:states)if(s.eligible&&s.inserted<runtime.global_limit_sec){++eligible;consumed+=s.consumed;
    if(std::none_of(unique.begin(),unique.end(),[&](const auto* u){return same(*u,s);}))unique.push_back(&s);
    if(!s.consumed&&std::none_of(raw_unconsumed.begin(),raw_unconsumed.end(),[&](const auto* u){return same(*u,s);}))raw_unconsumed.push_back(&s);}
  auto stateConsumed=[&](const State& s,double t){for(const auto& other:states)if(other.inserted<=t&&same(s,other)&&selected(other.id,t))return true;return false;};
  for(const auto* s:raw_unconsumed)if(!stateConsumed(*s,runtime.global_limit_sec))fresh.push_back(s);
  size_t high_diversity=0;for(const auto* s:fresh){bool near=false;for(const auto& other:states)if(other.consumed&&other.inserted<=s->inserted){
    const auto d=diversity(model,*s,other);if(d.hamming<=0.01&&d.jaccard>=0.99){near=true;break;}}high_diversity+=!near;}
  auto value=[](const char* name,const auto& v){std::cout<<name<<'='<<v<<'\n';};
  std::cout<<std::setprecision(12)<<"D2_SHADOW_SUMMARY_BEGIN\n";
  value("BUILD_STATUS","PASS");value("EXPERIMENT_NAME","UFPR-D2-CANDIDATE-SUPPLY-SHADOW-PHYSICS1-3");
  value("CASE","Physics-1-3");value("DIAGNOSTIC_ONLY","YES");value("NEW_B_ONLY_BASELINE_RUN","NO");value("NEW_FORMAL_ALGORITHM_RUN","NO");value("NEW_DIAGNOSTIC_RUN","YES");
  value("GENERIC_FPR_ENABLED","YES");value("UFPR_B_ENABLED","YES");value("UFPR_D_ENABLED","YES");value("SEARCH_BEHAVIOR_CHANGED","NO");
  value("REFERENCE_FPR_TASKS",8);value("OBSERVED_FPR_TASKS",fpr.size());value("D2_RUN_VALID",fpr.size()==8?"YES":"NO_TASK_COUNT_CHANGED");
  value("FPR_TASK_CREATION_POLICY","DYNAMIC_POOL_INSERT_ROUTES; LP_BACK; REPAIR_FRONT; ID_PLUS_TASK_KIND_DEDUP");
  value("DIRECT_FPR_TASK_CREATION_POLICY","ONE_PER_INSERTED_LP_OBJECT");
  value("REPAIR_FPR_TASK_CREATION_POLICY","ONE_PER_ROUTED_PARTIAL_OBJECT_IF_DEPTH_LT_1; NOT_ONE_PER_CHECKPOINT");
  value("FPR_TASK_LIST_FIXED","NO");value("FPR_DYNAMIC_SCHEDULING_ENABLED","YES");value("ONE_REPAIR_TASK_PER_CHECKPOINT","NO");value("ONE_REPAIR_TASK_PER_GPU_TABU_OUTPUT","YES");
  value("REPAIR_FPR_ELIGIBILITY_RULES","PARTIAL_TYPE; N_COLS_VALUES_ASSIGNED_HARD_MASK; NO_HARD_ASSIGNMENTS; FINITE_EFFECTIVE_INPUT; PARENT_LP_ELSE_LATEST_ELSE_PARTIAL; ZERO_DUAL_RC_FALLBACK_ALLOWED; FRACTIONAL_OR_FULL_INTEGER_SOFT_GUIDANCE_ALLOWED; DEPTH_AND_ROUTE_ARE_SCHEDULER_POLICY_NOT_ADAPTER_REQUIREMENTS");
  value("DISTINCTNESS_FINGERPRINT","128BIT_FNV_EFFECTIVE_ADAPTER_X_DUAL_RC_CHECKPOINT; EXACT_VECTOR_EQUALITY_VERIFIED; NO_IDS_TIMESTAMPS_PRODUCER_ROUTES");
  value("TOTAL_POOL_CANDIDATES",lps.size()+partials.size()+feasible.size());value("TOTAL_REPAIR_ELIGIBLE",eligible);value("UNIQUE_REPAIR_ELIGIBLE",unique.size());
  value("DUPLICATE_REPAIR_ELIGIBLE",eligible-unique.size());value("DUPLICATE_RATE",eligible?static_cast<double>(eligible-unique.size())/eligible:0);
  value("REPAIR_ELIGIBLE_CONSUMED_BY_FPR",consumed);value("REPAIR_ELIGIBLE_UNCONSUMED",eligible-consumed);
  value("DISTINCT_REPAIR_ELIGIBLE_UNCONSUMED",raw_unconsumed.size());value("FRESH_DISTINCT_ELIGIBLE_NOT_PREVIOUSLY_CONSUMED",fresh.size());
  size_t at=0,newly=0;std::vector<const State*> at_unique,new_unique;
  for(const auto& s:states)if(s.eligible&&!s.consumed&&s.inserted<runtime.global_limit_sec){auto& us=s.inserted<=exhausted?at_unique:new_unique;
    if(s.inserted<=exhausted)++at;else ++newly;
    if(std::none_of(us.begin(),us.end(),[&](const auto* u){return same(*u,s);}))us.push_back(&s);}
  value("ELIGIBLE_UNCONSUMED_AT_FPR_EXHAUSTION",at);value("DISTINCT_ELIGIBLE_UNCONSUMED_AT_FPR_EXHAUSTION",at_unique.size());
  value("NEW_ELIGIBLE_CANDIDATES_AFTER_FPR_EXHAUSTION",newly);value("NEW_DISTINCT_ELIGIBLE_CANDIDATES_AFTER_FPR_EXHAUSTION",new_unique.size());
  std::vector<double> durations;for(const auto& i:fpr)for(const auto& t:tasks)if(t.task_id==i.task_id&&t.kind=="PARTIAL_TO_FPR_REPAIR")durations.push_back(i.end-i.start);
  std::sort(durations.begin(),durations.end());const double median=durations.empty()?0:(durations[(durations.size()-1)/2]+durations[durations.size()/2])/2;
  value("T_FPR_EXHAUSTED",exhausted);value("AVAILABLE_FPR_BUDGET_AFTER_EXHAUSTION_SEC",std::max(0.0,runtime.global_limit_sec-exhausted));
  // Capacity is descriptive and explicitly uses the already-validated D run,
  // not this shadow run as a new performance measurement.
  constexpr double reference_median=(19.274493291+21.575441768)/2;
  value("DIAGNOSTIC_MEDIAN_REPAIR_FPR_DURATION_SEC",median);
  value("MEDIAN_REPAIR_FPR_DURATION_SEC",reference_median);
  value("CAPACITY_DURATION_SOURCE","EXISTING_VALIDATED_UFPR_D_TASK_INTERVALS");
  value("ROUGH_ADDITIONAL_TASK_CAPACITY",std::floor(std::max(0.0,runtime.global_limit_sec-exhausted)/reference_median));
  value("COUNTERFACTUAL_ADDITIONAL_REPAIR_TASKS",raw_unconsumed.size());value("COUNTERFACTUAL_NONREPEATED_ADDITIONAL_REPAIR_TASKS",fresh.size());
  value("COUNTERFACTUAL_HIGH_DIVERSITY_ADDITIONAL_TASKS",high_diversity);
  value("D2_DIAGNOSTIC_DIVERSITY_RULE","NEAR_DUPLICATE_IF_COMMON_INTEGRAL_GUIDANCE_HAMMING_LE_1_PERCENT_AND_INTEGRAL_SET_JACCARD_GE_0.99; DIAGNOSTIC_ONLY_NOT_PRIORITY");
  value("FPR_IDLE_PRIMARY_CAUSE",fresh.empty()?(raw_unconsumed.empty()?"FPR_STARVATION_NO_CANDIDATES":"FPR_STARVATION_ONLY_DUPLICATES"):"FPR_ELIGIBLE_CANDIDATES_EXIST_BUT_NOT_SCHEDULED");
  value("D2_CLASSIFICATION",fresh.empty()&&!raw_unconsumed.empty()?"D2_DUPLICATE_SATURATION":fresh.empty()?"D2_CANDIDATE_STARVATION":"D2_POLICY_BOTTLENECK");
  value("PROPOSE_ACTIVE_D2",fresh.empty()?"NO":"YES_DESIGN_ONLY");value("NEXT_RECOMMENDED_STEP",fresh.empty()?"NO_ACTIVE_D2; STORED_FPR_FALLBACKS_REPEAT_CONSUMED_INPUT; NO_NEW_TASKS":"DESIGN_DISTINCT_OPPORTUNISTIC_REPAIR_QUEUE_ONLY");
  for(const char* producer:{"ROOT_LP","GPU_TABU","FEASPUMP","FPR","OTHER"}){
    size_t total=0,el=0,con=0,repair_con=0;double first=std::numeric_limits<double>::infinity(),last=-1;std::unordered_set<std::string> hashes;
    for(const auto& s:states){const std::string group=s.kind=="LP_STATE"?"ROOT_LP":s.producer.find("GPU_TABU")!=std::string::npos?"GPU_TABU":s.producer.find("FEASPUMP")!=std::string::npos?"FEASPUMP":"FPR";
      if(group!=producer)continue;
      ++total;el+=s.eligible;con+=s.consumed;repair_con+=s.eligible&&s.consumed;hashes.insert(s.fingerprint);first=std::min(first,s.inserted);last=std::max(last,s.inserted);}
    if(std::string(producer)=="OTHER"){total=feasible.size();first=std::numeric_limits<double>::infinity();for(const auto& s:feasible){State f;f.x=*s->values;hashes.insert(fingerprint(f));first=std::min(first,s->timestamp);last=std::max(last,s->timestamp);}}
    std::cout<<"D2_PRODUCER producer="<<producer<<" total="<<total<<" distinct="<<hashes.size()<<" eligible="<<el<<" consumed="<<con<<" eligible_consumed="<<repair_con<<" unconsumed="<<el-repair_con<<" first="<<(total?first:-1)<<" last="<<last<<'\n';
    if(std::string(producer)=="GPU_TABU"){value("GPU_TABU_CANDIDATES_TOTAL",total);value("GPU_TABU_CANDIDATES_DISTINCT",hashes.size());value("GPU_TABU_REPAIR_ELIGIBLE",el);value("GPU_TABU_CONSUMED_BY_REPAIR_FPR",con);value("GPU_TABU_REPAIR_ELIGIBLE_UNCONSUMED",el-con);}}
  size_t fpp=0,fpi=0,fpe=0,fpunc=0;for(const auto& s:states)if(s.producer.find("FEASPUMP")!=std::string::npos){fpp+=s.kind=="FP_PARTIAL";fpi+=s.kind=="FP_INTEGER";fpe+=s.eligible;fpunc+=s.eligible&&!s.consumed;}
  value("FP_PARTIAL_CANDIDATES",fpp);value("FP_INTEGER_CANDIDATES",fpi);value("FP_REPAIR_ELIGIBLE_CANDIDATES",fpe);value("FP_REPAIR_ELIGIBLE_UNCONSUMED",fpunc);
  size_t fp_feasible=0,fp_improvements=0;
  for(const auto& s:feasible)if(s->source.find("FEASPUMP")!=std::string::npos){++fp_feasible;fp_improvements+=s->is_new_incumbent;}
  value("FP_CHECKER_VALID_FEASIBLE",fp_feasible?"NOT_CHECKED_ALL_CANDIDATES":"0");
  value("FP_INCUMBENT_IMPROVEMENTS",fp_improvements);value("FP_PHASE2_USEFUL_CANDIDATE_COUNT",fpe+fp_feasible);
  double fpwall=0;for(const auto& p:metrics.phase_trajectory)if(p.phase=="PHASE2")fpwall+=p.end_time-p.start_time;value("FP_PHASE2_TOTAL_TIME",fpwall);
  for(const auto& s:states)std::cout<<"D2_INSERT id="<<s.id<<" producer="<<s.producer<<" type="<<s.kind<<" cp="<<s.cp<<" parent="<<s.parent<<" route="<<s.route<<" insert="<<s.inserted<<" objective="<<s.objective<<" soft_integral_ints="<<s.integral_soft<<" unfixed_ints="<<model.integer_columns.size()-s.integral_soft<<" hard_fixed="<<s.hard<<" integrality="<<s.integrality<<" max_row="<<s.max_row<<" eligible="<<(s.eligible?"YES":"NO")<<" consumed="<<(s.consumed?"YES":"NO")<<" depth="<<s.depth<<" fingerprint="<<s.fingerprint<<'\n';
  for(const auto& s:feasible)std::cout<<"D2_INSERT id="<<s->solution_id<<" producer=COMPLETION type=COMPLETED_FEASIBLE parent="<<s->repair_parent_id<<" insert="<<s->timestamp<<" objective="<<s->objective<<" eligible=NO reason=ALREADY_VALIDATED_FEASIBLE\n";
  for(const auto& a:completions)if(a.fpr)std::cout<<"D2_INTEGER_QUEUE id="<<a.id<<" type=FPR_INTEGER task="<<a.task<<" cp="<<a.cp<<" parent="<<a.source_candidate<<" insert="<<a.enqueue<<" ready="<<a.ready<<" fixed_ints="<<model.integer_columns.size()<<" eligible=NO reason=ALREADY_SUBMITTED_TO_COMPLETION\n";
  for(const auto& t:tasks)if(t.kind=="LP_TO_FPR"||t.kind=="PARTIAL_TO_FPR_REPAIR")for(const auto& i:fpr)if(i.task_id==t.task_id)
    std::cout<<"D2_CONSUME candidate="<<t.solution_id<<" task="<<t.task_id<<" type="<<t.kind<<" created="<<t.created<<" selected="<<t.started<<" start="<<i.start<<" end="<<i.end<<" cp="<<t.root_checkpoint<<'\n';
  for(const auto* s:raw_unconsumed){const State* nearest=nullptr;Diversity best;double score=std::numeric_limits<double>::infinity();
    for(const auto& other:states)if(other.consumed&&other.inserted<=s->inserted){const auto d=diversity(model,*s,other);const double delta=d.hamming+1-d.jaccard;
      if(delta<score||(delta==score&&same(*s,other))){score=delta;nearest=&other;best=d;}}
    std::cout<<"D2_UNCONSUMED id="<<s->id<<" producer="<<s->producer<<" cp="<<s->cp<<" insert="<<s->inserted<<" eligibility="<<s->inserted<<" soft_integral_ints="<<s->integral_soft<<" unfixed="<<model.integer_columns.size()-s->integral_soft<<" reason="<<s->reason<<" policy=ROUTE_NONE_AND_DEPTH_GE_1 nearest_consumed="<<(nearest?nearest->id:0)<<" exact_repeat="<<(stateConsumed(*s,runtime.global_limit_sec)?"YES":"NO")<<" hamming="<<best.differ<<" common="<<best.common<<" jaccard="<<best.jaccard<<'\n';}
  for(int64_t cp:{100,1000,10000,100000}){size_t total=0,el=0,con=0,gpu=0;std::unordered_set<std::string> hashes,gh;
    for(const auto& s:states)if(s.cp==cp){++total;hashes.insert(s.fingerprint);el+=s.eligible;con+=s.eligible&&s.consumed;if(s.kind=="GPU_TABU_PARTIAL"){++gpu;gh.insert(s.fingerprint);}}
    std::cout<<"D2_CHECKPOINT cp="<<cp<<" candidates="<<total<<" distinct="<<hashes.size()<<" eligible="<<el<<" consumed="<<con<<" unconsumed="<<el-con<<" gpu_produced="<<gpu<<" gpu_distinct="<<gh.size()<<'\n';}
  auto snapshot=[&](double time){size_t total=0,el=0,unc=0,pending=0,running=0,done=0,queue=0;std::unordered_set<std::string> hashes,uh;
    for(const auto& s:states)if(s.inserted<=time){++total;if(s.eligible){++el;hashes.insert(s.fingerprint);if(!selected(s.id,time)){++unc;uh.insert(s.fingerprint);}}}
    for(const auto& s:feasible)total+=s->timestamp<=time;
    for(const auto& t:tasks)if((t.kind=="LP_TO_FPR"||t.kind=="PARTIAL_TO_FPR_REPAIR")&&t.created<=time){if(t.started<0||t.started>time){++pending;continue;}
      if(!std::isfinite(t.started)){++pending;continue;}
      bool ended=false;for(const auto& i:fpr)if(i.task_id==t.task_id&&i.end<=time)ended=true;if(ended)++done;else ++running;}
    for(const auto& a:completions)if(a.enqueue<=time&&(a.dequeue<0||a.dequeue>time))++queue;
    std::cout<<"D2_SLICE time="<<time<<" total_pool="<<total<<" eligible="<<el<<" distinct_eligible="<<hashes.size()<<" unconsumed="<<unc<<" distinct_unconsumed="<<uh.size()<<" pending="<<pending<<" running="<<running<<" completed="<<done<<" completion_queue="<<queue<<'\n';};
  for(double time:{50.,100.,150.,200.,213.069406,250.,300.})snapshot(time);
  snapshot(exhausted);
  size_t pairs=0,min_h=std::numeric_limits<size_t>::max(),max_h=0;double sum_h=0,min_j=1,max_j=0;
  for(size_t a=0;a<unique.size();++a)for(size_t b=a+1;b<unique.size();++b){const auto d=diversity(model,*unique[a],*unique[b]);++pairs;min_h=std::min(min_h,d.differ);max_h=std::max(max_h,d.differ);sum_h+=d.differ;min_j=std::min(min_j,d.jaccard);max_j=std::max(max_j,d.jaccard);}
  std::cout<<"UNIQUE_CANDIDATE_DIVERSITY_SUMMARY pairs="<<pairs<<" hamming_min="<<(pairs?min_h:0)<<" hamming_max="<<max_h<<" hamming_mean="<<(pairs?sum_h/pairs:0)<<" jaccard_min="<<min_j<<" jaccard_max="<<max_j<<'\n';
  for(const auto& s:feasible)if(s->is_new_incumbent){const double delta=std::abs(s->timestamp-78.991499)/78.991499;value("D2_AUDIT_TIMING_PERTURBATION_HIGH",delta>0.10?"YES":"NO");break;}
  value("D2_AUDIT_OVERHEAD_ESTIMATE",std::chrono::duration<double>(Clock::now()-begin).count());
  value("D2_AUDIT_SEARCH_PATH_EXTRA_WORK","NONE; ALL_FINGERPRINTS_DIVERSITY_AND_SLICES_POST_JOIN");
  std::cout<<"D2_SHADOW_SUMMARY_END\n";
}
}
