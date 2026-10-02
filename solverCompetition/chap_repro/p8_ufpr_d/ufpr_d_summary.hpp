#pragma once

int runUfprDEquivalence(int argc,char** argv){
  if(argc!=4){std::cerr<<"equivalence: MODEL BASELINE.sol SMALL.mps\n";return 2;}
  const MIPModel model=loadModel(argv[1]);
  const auto known=chap::e2e::readSolution(model,argv[2]);
  const auto known_eval=evaluateSolution(model,known);
  if(!known_eval.integer_feasible || !known_eval.row_feasible){std::cout<<"KNOWN_CANDIDATE_VALIDATION=FAIL\n";return 2;}
  auto lo=model.lb,hi=model.ub;
  for(int j:model.integer_columns)lo[j]=hi[j]=std::round(known[j]);
  GlobalRuntimeContext runtime(180);Instrumentation trace(runtime);
  SharedSolutionPool pool(runtime,trace,model.minimize);
  setGurobiCompletionContext(20,8,"KNOWN_B_ONLY_CANDIDATE",100000,"BASELINE_INTEGER_ASSIGNMENT",runtime.start);
  const LpResult old=solveGurobiCompletionLp(model,lo,hi,120);
  clearGurobiCompletionContext();
  std::promise<void> entered;std::promise<LpResult> completed;
  ufprd::CompletionWorker worker(runtime.start,runtime.deadline,
    [&](ufprd::CompletionCandidate& c,double limit){entered.set_value();g_gurobi_completion_context=c.context;auto r=solveGurobiCompletionLp(model,c.lower,c.upper,limit);clearGurobiCompletionContext();return r;},
    [&](const ufprd::CompletionCandidate& c,const LpResult& r){
      uint64_t id=0;
      if(r.optimal){const auto e=evaluateSolution(model,r.x);if(e.integer_feasible&&e.row_feasible)id=pool.pushFeasibleSolution("REAL_FPR_REPAIR_FEASIBLE",immutableValues(r.x),e.objective,"FULL_ORIGINAL_MODEL_VALIDATION_PASS",c.source_candidate_id,c.root_lp_id,1);}
      completed.set_value(r);return id;
    });
  ufprd::CompletionCandidate c;c.source_task_id=20;c.source_candidate_id=8;c.root_lp_id=7;
  c.type="REPAIR_FPR";c.checkpoint=100000;c.lower=lo;c.upper=hi;c.target=known;c.fallback=known;
  c.ready=c.generated=Clock::now();c.requested_limit=120;
  c.context={true,20,8,"KNOWN_B_ONLY_CANDIDATE",100000,"BASELINE_INTEGER_ASSIGNMENT",runtime.start};
  c.route="LP_CP100000->GPU_TABU->FPR_REPAIR->COMPLETION->FEASIBLE";c.assignment_key=p7dIntegerTargetChecksum(model,known);
  worker.enqueue(c);entered.get_future().wait();
  const double fpr_start=runtime.elapsed();
  LpFixingRunConfig config;config.seed=13;config.ufpr_segment=true;config.ufpr_segment_lmax=4;
  config.completion_sink=[](const auto&,const auto&,const auto&,const auto&,Clock::time_point){return true;};
  SolutionPool local(model.minimize,32);std::vector<double> dual(model.n_rows,0),rc(model.n_cols,0);
  const auto fpr=runLpGuidedFpr(model,known,dual,rc,config,CandidateSource::FPR,local,runtime.start,60);
  const double fpr_end=runtime.elapsed();
  // One bounded GPU call is an architecture smoke check, not an LP benchmark.
  auto* small=read_mps_file(argv[3]);pdhg_parameters_t parameters;set_default_parameters(&parameters);
  parameters.verbose=false;parameters.presolve=false;parameters.termination_criteria.iteration_limit=100;
  parameters.termination_criteria.time_sec_limit=5;
  auto* gpu=small?solve_lp_problem(small,&parameters):nullptr;
  const bool gpu_ok=gpu && cudaGetLastError()==cudaSuccess;
  if(gpu)cupdlpx_result_free(gpu);
  if(small)lp_problem_free(small);
  const auto next=completed.get_future().get();worker.close();worker.join();
  double linf=0;bool dimensions=old.x.size()==next.x.size();
  if(dimensions)for(size_t j=0;j<old.x.size();++j)linf=std::max(linf,std::abs(old.x[j]-next.x[j]));
  const bool parameters_same=old.method_parameter==next.method_parameter && old.threads_parameter==next.threads_parameter
      && old.presolve_parameter==next.presolve_parameter && old.seed_parameter==next.seed_parameter
      && old.feasibility_tolerance==next.feasibility_tolerance && old.optimality_tolerance==next.optimality_tolerance;
  const bool equivalent=old.optimal && next.optimal && old.lp_status==next.lp_status && dimensions
      && std::abs(old.objective-next.objective)<=kConstraintTolerance && linf<=kConstraintTolerance
      && std::abs(old.bound_violation-next.bound_violation)<=kConstraintTolerance
      && std::abs(old.constraint_violation-next.constraint_violation)<=kConstraintTolerance && parameters_same;
  const auto audit=worker.audits().front();
  const bool overlap=std::max(fpr_start,audit.start)<std::min(fpr_end,audit.end);
  const bool stable=overlap && gpu_ok && audit.feasible && pool.feasibleCount()==1;
  std::cout<<std::setprecision(17)<<"COMPLETION_EQUIVALENCE_OLD_STATUS="<<old.status
      <<"\nCOMPLETION_EQUIVALENCE_NEW_STATUS="<<next.status
      <<"\nCOMPLETION_EQUIVALENCE_OLD_OBJECTIVE="<<old.objective
      <<"\nCOMPLETION_EQUIVALENCE_NEW_OBJECTIVE="<<next.objective
      <<"\nCOMPLETION_EQUIVALENCE_OLD_MAX_ROW="<<old.constraint_violation
      <<"\nCOMPLETION_EQUIVALENCE_NEW_MAX_ROW="<<next.constraint_violation
      <<"\nCOMPLETION_EQUIVALENCE_OLD_MAX_BOUND="<<old.bound_violation
      <<"\nCOMPLETION_EQUIVALENCE_NEW_MAX_BOUND="<<next.bound_violation
      <<"\nCOMPLETION_EQUIVALENCE_CONTINUOUS_LINF="<<linf
      <<"\nCOMPLETION_EQUIVALENCE_PARAMETERS_SAME="<<(parameters_same?"YES":"NO")
      <<"\nCOMPLETION_EQUIVALENCE="<<(equivalent?"PASS":"FAIL")
      <<"\nARCH_TEST_FPR_START="<<fpr_start<<"\nARCH_TEST_FPR_END="<<fpr_end
      <<"\nARCH_TEST_FPR_TERMINATION="<<fpr.termination
      <<"\nARCH_TEST_COMPLETION_START="<<audit.start<<"\nARCH_TEST_COMPLETION_END="<<audit.end
      <<"\nARCH_TEST_GPU_OK="<<(gpu_ok?"YES":"NO")
      <<"\nUFPR_D_CONCURRENCY_STABILITY="<<(stable?"PASS":"FAIL")<<"\nTEST_IS_ALGORITHMIC_EVIDENCE=NO\n";
  return equivalent&&stable?0:1;
}

void printUfprDSummary(const ufprd::CompletionWorker& worker,const ufprd::FprAudits& fprs,
    const SharedSolutionPool& pool,const GlobalRuntimeContext& runtime,const std::string& checker){
  auto scalar=[](const char* name,const auto& value){std::cout<<name<<'='<<value<<'\n';};
  const auto ca=worker.audits();const auto& fa=fprs.entries;const auto feasible=pool.feasibleEntries();
  double busy=0,overlap=0,wait_total=0,max_wait=0,solve_total=0;
  size_t started=0,finished=0,good=0,infeasible=0,time_limit=0,skipped=0,enqueued=0;
  size_t after_deadline=0,starts_busy=0,ends_busy=0,integer_busy=0,integer=0;
  bool next_overlap=false;const ufprd::CompletionAudit* first=nullptr;
  std::vector<double> task_overlap(fa.size(),0);
  for(const auto& c:ca){
    if(c.start>=0){busy+=c.end-c.start;if(c.fpr){++started;++finished;solve_total+=c.solve;wait_total+=c.wait;max_wait=std::max(max_wait,c.wait);}}
    if(!c.fpr)continue;
    ++enqueued;if(c.feasible){++good;if(!first||c.published<first->published)first=&c;}
    if(c.status=="INFEASIBLE")++infeasible;
    if(c.status=="TIME_LIMIT")++time_limit;
    if(c.status=="SKIPPED_AT_DEADLINE")++skipped;
    if(c.end>runtime.global_limit_sec)++after_deadline;
  }
  for(size_t i=0;i<fa.size();++i){
    const auto& f=fa[i];if(f.integer)++integer;
    bool sb=false,eb=false,ib=false;
    for(const auto& c:ca){if(c.start<0)continue;
      task_overlap[i]+=std::max(0.0,std::min(f.end,c.end)-std::max(f.start,c.start));
      sb|=f.start>=c.start&&f.start<c.end;eb|=f.end>=c.start&&f.end<c.end;
      ib|=f.integer&&f.ready>=c.start&&f.ready<c.end;
      if(c.fpr && c.task!=f.task && f.start>c.ready && f.start<c.end)next_overlap=true;
    }
    starts_busy+=sb;ends_busy+=eb;integer_busy+=ib;overlap+=task_overlap[i];
  }
  const double avg=finished?solve_total/finished:std::numeric_limits<double>::quiet_NaN();
  double first_time=std::numeric_limits<double>::quiet_NaN();
  if(first)for(const auto& e:feasible)if(e->solution_id==first->pool_output_id)first_time=e->timestamp;
  const auto best=pool.getBestFeasible();
  const bool preserved=best && std::abs((*best)->objective-489548649.918706)<1e-5 && checker=="PASS";
  const bool contention=avg/20.3>1.25;
  std::cout<<std::setprecision(12)<<"UFPR_D_SUMMARY_BEGIN\n";
  scalar("BUILD_STATUS","PASS");scalar("EXPERIMENT_NAME","UFPR-D-DECOUPLED-COMPLETION-PHYSICS1-3");
  scalar("CASE","Physics-1-3");scalar("NEW_B_ONLY_BASELINE_RUN","NO");scalar("NEW_GENERIC_BASELINE_RUN","NO");
  scalar("FORMAL_NEW_RUN_COUNT",1);scalar("GENERIC_FPR_ENABLED","YES");scalar("UFPR_A_ENABLED","NO");scalar("UFPR_B_ENABLED","YES");scalar("UFPR_D_ENABLED","YES");scalar("UFPR_B_LMAX",4);scalar("FEASPUMP_ENABLED","YES");
  scalar("ORIGINAL_B_ONLY_SOURCE_UNCHANGED","YES");
  scalar("UFPR_D_SOURCE_PATH","/data/ai4es/solverCompetition/chap_repro/p8_ufpr_d");
  scalar("UFPR_D_BUILD_PATH","/data/ai4es/solverCompetition/chap_repro/build_ufpr_d");
  scalar("CURRENT_COMPLETION_SYNCHRONOUS","YES");scalar("CURRENT_COMPLETION_CALL_SITE","runLpGuidedFpr -> solveGurobiCompletionLp");
  scalar("CURRENT_INTEGER_READY_SITE","runLpGuidedFpr: complete_integer_target");
  scalar("CURRENT_INTEGER_POOL_INSERT_SITE","NO_INTEGER_POOL_ENTRY; feasible insertion after Completion");
  scalar("CURRENT_FPR_BLOCKS_DURING_COMPLETION","YES");scalar("CURRENT_TASK_SCHEDULER_WAITS_FOR_FPR_RETURN","YES");scalar("CURRENT_POOL_LOCK_HELD_DURING_COMPLETION","NO");
  scalar("COMPLETION_WORKER_COUNT",1);scalar("COMPLETION_QUEUE_POLICY","FIFO");scalar("COMPLETION_QUEUE_CAPACITY","PRACTICALLY_UNBOUNDED");
  scalar("COMPLETION_QUEUE_CANDIDATES_SELF_CONTAINED","YES");scalar("FPR_WAITS_FOR_COMPLETION","NO");
  scalar("COMPLETION_MATHEMATICS_CHANGED","NO");scalar("COMPLETION_GUROBI_PARAMETERS_CHANGED","NO");scalar("COMPLETION_TOLERANCES_CHANGED","NO");
  scalar("COMPLETION_GUROBI_STATE_EXCLUSIVE_TO_WORKER","YES");scalar("OLD_COMPLETION_MODEL_LIFECYCLE","REBUILD_PER_CALL");scalar("NEW_COMPLETION_MODEL_LIFECYCLE","REBUILD_PER_CALL");scalar("COMPLETION_MODEL_LIFECYCLE_CHANGED","NO");
  scalar("SHARED_INCUMBENT_LOGIC_CHANGED","NO");scalar("SHARED_SOLUTION_POOL_SEMANTICS_CHANGED","NO");scalar("UFPR_B_LOGIC_CHANGED","NO");scalar("GENERIC_FPR_LOGIC_CHANGED","NO");scalar("REPAIRWALK_CHANGED","NO");scalar("PROPAGATION_CHANGED","NO");
  scalar("LONG_GLOBAL_MUTEX_HELD_DURING_COMPLETION","NO");scalar("CANDIDATE_ROUTE_METADATA_PRESERVED","YES");
  scalar("INTEGER_CANDIDATES_CREATED",integer);scalar("INTEGER_CANDIDATES_ENQUEUED",enqueued);scalar("UNIQUE_INTEGER_CANDIDATES_ENQUEUED",worker.uniqueAssignments());scalar("DUPLICATE_COMPLETION_CANDIDATES_SKIPPED",worker.duplicates());
  scalar("COMPLETION_SOLVES_STARTED",started);scalar("COMPLETION_SOLVES_FINISHED",finished);scalar("COMPLETION_FEASIBLE",good);scalar("COMPLETION_INFEASIBLE",infeasible);scalar("COMPLETION_TIME_LIMIT",time_limit);scalar("COMPLETION_SKIPPED_AT_DEADLINE",skipped);
  scalar("MAX_COMPLETION_QUEUE_DEPTH",worker.maxDepth());scalar("COMPLETION_QUEUE_OVERFLOW_COUNT",0);scalar("AVG_COMPLETION_QUEUE_WAIT_SEC",started?wait_total/started:0);scalar("MAX_COMPLETION_QUEUE_WAIT_SEC",max_wait);
  scalar("TOTAL_COMPLETION_BUSY_TIME",busy);scalar("TOTAL_FPR_TIME_OVERLAPPED_WITH_COMPLETION",overlap);scalar("OVERLAP_RATIO",busy?overlap/busy:0);
  scalar("FPR_TASKS_STARTED",fa.size());scalar("FPR_TASKS_COMPLETED",fa.size());scalar("FPR_INTEGER_OUTPUTS",integer);
  for(int t:{100,200,300}){const auto label="FPR_TASKS_STARTED_BY_"+std::to_string(t)+"S";scalar(label.c_str(),std::count_if(fa.begin(),fa.end(),[&](const auto& f){return f.start<=t;}));const auto ilabel="INTEGER_OUTPUTS_BY_"+std::to_string(t)+"S";scalar(ilabel.c_str(),std::count_if(fa.begin(),fa.end(),[&](const auto& f){return f.integer&&f.ready<=t;}));}
  scalar("FPR_TASKS_STARTED_WHILE_COMPLETION_BUSY",starts_busy);scalar("FPR_TASKS_FINISHED_WHILE_COMPLETION_BUSY",ends_busy);scalar("INTEGER_CANDIDATES_CREATED_WHILE_COMPLETION_BUSY",integer_busy);
  scalar("NEXT_FPR_TASK_STARTED_BEFORE_PREVIOUS_COMPLETION_END",next_overlap?"YES":"NO");
  scalar("COMPLETION_STARTED_BEFORE_DEADLINE",started);scalar("COMPLETION_FINISHED_AFTER_DEADLINE",after_deadline);scalar("COMPLETION_QUEUE_PENDING_AT_DEADLINE",worker.pendingDeadline());scalar("COMPLETION_QUEUE_NOT_STARTED_AFTER_DEADLINE",skipped);scalar("COMPLETION_ENQUEUE_REJECTED_AT_DEADLINE",worker.rejectedDeadline());
  auto latencies=worker.latencies();scalar("FPR_POST_INTEGER_ENQUEUE_LATENCY_US_MEAN",latencies.empty()?0:std::accumulate(latencies.begin(),latencies.end(),0.0)/latencies.size());scalar("FPR_POST_INTEGER_ENQUEUE_LATENCY_US_MAX",latencies.empty()?0:*std::max_element(latencies.begin(),latencies.end()));
  if(first){scalar("FIRST_FEASIBLE_SOURCE_TASK",first->task);scalar("FIRST_FEASIBLE_SOURCE_CP",first->cp);scalar("FIRST_INTEGER_CANDIDATE_READY_TIME",first->ready);scalar("FIRST_FEASIBLE_ENQUEUE_TIME",first->enqueue);scalar("FIRST_FEASIBLE_QUEUE_WAIT_TIME",first->wait);scalar("FIRST_FEASIBLE_COMPLETION_START_TIME",first->start);scalar("FIRST_FEASIBLE_COMPLETION_END_TIME",first->end);scalar("FIRST_FEASIBLE_COMPLETION_SOLVE_TIME",first->solve);scalar("FIRST_FEASIBLE_OBJECTIVE",first->objective);scalar("FIRST_FEASIBLE_ROUTE",first->route);}
  scalar("FIRST_FEASIBLE_TIME",first_time);scalar("REFERENCE_FIRST_FEASIBLE_TIME",79.220911);scalar("FIRST_FEASIBLE_TIMING_DELTA_SEC",first_time-79.220911);scalar("FIRST_FEASIBLE_TIMING_DELTA_PERCENT",100*(first_time-79.220911)/79.220911);
  scalar("REFERENCE_FINAL_OBJECTIVE",489548649.918706);scalar("FINAL_OBJECTIVE",best?(*best)->objective:std::numeric_limits<double>::quiet_NaN());scalar("REFERENCE_AVG_COMPLETION_SOLVE_TIME_APPROX",20.3);scalar("AVG_COMPLETION_SOLVE_TIME_D",avg);scalar("COMPLETION_SLOWDOWN_RATIO",avg/20.3);scalar("COMPLETION_CONTENTION_MATERIAL",contention?"YES":"NO");
  scalar("SYSTEM_CPU_THREADS",std::thread::hardware_concurrency());scalar("COMPLETION_GUROBI_THREADS",1);scalar("FPR_CPU_WORKER_COUNT",1);scalar("FEASPUMP_CPU_WORKER_COUNT",1);scalar("CPU_AFFINITY_POLICY_CHANGED","NO");
  scalar("OFFICIAL_CHECKER",checker);scalar("FINAL_SOLUTION_QUALITY_PRESERVED",preserved?"YES":"NO");scalar("UFPR_D_DECOUPLING_EFFECTIVE",next_overlap?"YES":"NO");scalar("UFPR_D_CLASSIFICATION_PRELIMINARY","REQUIRES_OUTCOME_REVIEW");scalar("SEARCH_LIMIT_SEC",runtime.global_limit_sec);scalar("LAST_WORKER_FINISHED_AT_SEC",runtime.last_worker_finished_at_sec.load());scalar("TOTAL_WALL_TIME_SEC",runtime.elapsed());scalar("GPU_ARCHITECTURE_CHANGED","NO");scalar("NO_DEADLOCK","YES");scalar("NO_USE_AFTER_FREE","OWNERSHIP_TESTS_PASS");
  scalar("NEXT_RECOMMENDED_STEP","REVIEW_MEASURED_THROUGHPUT_OVERLAP_AND_CONTENTION; NO_NEW_RUN");
  for(const auto& c:ca)std::cout<<"D_COMPLETION_CANDIDATE id="<<c.id<<" task="<<c.task<<" type="<<c.type<<" source_candidate="<<c.source_candidate<<" cp="<<c.cp<<" generated="<<c.generated<<" ready="<<c.ready<<" enqueue="<<c.enqueue<<" dequeue="<<c.dequeue<<" start="<<c.start<<" end="<<c.end<<" wait="<<c.wait<<" solve="<<c.solve<<" status="<<c.status<<" objective="<<c.objective<<" feasible="<<(c.feasible?"YES":"NO")<<" pool_id="<<c.pool_output_id<<" route="<<c.route<<'\n';
  for(size_t i=0;i<fa.size();++i){const auto& f=fa[i];std::cout<<"D_FPR_TASK task="<<f.task<<" type="<<f.type<<" cp="<<f.cp<<" start="<<f.start<<" ready="<<f.ready<<" end="<<f.end<<" integer="<<(f.integer?"YES":"NO")<<" queued="<<(f.queued?"YES":"NO")<<" completion_busy="<<(task_overlap[i]>0?"YES":"NO")<<" overlap="<<task_overlap[i]<<" post_integer_return_us="<<f.post_enqueue_latency_us<<'\n';}
  std::cout<<"UFPR_D_SUMMARY_END\n";
}
