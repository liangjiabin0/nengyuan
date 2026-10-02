#pragma once
#include <future>
#include <functional>

namespace ufprd {
struct CompletionCandidate {
  uint64_t candidate_id=0, source_task_id=0, source_candidate_id=0;
  uint64_t root_lp_id=0, generation=0;
  int64_t checkpoint=-1;
  std::string type, source, route, assignment_key;
  std::vector<double> lower, upper, target, fallback;
  GurobiCompletionContext context;
  Clock::time_point generated{}, ready{}, enqueued{};
  double requested_limit=std::numeric_limits<double>::max();
  std::shared_ptr<std::promise<LpResult>> synchronous_reply;
  std::shared_ptr<const MIPModel> synchronous_model;
};
struct CompletionAudit {
  uint64_t id=0, task=0, source_candidate=0, pool_output_id=0;
  int64_t cp=-1;
  std::string type, route, status;
  double generated=0, ready=0, enqueue=0, dequeue=-1, start=-1, end=-1;
  double published=-1, wait=0, solve=0, objective=std::numeric_limits<double>::quiet_NaN();
  double max_bound=std::numeric_limits<double>::quiet_NaN(), max_row=std::numeric_limits<double>::quiet_NaN();
  bool feasible=false, fpr=true;
};

// Queue locks only protect ownership transfer and small counters. Neither
// solver execution nor publication holds this lock (or a pool/scheduler lock).
class CompletionWorker {
 public:
  using Solve=std::function<LpResult(CompletionCandidate&,double)>;
  using Publish=std::function<uint64_t(const CompletionCandidate&,const LpResult&)>;
  CompletionWorker(Clock::time_point origin, Clock::time_point deadline, Solve solve, Publish publish)
      : origin_(origin), deadline_(deadline), solve_(std::move(solve)), publish_(std::move(publish)),
        worker_([this]{loop();}) {}
  ~CompletionWorker(){ close(); join(); }
  CompletionWorker(const CompletionWorker&)=delete;
  CompletionWorker& operator=(const CompletionWorker&)=delete;
  double elapsed(Clock::time_point p) const{return std::chrono::duration<double>(p-origin_).count();}
  bool enqueue(CompletionCandidate c) {
    std::lock_guard<std::mutex> lock(mutex_);
    const auto now=Clock::now();
    if(closed_ || now>=deadline_ || c.generated>=deadline_ || c.ready>=deadline_) {
      ++rejected_deadline_; replyLimit(c); return false;
    }
    const std::string key=c.type+":"+std::to_string(c.source_task_id)+":"+std::to_string(c.source_candidate_id);
    // The old architecture runs once per task, not once per integer checksum.
    // Do not newly deduplicate identical assignments from different tasks.
    if(!ledger_.insert(key).second && !c.synchronous_reply) {++duplicates_; return false;}
    c.candidate_id=++next_id_;
    c.enqueued=now;
    CompletionAudit a;
    a.id=c.candidate_id; a.task=c.source_task_id; a.source_candidate=c.source_candidate_id;
    a.cp=c.checkpoint; a.type=c.type; a.route=c.route; a.fpr=!c.synchronous_reply;
    a.generated=elapsed(c.generated); a.ready=elapsed(c.ready); a.enqueue=elapsed(now);
    a.status="QUEUED";
    audits_.push_back(a);
    if(a.fpr) {
      ++enqueued_fpr_;
      assignments_.insert(c.assignment_key);
      enqueue_latencies_.push_back(std::chrono::duration<double,std::micro>(now-c.ready).count());
      if(busy_) ++created_busy_;
    }
    queue_.push_back(std::move(c));
    max_depth_=std::max(max_depth_,queue_.size());
    cv_.notify_one(); return true;
  }
  LpResult synchronous(CompletionCandidate c) {
    c.synchronous_reply=std::make_shared<std::promise<LpResult>>();
    auto future=c.synchronous_reply->get_future();
    enqueue(std::move(c));
    return future.get();
  }
  void close() {
    std::lock_guard<std::mutex> lock(mutex_);
    if(!closed_) {pending_deadline_=queue_.size(); closed_=true; skipLocked();}
    cv_.notify_all();
  }
  void join(){if(worker_.joinable())worker_.join();}
  bool busy()const{return busy_.load();}
  std::vector<CompletionAudit> audits()const{std::lock_guard<std::mutex> lock(mutex_);return audits_;}
  size_t maxDepth()const{std::lock_guard<std::mutex> lock(mutex_);return max_depth_;}
  size_t duplicates()const{std::lock_guard<std::mutex> lock(mutex_);return duplicates_;}
  size_t uniqueAssignments()const{std::lock_guard<std::mutex> lock(mutex_);return assignments_.size();}
  size_t pendingDeadline()const{std::lock_guard<std::mutex> lock(mutex_);return pending_deadline_;}
  size_t rejectedDeadline()const{std::lock_guard<std::mutex> lock(mutex_);return rejected_deadline_;}
  size_t createdBusy()const{std::lock_guard<std::mutex> lock(mutex_);return created_busy_;}
  std::vector<double> latencies()const{std::lock_guard<std::mutex> lock(mutex_);return enqueue_latencies_;}
 private:
  static void replyLimit(CompletionCandidate& c) {
    if(c.synchronous_reply){LpResult r;r.lp_status=LpSolveStatus::TIME_LIMIT;r.status="TIME_LIMIT";c.synchronous_reply->set_value(std::move(r));}
  }
  void skipLocked(){
    for(auto& c:queue_){audits_.at(c.candidate_id-1).status="SKIPPED_AT_DEADLINE";replyLimit(c);}
    queue_.clear();
  }
  void loop(){
    for(;;){
      CompletionCandidate c;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        cv_.wait_until(lock,deadline_,[&]{return closed_||!queue_.empty();});
        if(Clock::now()>=deadline_ && !closed_){pending_deadline_=queue_.size();closed_=true;skipLocked();}
        if(closed_)break;
        if(queue_.empty())continue;
        c=std::move(queue_.front());queue_.pop_front();
        auto& a=audits_.at(c.candidate_id-1);
        a.dequeue=elapsed(Clock::now());a.wait=a.dequeue-a.enqueue;
      }
      const auto start=Clock::now();
      if(start>=deadline_){
        std::lock_guard<std::mutex> lock(mutex_);
        audits_.at(c.candidate_id-1).status="SKIPPED_AT_DEADLINE";replyLimit(c);continue;
      }
      const double limit=std::min(c.requested_limit,std::chrono::duration<double>(deadline_-start).count());
      busy_.store(true);
      LpResult r;
      uint64_t output=0;
      auto end=start;
      try{
        r=solve_(c,limit);
        end=Clock::now();busy_.store(false);
        if(!c.synchronous_reply)output=publish_(c,r);
      }catch(const std::exception& e){end=Clock::now();r.lp_status=LpSolveStatus::SOLVER_ERROR;r.status=std::string("WORKER_ERROR:")+e.what();}
      busy_.store(false);
      {
        std::lock_guard<std::mutex> lock(mutex_);
        auto& a=audits_.at(c.candidate_id-1);
        a.start=elapsed(start);a.end=elapsed(end);a.solve=r.elapsed_sec;
        a.status=r.status;a.feasible=output!=0;a.pool_output_id=output;
        a.objective=r.objective;a.max_bound=r.bound_violation;a.max_row=r.constraint_violation;
        if(output)a.published=elapsed(Clock::now());
      }
      if(c.synchronous_reply)c.synchronous_reply->set_value(std::move(r));
    }
  }
  Clock::time_point origin_,deadline_;
  Solve solve_;Publish publish_;
  mutable std::mutex mutex_;std::condition_variable cv_;
  std::deque<CompletionCandidate> queue_;
  std::vector<CompletionAudit> audits_;
  std::unordered_set<std::string> ledger_,assignments_;
  std::vector<double> enqueue_latencies_;
  std::atomic<bool> busy_{false};
  bool closed_=false;
  uint64_t next_id_=0;
  size_t max_depth_=0,duplicates_=0,enqueued_fpr_=0,pending_deadline_=0,rejected_deadline_=0,created_busy_=0;
  std::thread worker_;
};
struct FprAudit {
  uint64_t task=0;std::string type;int64_t cp=-1;
  double start=0,ready=-1,end=0,post_enqueue_latency_us=0;
  bool integer=false,queued=false;
};
struct FprAudits {
  std::mutex mutex;std::vector<FprAudit> entries;
  void add(FprAudit a){std::lock_guard<std::mutex> lock(mutex);entries.push_back(std::move(a));}
};
}
