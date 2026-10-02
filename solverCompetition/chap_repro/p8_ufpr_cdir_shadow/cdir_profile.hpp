#pragma once

struct CdirSummary {
  int64_t count=0, off=0, on=0, undecided=0, agree=0, disagree=0;
  int64_t ok[2]{}, contradiction[2]{}, backtrack[2]{}, opposite[2]{}, repair[2]{};
  double repair_time[2]{};
  std::array<int64_t,5> zones{}, zone_off{}, zone_on{}, zone_undecided{}, zone_agree{}, zone_disagree{};
  int64_t xi_positive=0, xi_negative=0, psi_positive=0, psi_negative=0;
  int64_t low_positive=0, mid_positive=0;
  std::vector<double> xis, psis;
  int64_t up_sum=0, down_sum=0;
  int up_min=1000000, up_max=0, down_min=1000000, down_max=0;
  void add(const CdirEvent& e) {
    ++count; const size_t z=static_cast<size_t>(e.zone); ++zones[z];
    xis.push_back(e.xi); psis.push_back(e.psi);
    xi_positive+=e.xi>kCdirTransferEps; xi_negative+=e.xi<-kCdirTransferEps;
    psi_positive+=e.psi>kCdirTransferEps; psi_negative+=e.psi<-kCdirTransferEps;
    low_positive+=e.zone==CdirZone::Low && e.xi>kCdirTransferEps;
    mid_positive+=e.zone==CdirZone::Mid && e.psi>kCdirTransferEps;
    up_sum+=e.up_donors; down_sum+=e.down_donors;
    up_min=std::min(up_min,e.up_donors); up_max=std::max(up_max,e.up_donors);
    down_min=std::min(down_min,e.down_donors); down_max=std::max(down_max,e.down_donors);
    if(e.direction<0) {++undecided;++zone_undecided[z];return;}
    if(e.direction==0) {++off;++zone_off[z];} else {++on;++zone_on[z];}
    const int group=e.generic_direction==e.direction ? 0:1;
    if(group==0) {++agree;++zone_agree[z];} else {++disagree;++zone_disagree[z];}
    ok[group]+=e.propagation_ok; contradiction[group]+=e.contradiction;
    backtrack[group]+=e.backtracked; opposite[group]+=e.opposite_tried;
    repair[group]+=e.repairwalk; repair_time[group]+=e.repairwalk_time;
  }
};
double cdirRate(int64_t n,int64_t d) {
  return d>0 ? double(n)/d : std::numeric_limits<double>::quiet_NaN();
}
void printCdirProfile(RealWorkerMetrics& metrics) {
  std::vector<BTaskProfile> tasks;
  {std::lock_guard<std::mutex> lock(metrics.ufpr_profile_mutex);tasks=metrics.ufpr_b_task_profiles;}
  std::sort(tasks.begin(),tasks.end(),[](const auto& a,const auto& b){return a.start_time<b.start_time;});
  CdirSummary total, unique, success, failed, first;
  int64_t generic=0,alpha=0,fractional=0,integral=0,missing=0;
  double time=0,xi_time=0,psi_time=0,class_time=0,max_time=0;
  bool validated=true,reference=true;
  const BTaskProfile* first_task=nullptr;
  for(const auto& task:tasks) if(task.completion_feasible && (!first_task || task.end_time<first_task->end_time))first_task=&task;
  int agreement_group_tasks=0,agreement_group_integer=0,disagreement_group_tasks=0,disagreement_group_integer=0;
  std::cout<<std::setprecision(12)<<"\nCDIR_SHADOW_PROFILE_BEGIN\n";
  for(const auto& task:tasks) {
    const auto& m=task.ufpr.cdir; CdirSummary s;
    generic+=m.generic_decisions;alpha+=m.alpha_decisions;
    fractional+=m.fractional_references;integral+=m.integral_references;missing+=m.missing_references;
    time+=m.total_time;xi_time+=m.xi_time;psi_time+=m.psi_time;class_time+=m.classification_time;max_time=std::max(max_time,m.max_time);
    validated=validated&&m.model_validated; reference=reference&&m.reference_available;
    std::unordered_set<uint64_t> seen;
    for(const auto& e:m.events) {
      s.add(e);total.add(e);
      if(seen.insert(e.fingerprint).second) unique.add(e);
      (task.completion_feasible?success:failed).add(e);
      if(&task==first_task) first.add(e);
    }
    const auto decided=s.agree+s.disagree;
    if(decided>0) {
      if(s.agree>=s.disagree){++agreement_group_tasks;agreement_group_integer+=task.integer_output;}
      else {++disagreement_group_tasks;disagreement_group_integer+=task.integer_output;}
    }
    std::cout<<"CDIR_TASK TASK_ID="<<task.task_id<<" TYPE="<<task.type<<" SOURCE_CP="<<task.source_checkpoint
      <<" REFERENCE_CP="<<task.source_checkpoint<<" REFERENCE_ALPHA_AVAILABLE="<<(m.reference_available?"YES":"NO")
      <<" REFERENCE_P_AVAILABLE="<<(m.reference_available?"YES":"NO")
      <<" TOTAL_GENERIC_BRANCH_EVENTS="<<m.generic_decisions<<" CDIR_APPLICABLE="<<s.count
      <<" CDIR_DECIDED="<<decided<<" CDIR_UNDECIDED="<<s.undecided
      <<" AGREE="<<s.agree<<" DISAGREE="<<s.disagree<<" AGREEMENT_RATE="<<cdirRate(s.agree,decided)
      <<" DISAGREEMENT_RATE="<<cdirRate(s.disagree,decided)
      <<" LOW_ZONE_DECISIONS="<<s.zones[0]<<" MID_ZONE_DECISIONS="<<s.zones[1]<<" NORMAL_ZONE_DECISIONS="<<s.zones[2]
      <<" IMMEDIATE_CONTRADICTIONS="<<s.contradiction[0]+s.contradiction[1]
      <<" BACKTRACK_CALLS="<<task.backtrack_calls<<" REPAIRWALK_CALLS="<<task.repair_calls
      <<" REPAIRWALK_TIME="<<task.repair_time_sec<<" INTEGER_OUTPUT="<<(task.integer_output?"YES":"NO")
      <<" COMPLETION_STATUS="<<task.completion_status<<" TASK_TOTAL_TIME="<<task.task_time
      <<" CDIR_TIME="<<m.total_time<<" GENERIC_DECISION_CHECKSUM="<<m.decision_hash<<'\n';
  }
  const int64_t decided=total.agree+total.disagree;
  const double dominance=cdirRate(std::max(total.off,total.on),decided);
  const double first_time=first_task?first_task->end_time:std::numeric_limits<double>::quiet_NaN();
  const double timing_delta=100*(first_time-93.374474)/93.374474;
  auto scalar=[&](const char* name,auto value){std::cout<<name<<'='<<value<<'\n';};
  scalar("EXPERIMENT_NAME","UFPR-CDIR-SHADOW-GENERIC-PHYSICS1-3");
  scalar("CDIR_MODEL_MAPPING_VALIDATED",validated?"YES":"NO");
  scalar("CDIR_REFERENCE_AVAILABLE",reference?"YES":"NO");
  scalar("SOURCE_LOW_OUTPUT_RHO_P",kCdirRho);
  scalar("EPS_TRANSFER",kCdirTransferEps);
  scalar("CDIR_ALPHA_FRACTIONAL_TOLERANCE",kIntegerTolerance);
  scalar("GENERIC_FPR_ENABLED","YES");scalar("UFPR_A_ENABLED","NO");scalar("UFPR_B_ENABLED","NO");
  scalar("CDIR_SHADOW_ENABLED","YES");scalar("CDIR_ACTIVE_ENABLED","NO");
  scalar("CDIR_SHADOW_ONLY","YES");scalar("CDIR_ACTIVE_BRANCH_REORDERING","NO");
  scalar("CDIR_CAN_PRUNE","NO");scalar("CDIR_CAN_FIX_VARIABLE","NO");scalar("CDIR_CAN_DECLARE_CONTRADICTION","NO");
  scalar("GENERIC_VARIABLE_ORDER_CHANGED","NO");scalar("GENERIC_VALUE_SELECTION_CHANGED","NO");scalar("GENERIC_BRANCH_ORDER_CHANGED","NO");
  scalar("CDIR_STORAGE_INCLUDED","NO");scalar("CDIR_NETWORK_CHECK","OFF");scalar("CDIR_SECTION_CHECK","OFF");
  scalar("CDIR_XI_FORMULA","SUM_OTHER_MAX(0,MAX_LOCAL_FEASIBLE_OUTPUT-P_HAT)-P_HAT_SELECTED");
  scalar("CDIR_PSI_FORMULA","SUM_OTHER_MAX(0,P_HAT-MIN_LOCAL_FEASIBLE_OUTPUT)+P_HAT_SELECTED-PMIN_SELECTED");
  scalar("CDIR_LOCAL_OUTPUT_BOUND","CURRENT_P_DOMAIN+GENERATION+INITIAL_AND_ADJACENT_RAMP_ROWS+LOCALLY_ADMISSIBLE_ALPHA_U_D+STATE_MINUP_MINDOWN_FREEZE_INTERVAL_TESTS");
  scalar("CDIR_REFERENCE_DISPATCH_CLAMPED","NO");
  scalar("CDIR_FINGERPRINT","TASK_LOCAL_COLUMN_ALPHA_DOMAIN_TRAIL_POINTER_BACKTRACK_GENERATION");
  scalar("CDIR_OUTCOME_ATTRIBUTION","ACTUAL_FIRST_BRANCH_LOCAL_PROPAGATION_REPAIR_ROLLBACK_AND_OPPOSITE_TRIAL");
  scalar("GENERIC_INTEGER_DECISIONS_TOTAL",generic);scalar("GENERIC_THERMAL_ALPHA_DECISIONS",alpha);
  scalar("CDIR_FRACTIONAL_REFERENCE_DECISIONS",fractional);scalar("CDIR_INTEGRAL_REFERENCE_DECISIONS",integral);
  scalar("CDIR_MISSING_REFERENCE_DECISIONS",missing);scalar("CDIR_APPLICABLE_DECISIONS",total.count);
  scalar("CDIR_NOT_APPLICABLE_DECISIONS",generic-total.count);scalar("CDIR_DECISIONS_TOTAL",total.count);
  scalar("CDIR_PREFER_OFF",total.off);scalar("CDIR_PREFER_ON",total.on);scalar("CDIR_UNDECIDED",total.undecided);
  scalar("CDIR_DECIDED_RATE",cdirRate(decided,total.count));
  scalar("GENERIC_CDIR_AGREE",total.agree);scalar("GENERIC_CDIR_DISAGREE",total.disagree);
  scalar("GENERIC_CDIR_AGREEMENT_RATE",cdirRate(total.agree,decided));
  scalar("CDIR_EVENT_LEVEL_AGREEMENT_RATE",cdirRate(total.agree,decided));
  scalar("CDIR_UNIQUE_STATES",unique.count);
  scalar("CDIR_UNIQUE_STATE_AGREEMENT_RATE",cdirRate(unique.agree,unique.agree+unique.disagree));
  const std::array<const char*,5> zone_names{"LOW","MID","NORMAL","ZERO","OUTSIDE_OR_NUMERICAL"};
  for(size_t z=0;z<5;++z) std::cout<<"CDIR_ZONE ZONE="<<zone_names[z]<<" COUNT="<<total.zones[z]
    <<" PREFER_OFF="<<total.zone_off[z]<<" PREFER_ON="<<total.zone_on[z]<<" UNDECIDED="<<total.zone_undecided[z]
    <<" AGREE="<<total.zone_agree[z]<<" DISAGREE="<<total.zone_disagree[z]<<'\n';
  for(int g=0;g<2;++g) {
    const int64_t n=g==0?total.agree:total.disagree; const std::string suffix=g==0?"AGREE":"DISAGREE";
    scalar(("FIRST_BRANCH_PROPAGATION_OK_"+suffix).c_str(),total.ok[g]);
    scalar(("FIRST_BRANCH_IMMEDIATE_CONTRADICTION_"+suffix).c_str(),total.contradiction[g]);
    scalar(("BACKTRACK_AFTER_FIRST_BRANCH_"+suffix).c_str(),total.backtrack[g]);
    scalar(("OPPOSITE_BRANCH_LATER_TRIED_"+suffix).c_str(),total.opposite[g]);
    scalar(("REPAIRWALK_EVENT_LATER_"+suffix).c_str(),total.repair[g]);
    scalar(("REPAIRWALK_TIME_"+suffix).c_str(),total.repair_time[g]);
    scalar(("P_IMMEDIATE_CONTRADICTION_GIVEN_"+suffix).c_str(),cdirRate(total.contradiction[g],n));
    scalar(("P_BACKTRACK_GIVEN_"+suffix).c_str(),cdirRate(total.backtrack[g],n));
    scalar(("P_OPPOSITE_BRANCH_GIVEN_"+suffix).c_str(),cdirRate(total.opposite[g],n));
  }
  scalar("SUCCESSFUL_TASK_CDIR_AGREEMENT_RATE",cdirRate(success.agree,success.agree+success.disagree));
  scalar("FAILED_TASK_CDIR_AGREEMENT_RATE",cdirRate(failed.agree,failed.agree+failed.disagree));
  scalar("SUCCESSFUL_TASK_CDIR_DISAGREEMENT_RATE",cdirRate(success.disagree,success.agree+success.disagree));
  scalar("FAILED_TASK_CDIR_DISAGREEMENT_RATE",cdirRate(failed.disagree,failed.agree+failed.disagree));
  scalar("FIRST_FEASIBLE_TASK_ID",first_task?first_task->task_id:0);
  scalar("FIRST_FEASIBLE_TASK_TYPE",first_task?first_task->type:"NONE");
  scalar("FIRST_FEASIBLE_TASK_SOURCE_CP",first_task?first_task->source_checkpoint:-1);
  scalar("FIRST_FEASIBLE_TASK_CDIR_DECIDED",first.agree+first.disagree);
  scalar("FIRST_FEASIBLE_TASK_AGREE",first.agree);scalar("FIRST_FEASIBLE_TASK_DISAGREE",first.disagree);
  scalar("FIRST_FEASIBLE_TASK_CDIR_AGREEMENT_RATE",cdirRate(first.agree,first.agree+first.disagree));
  scalar("HIGH_AGREEMENT_GROUP_RULE","MAJORITY_AGREE_GE_50_PERCENT_DESCRIPTIVE_ONLY");
  scalar("HIGH_AGREEMENT_TASK_COUNT",agreement_group_tasks);scalar("HIGH_AGREEMENT_INTEGER_OUTPUT_COUNT",agreement_group_integer);
  scalar("HIGH_DISAGREEMENT_TASK_COUNT",disagreement_group_tasks);scalar("HIGH_DISAGREEMENT_INTEGER_OUTPUT_COUNT",disagreement_group_integer);
  scalar("P_INTEGER_OUTPUT_GIVEN_HIGH_AGREEMENT",cdirRate(agreement_group_integer,agreement_group_tasks));
  scalar("P_INTEGER_OUTPUT_GIVEN_HIGH_DISAGREEMENT",cdirRate(disagreement_group_integer,disagreement_group_tasks));
  scalar("INTEGER_OUTPUT_CONDITIONAL_STATISTICS","DESCRIPTIVE_ONLY_SMALL_TASK_SAMPLE");
  auto distribution=[&](const char* name,std::vector<double>& v){
    std::sort(v.begin(),v.end());
    for(auto [label,q]:std::vector<std::pair<const char*,double>>{{"MIN",0},{"P01",.01},{"P10",.1},{"P50",.5},{"P90",.9},{"P99",.99},{"MAX",1}}){
      double x=std::numeric_limits<double>::quiet_NaN();
      if(!v.empty()){double index=q*(v.size()-1);size_t l=size_t(index),h=std::min(v.size()-1,l+1);x=v[l]+(v[h]-v[l])*(index-l);}
      scalar((std::string(name)+"_"+label).c_str(),x);
    }
  };
  distribution("XI",total.xis);distribution("PSI",total.psis);
  scalar("XI_POSITIVE_RATE",cdirRate(total.xi_positive,total.count));scalar("XI_NEGATIVE_RATE",cdirRate(total.xi_negative,total.count));
  scalar("PSI_POSITIVE_RATE",cdirRate(total.psi_positive,total.count));scalar("PSI_NEGATIVE_RATE",cdirRate(total.psi_negative,total.count));
  scalar("LOW_ZONE_XI_POSITIVE_RATE",cdirRate(total.low_positive,total.zones[0]));
  scalar("MID_ZONE_PSI_POSITIVE_RATE",cdirRate(total.mid_positive,total.zones[1]));
  scalar("AVG_UPWARD_DONOR_COUNT",cdirRate(total.up_sum,total.count));scalar("MIN_UPWARD_DONOR_COUNT",total.count?total.up_min:0);scalar("MAX_UPWARD_DONOR_COUNT",total.up_max);
  scalar("AVG_DOWNWARD_DONOR_COUNT",cdirRate(total.down_sum,total.count));scalar("MIN_DOWNWARD_DONOR_COUNT",total.count?total.down_min:0);scalar("MAX_DOWNWARD_DONOR_COUNT",total.down_max);
  scalar("CDIR_SINGLE_DIRECTION_DOMINANCE",dominance);scalar("CDIR_DIRECTION_SATURATED",dominance>.99?"YES":"NO");
  scalar("CDIR_TOTAL_TIME_SEC",time);scalar("CDIR_XI_TIME_SEC",xi_time);scalar("CDIR_PSI_TIME_SEC",psi_time);
  scalar("CDIR_TRANSFER_TIMING_SHARED_ENVELOPE_INCLUDED_IN_XI","YES");
  scalar("CDIR_CLASSIFICATION_TIME_SEC",class_time);
  scalar("CDIR_AVG_TIME_PER_APPLICABLE_DECISION_US",1e6*time/std::max<int64_t>(1,total.count));scalar("CDIR_MAX_TIME_PER_DECISION_US",1e6*max_time);
  scalar("REFERENCE_FIRST_FEASIBLE_TIME",93.374474);scalar("SHADOW_FIRST_FEASIBLE_TASK_END_TIME",first_time);
  scalar("FIRST_FEASIBLE_TASK_END_TIMING_DELTA_PERCENT",timing_delta);
  scalar("CDIR_PROFILING_OVERHEAD_TOO_HIGH",timing_delta>10?"YES":"NO");
  scalar("CDIR_CLASSIFICATION_PRELIMINARY",dominance>.99 || decided==0 ? "CDIR_LOW_VALUE":"REQUIRES_OUTCOME_REVIEW");
  scalar("PROPOSE_ACTIVE_CDIR","NO");
  std::cout<<"CDIR_SHADOW_PROFILE_END\n";
}
