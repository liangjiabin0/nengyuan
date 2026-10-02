#pragma once

bool runCdirUnitTests() {
  int passed=0,total=0;
  auto check=[&](bool ok){++total;passed+=ok;std::cout<<"CDIR_UNIT_TEST_"<<total<<'='<<(ok?"PASS":"FAIL")<<'\n';};
  check(cdirZone(0,40,100)==CdirZone::Zero);
  check(cdirZone(10,40,100)==CdirZone::Low);
  check(cdirZone(20,40,100)==CdirZone::Mid);
  check(cdirZone(40,40,100)==CdirZone::Normal);
  check(cdirZone(101,40,100)==CdirZone::Outside);
  check(cdirDirection(CdirZone::Low,1,-1)==0);
  check(cdirDirection(CdirZone::Low,-1,1)==1);
  check(cdirDirection(CdirZone::Mid,-1,1)==1);
  check(cdirDirection(CdirZone::Mid,1,-1)==0);
  check(cdirDirection(CdirZone::Low,0,1)==-1);
  check(cdirDirection(CdirZone::Mid,1,0)==-1);
  check(cdirDirection(CdirZone::Normal,1,1)==-1);
  MIPModel model;
  model.n_cols=8;model.n_rows=0;model.lb.assign(8,0);model.ub.assign(8,1);
  model.ub[0]=model.ub[4]=100;model.row_start={0};model.obj.assign(8,0);
  model.var_type.assign(8,VarType::Binary);model.var_type[0]=model.var_type[4]=VarType::Continuous;
  model.integer_columns={1,2,3,5,6,7};
  ReversibleDomains domains(model);
  CdirCell cell;cell.dispatch=4;cell.alpha=5;cell.startup=6;cell.shutdown=7;
  cell.p=10;cell.pmin=40;cell.pmax=100;
  cell.logic.push_back({0,0,{{5,1},{6,-1},{7,1}}}); // initially OFF
  cell.ramps.push_back({1,0,-1e30,20,{{6,-80}}});
  check(cdirOutputInterval(cell,domains,1,0,0).first>cdirOutputInterval(cell,domains,1,0,0).second);
  const auto started=cdirOutputInterval(cell,domains,1,1,0);
  check(started.first==40 && started.second==100);
  domains.setDomain(6,0,0,1);
  check(cdirDonorCapabilities(cell,domains).first==0);
  domains.backtrack(0);
  domains.setDomain(5,0,0,1);
  check(cdirDonorCapabilities(cell,domains).first==0);
  domains.backtrack(0);
  cell.logic.push_back({-1e30,0,{{6,1}}}); // actual min-up conflict forbids startup
  check(cdirDonorCapabilities(cell,domains).first==0);
  cell.logic.pop_back();
  CdirContext context(model,UcModelMap{},nullptr);
  context.units=2;context.periods=1;context.validated=true;context.reference_available=true;
  context.cells.resize(2);context.cells[1]=cell;
  context.cells[0].alpha=1;context.cells[0].dispatch=0;
  context.cells[0].p=10;context.cells[0].alpha_ref=.25;
  context.cells[0].pmin=40;context.cells[0].pmax=100;
  UcModelMap map;map.col_kind.assign(8,0);map.col_unit.assign(8,-1);map.col_time.assign(8,-1);
  map.col_kind[1]='c';map.col_unit[1]=0;map.col_time[1]=0;
  CdirMetrics metrics;
  const auto lower=domains.lower(),upper=domains.upper(); const auto pointer=domains.trailPointer();
  std::mt19937_64 baseline_rng(13),shadow_rng(13);bool same=true;
  for(int k=0;k<100;++k) {
    const auto b=chap::lpfix::chooseValue(.25,0,1,kIntegerTolerance,baseline_rng);
    const auto s=chap::lpfix::chooseValue(.25,0,1,kIntegerTolerance,shadow_rng);
    const auto before=chap::lpfix::buildBranches(0,1,s.preferred,0,true);
    cdirObserve(context,map,domains,1,int(s.preferred),0,metrics);
    const auto after=chap::lpfix::buildBranches(0,1,s.preferred,0,true);
    same=same&&b.preferred==s.preferred&&b.random_draw==s.random_draw&&before.size()==after.size();
    for(size_t j=0;j<before.size();++j)same=same&&before[j].lower==after[j].lower&&before[j].upper==after[j].upper&&before[j].kind==after[j].kind;
  }
  check(same && baseline_rng==shadow_rng);
  check(lower==domains.lower()&&upper==domains.upper()&&pointer==domains.trailPointer());
  check(metrics.events.size()==100 && metrics.events.front().p_ref==10);
  const size_t count=metrics.events.size();
  context.cells[0].alpha_ref=1;
  cdirObserve(context,map,domains,1,1,0,metrics);
  check(metrics.events.size()==count && metrics.integral_references==1);
  cdirObserve(context,map,domains,2,1,0,metrics);
  check(metrics.events.size()==count && metrics.alpha_decisions==101);
  context.reference_available=false;
  cdirObserve(context,map,domains,1,1,0,metrics);
  check(metrics.events.size()==count && metrics.missing_references==1);
  std::cout<<"CDIR_UNIT_TESTS_PASS="<<(passed==total?"YES":"NO")<<'\n'
    <<"GENERIC_RNG_AND_BRANCH_REGRESSION="<<(same?"PASS":"FAIL")<<'\n'
    <<"CDIR_DOMAIN_MUTATION_DETECTED="<<(lower==domains.lower()&&upper==domains.upper()?"NO":"YES")<<'\n';
  return passed==total;
}

int runCdirDiagnostic(const char* path) {
  const MIPModel model=loadModel(path);const UcModelMap map=buildUcModelMap(model);
  std::cout<<"CDIR_AUDIT_ROWS="<<model.n_rows<<"\nCDIR_AUDIT_COLS="<<model.n_cols
    <<"\nCDIR_AUDIT_INTEGERS="<<model.integer_columns.size()<<"\nTHERMAL_UNITS="<<map.thermal_units
    <<"\nPERIODS="<<map.periods<<"\nCDIR_MODEL_MAPPING_VALIDATED="<<(map.power_transfer_mapping_validated?"YES":"NO")<<'\n';
  if(!map.power_transfer_mapping_validated)return 1;
  // Diagnostic reference only: bounded synthetic fractional primal, NOT an
  // algorithmic experiment or a substitute for formal stored checkpoint data.
  std::vector<double> ref=model.lb;
  for(int i=0;i<map.thermal_units;++i)for(int t=0;t<map.periods;++t){
    ref[map.commitment[i][t]]=.5;
    ref[map.dispatch[i][t]]=map.pmin[i][t]*.25;
  }
  const auto start=Clock::now();CdirContext context(model,map,&ref);
  const double setup=std::chrono::duration<double>(Clock::now()-start).count();
  ReversibleDomains domains(model);CdirMetrics metrics;
  bool activity_equivalent=true;
  for(int k=0;k<64;++k) {
    const auto& fast=context.cells[(k%map.thermal_units)*map.periods+(k*17)%map.periods];
    CdirCell slow=fast;
    for(auto& row:slow.logic) {
      const int r=row.original_row; row.original_row=-1;row.terms.clear();
      for(HighsInt p=model.row_start[r];p<model.row_start[r+1];++p)
        row.terms.push_back({static_cast<int>(model.row_index[p]),model.row_value[p]});
    }
    for(int a=0;a<=1;++a)for(int u=0;u<=1;++u)for(int d=0;d<=1;++d) {
      const auto f=cdirOutputInterval(fast,domains,a,u,d);
      const auto s=cdirOutputInterval(slow,domains,a,u,d);
      activity_equivalent=activity_equivalent && std::abs(f.first-s.first)<1e-8 && std::abs(f.second-s.second)<1e-8;
    }
  }
  for(int k=0;k<256;++k) {
    const int i=k%map.thermal_units,t=(k*17)%map.periods;
    cdirObserve(context,map,domains,map.commitment[i][t],k%2,0,metrics);
  }
  CdirMetrics cache_metrics;bool cache_equivalent=true;int64_t generation=0;
  const auto warm_start=Clock::now();
  for(int k=0;k<32;++k) {
    const size_t pointer=domains.trailPointer();
    const int t=50,j=map.commitment[k+1][t];
    domains.setDomain(j,k%2,k%2,k+1);
    const int index=cdirObserve(context,map,domains,map.commitment[0][t],0,generation,cache_metrics);
    double up=0,down=0;
    for(int i=1;i<map.thermal_units;++i){auto cap=cdirDonorCapabilities(context.cells[i*map.periods+t],domains);up+=cap.first;down+=cap.second;}
    cache_equivalent=cache_equivalent&&index>=0&&std::abs(cache_metrics.events[index].xi-(up-context.cells[t].p))<1e-7
      &&std::abs(cache_metrics.events[index].psi-(down+context.cells[t].p-context.cells[t].pmin))<1e-7;
    if(k%4==3){domains.backtrack(pointer);++generation;}
  }
  (void)warm_start;
  std::cout<<std::setprecision(9)<<"CDIR_DIAGNOSTIC_ONLY=YES\nCDIR_DIAGNOSTIC_REFERENCE=SYNTHETIC_BOUNDED_FOR_OVERHEAD_ONLY\n"
    <<"CDIR_SETUP_TIME_SEC="<<setup<<"\nCDIR_DIAGNOSTIC_DECISIONS="<<metrics.events.size()
    <<"\nCDIR_DIAGNOSTIC_TIME_SEC="<<metrics.total_time
    <<"\nCDIR_DIAGNOSTIC_AVG_US="<<1e6*metrics.total_time/metrics.events.size()<<'\n';
  std::cout<<"CDIR_ACTIVITY_SCALAR_VS_FULL_ROW_REGRESSION="<<(activity_equivalent?"PASS":"FAIL")<<'\n';
  std::cout<<"CDIR_CACHE_FORWARD_AND_ROLLBACK_REGRESSION="<<(cache_equivalent?"PASS":"FAIL")<<'\n'
    <<"CDIR_CACHE_PROBE_AVG_US="<<1e6*cache_metrics.total_time/32<<'\n';
  return activity_equivalent&&cache_equivalent?0:1;
}
