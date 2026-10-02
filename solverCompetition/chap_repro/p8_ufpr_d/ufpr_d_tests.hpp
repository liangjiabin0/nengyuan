#pragma once
#include <set>

bool runUfprDUnitTests(){
  bool all=true;int n=0;
  auto check=[&](bool pass,const char* name){++n;all&=pass;std::cout<<"UFPR_D_UNIT_TEST_"<<n<<"="<<(pass?"PASS":"FAIL")<<" NAME="<<name<<'\n';};
  const auto origin=Clock::now();
  std::promise<void> entered,release;
  auto gate=release.get_future().share();
  std::vector<uint64_t> seen;
  std::vector<std::thread::id> owners;
  std::atomic<int> publications{0},active{0},max_active{0};
  bool owned=true,route=true,ids=true;
  ufprd::CompletionWorker w(origin,origin+5s,
    [&](ufprd::CompletionCandidate& c,double){
      if(seen.empty()){entered.set_value();gate.wait();}
      const int a=++active;max_active.store(std::max(max_active.load(),a));
      owners.push_back(std::this_thread::get_id());seen.push_back(c.source_task_id);
      owned &= c.lower==std::vector<double>{1,2} && c.upper==std::vector<double>{1,3}
          && c.target==std::vector<double>{1,2.5} && c.fallback==std::vector<double>{.4,2.5};
      route &= c.route=="LP_CP100000->GPU_TABU->FPR_REPAIR->COMPLETION->FEASIBLE";
      ids &= c.source_candidate_id==800+c.source_task_id;
      --active;LpResult r;r.status="OPTIMAL";r.optimal=true;r.x=c.target;return r;
    },[&](const auto&,const auto&){++publications;return uint64_t{1};});
  auto make=[&](uint64_t id){ufprd::CompletionCandidate c;c.source_task_id=id;c.source_candidate_id=800+id;
    c.type="REPAIR_FPR";c.checkpoint=100000;c.route="LP_CP100000->GPU_TABU->FPR_REPAIR->COMPLETION->FEASIBLE";
    c.ready=c.generated=Clock::now();c.lower={1,2};c.upper={1,3};c.target={1,2.5};c.fallback={.4,2.5};c.assignment_key="same-assignment";return c;};
  auto candidate=make(1);
  check(w.enqueue(candidate),"ENQUEUE");
  entered.get_future().wait();
  candidate.lower[0]=9;candidate.upper[0]=9;candidate.target[0]=9;candidate.fallback[0]=9;candidate.route="MUTATED";
  check(w.busy(),"QUEUE_WAKEUP");
  w.enqueue(make(2));w.enqueue(make(3));
  check(!w.enqueue(make(2)) && w.duplicates()==1,"DUPLICATE_TASK_SUPPRESSED");
  release.set_value();
  while(publications.load()<3)std::this_thread::yield();
  w.close();w.join();
  check(owned,"DEEP_COPY_OWNERSHIP");
  check(seen==std::vector<uint64_t>{1,2,3},"FIFO");
  check(route,"ROUTE_METADATA");check(ids,"SOURCE_CANDIDATE_ID_PRESERVED");
  check(publications==3,"RESULT_PUBLICATION_CALLBACK");
  check(max_active==1 && std::all_of(owners.begin(),owners.end(),[&](auto id){return id==owners.front();}) && owners.front()!=std::this_thread::get_id(),"EXCLUSIVE_SOLVER_THREAD");
  check(w.maxDepth()==2,"QUEUE_CAPACITY_NO_DROP");
  const auto dstart=Clock::now();std::promise<void> dentered;
  std::atomic<int> dsolves{0},dfinished{0};
  ufprd::CompletionWorker dw(dstart,dstart+40ms,
    [&](auto&,double){++dsolves;dentered.set_value();std::this_thread::sleep_for(80ms);LpResult r;r.status="OPTIMAL";return r;},
    [&](const auto&,const auto&){++dfinished;return uint64_t{1};});
  dw.enqueue(make(10));dentered.get_future().wait();dw.enqueue(make(11));dw.join();
  const auto da=dw.audits();
  check(dsolves==1 && da[1].status=="SKIPPED_AT_DEADLINE","DEADLINE_NO_NEW_SOLVE");
  check(dfinished==1 && da[0].end>0.04,"INFLIGHT_FINISH_AFTER_DEADLINE");
  check(!dw.enqueue(make(12)),"DEADLINE_NO_NEW_ENQUEUE");
  check(dw.pendingDeadline()==1,"PENDING_DEADLINE_ACCOUNTING");
  const auto rstart=Clock::now();std::atomic<int> rdone{0};
  ufprd::CompletionWorker rw(rstart,rstart+5s,
    [&](auto&,double){LpResult r;r.status="OPTIMAL";return r;},[&](const auto&,const auto&){++rdone;return uint64_t{1};});
  std::vector<std::thread> senders;
  for(int i=0;i<4;++i)senders.emplace_back([&,i]{for(int j=0;j<20;++j)rw.enqueue(make(100+i*20+j));});
  for(auto& t:senders)t.join();
  while(rdone<80)std::this_thread::yield();
  rw.close();rw.join();
  std::set<uint64_t> unique_ids;for(const auto& a:rw.audits())unique_ids.insert(a.id);
  check(unique_ids.size()==80 && rw.audits().size()==80,"CONCURRENT_ID_ALLOCATION");
  check(rw.uniqueAssignments()==1 && rdone==80,"PRESERVE_PER_TASK_NOT_ASSIGNMENT_DEDUP");
  const auto istart=Clock::now();ufprd::CompletionWorker idle(istart,istart+2s,[](auto&,double){return LpResult{};},[](const auto&,const auto&){return uint64_t{0};});
  idle.close();idle.join();check(idle.audits().empty(),"CLEAN_IDLE_SHUTDOWN");
  const char* path=std::getenv("P8_UFPR_D_SMALL_MODEL");
  bool returned=false;
  if(path){
    MIPModel m=loadModel(path);SolutionPool local(m.minimize,32);
    std::vector<double> x(m.n_cols,0),y(m.n_rows,0),rc(m.n_cols,0);
    for(int j=0;j<m.n_cols;++j)x[j]=finiteLower(m.lb[j])?m.lb[j]:0;
    LpFixingRunConfig config;config.seed=13;
    std::promise<void> fpentered,fprelease;auto fpgate=fprelease.get_future().share();std::atomic<int> fpdone{0};
    const auto fpstart=Clock::now();
    ufprd::CompletionWorker fw(fpstart,fpstart+5s,[&](auto&,double){fpentered.set_value();fpgate.wait();LpResult r;r.status="OPTIMAL";return r;},[&](const auto&,const auto&){++fpdone;return uint64_t{1};});
    config.completion_sink=[&](const auto& lo,const auto& hi,const auto& target,const auto& fallback,Clock::time_point ready){auto c=make(500);c.lower=lo;c.upper=hi;c.target=target;c.fallback=fallback;c.ready=c.generated=ready;return fw.enqueue(std::move(c));};
    const auto result=runLpGuidedFpr(m,x,y,rc,config,CandidateSource::FPR,local,fpstart,5.0);
    returned=result.complete_integer_target && result.termination=="INTEGER_ENQUEUED" && result.final_lp_calls==0 && fpdone==0;
    fprelease.set_value();fw.close();fw.join();
  }
  check(returned,"ACTUAL_FPR_RETURNS_WITHOUT_COMPLETION_WAIT");
  std::cout<<"UFPR_D_UNIT_TESTS="<<(all?"PASS":"FAIL")<<'\n';return all;
}
