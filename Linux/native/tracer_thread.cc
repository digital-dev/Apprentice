#include "tracer_thread.h"

#include <pthread.h>

#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <thread>
#include <utility>
#include <vector>

namespace linuxptrace {
namespace {

struct Job {
  const std::function<void()>* fn;
  bool done = false;
};

enum class State { Idle, Running, Stopped };

struct Tracer {
  std::mutex m;
  std::condition_variable work;  // queue non-empty, or stopping
  std::condition_variable done;  // some job finished
  std::deque<Job*> queue;
  std::vector<std::function<void()>> exitHooks;
  std::thread thread;
  State state = State::Idle;
  bool (*idleTick)() = nullptr;
};

// Never destroyed: callers can still arrive (and be refused) after ShutdownTracer
// has run at exit, and a joinable std::thread must never be destructed.
Tracer& T() {
  static Tracer* t = new Tracer;
  return *t;
}

thread_local bool tl_isTracer = false;

void RunSafely(const std::function<void()>& fn) {
  try {
    fn();
  } catch (...) {
    // Exceptions never cross to the caller's thread.
  }
}

// Pops and runs queued jobs until the queue is empty. Called with `lk` held.
void Drain(std::unique_lock<std::mutex>& lk) {
  Tracer& t = T();
  while (!t.queue.empty()) {
    Job* job = t.queue.front();
    t.queue.pop_front();
    lk.unlock();
    RunSafely(*job->fn);
    lk.lock();
    job->done = true;
    t.done.notify_all();
  }
}

void Loop() {
  tl_isTracer = true;
  Tracer& t = T();
  std::unique_lock<std::mutex> lk(t.m);
  bool ticking = false;
  auto ready = [&] { return !t.queue.empty() || t.state == State::Stopped; };
  for (;;) {
    if (ticking) t.work.wait_for(lk, std::chrono::milliseconds(kIdleTickMs), ready);
    else t.work.wait(lk, ready);
    Drain(lk);
    if (t.state == State::Stopped) break;
    bool (*tick)() = t.idleTick;
    ticking = false;
    if (tick) {
      lk.unlock();
      try {
        ticking = tick();
      } catch (...) {
      }
      lk.lock();
    }
  }
  std::vector<std::function<void()>> hooks = std::move(t.exitHooks);
  lk.unlock();
  for (auto& h : hooks) RunSafely(h);
}

// fork(): the child has no tracer thread and does not own the parent's tracees.
void PrepareFork() { T().m.lock(); }
void ParentAfterFork() { T().m.unlock(); }
void ChildAfterFork() {
  Tracer& t = T();
  t.state = State::Stopped;
  t.queue.clear();
  t.exitHooks.clear();
  t.m.unlock();
}

void ShutdownAtExit() { ShutdownTracer(); }

// Starts the thread. Called with the lock held, state Idle.
bool Start() {
  Tracer& t = T();
  try {
    t.thread = std::thread(Loop);
  } catch (...) {
    return false;
  }
  t.state = State::Running;
  pthread_atfork(PrepareFork, ParentAfterFork, ChildAfterFork);
  std::atexit(ShutdownAtExit);
  return true;
}

}  // namespace

bool OnTracerThread() { return tl_isTracer; }

bool RunOnTracer(const std::function<void()>& task) {
  if (tl_isTracer) {
    RunSafely(task);
    return true;
  }
  Tracer& t = T();
  std::unique_lock<std::mutex> lk(t.m);
  if (t.state == State::Stopped) return false;
  if (t.state == State::Idle && !Start()) return false;
  Job job{&task};
  t.queue.push_back(&job);
  t.work.notify_one();
  t.done.wait(lk, [&] { return job.done; });
  return true;
}

void RunPending() {
  if (!tl_isTracer) return;
  std::unique_lock<std::mutex> lk(T().m);
  Drain(lk);
}

void SetIdleTick(bool (*tick)()) {
  if (!tl_isTracer) return;
  std::lock_guard<std::mutex> lk(T().m);
  T().idleTick = tick;
}

void AtTracerExit(std::function<void()> hook) {
  Tracer& t = T();
  std::lock_guard<std::mutex> lk(t.m);
  if (t.state != State::Stopped) t.exitHooks.push_back(std::move(hook));
}

void ShutdownTracer() {
  Tracer& t = T();
  std::unique_lock<std::mutex> lk(t.m);
  State was = t.state;
  t.state = State::Stopped;
  if (was != State::Running) return;
  t.work.notify_all();
  lk.unlock();
  // From the tracer thread itself (a task that ended up calling exit()), it
  // cannot join itself; it finishes its loop and runs the hooks on its own.
  if (tl_isTracer) t.thread.detach();
  else t.thread.join();
}

}  // namespace linuxptrace
