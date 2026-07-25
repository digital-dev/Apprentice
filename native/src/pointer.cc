#include "pointer.h"
#include <windows.h>
#include <psapi.h>
#include <vector>
#include <string>
#include <cstdint>
#include <cstring>
#include <optional>
#include <algorithm>

namespace {

uintptr_t ParseHex(const std::string& s) {
  return static_cast<uintptr_t>(strtoull(s.c_str(), nullptr, 16));
}

std::string ToHex(uintptr_t addr) {
  char buf[32];
  snprintf(buf, sizeof(buf), "0x%llx", (unsigned long long)addr);
  return buf;
}

struct PointerEntry {
  uintptr_t address;
  uintptr_t value;
};

struct ModuleRange {
  std::string name;
  uintptr_t base;
  uintptr_t end;
};

// Real games (Unity/Mono in particular) very often keep the static roots
// that lead to gameplay state in a runtime DLL (e.g. mono-2.0-bdwgc.dll,
// UnityPlayer.dll) rather than in the main .exe module. Anchoring only to
// the .exe (as a first version of this function did) means a genuinely
// static, valid chain gets reported as "not found" whenever the real
// anchor lives in a different module. Enumerate every loaded module and
// treat any of them as a valid anchor.
std::vector<ModuleRange> ListModules(HANDLE h) {
  std::vector<ModuleRange> out;
  HMODULE mods[1024];
  DWORD needed;
  if (!EnumProcessModulesEx(h, mods, sizeof(mods), &needed, LIST_MODULES_ALL)) {
    return out;
  }
  DWORD count = needed / sizeof(HMODULE);
  if (count > 1024) count = 1024;

  for (DWORD i = 0; i < count; i++) {
    char nameBuf[MAX_PATH];
    MODULEINFO info{};
    if (GetModuleBaseNameA(h, mods[i], nameBuf, sizeof(nameBuf)) &&
        GetModuleInformation(h, mods[i], &info, sizeof(info))) {
      uintptr_t base = reinterpret_cast<uintptr_t>(mods[i]);
      out.push_back({nameBuf, base, base + info.SizeOfImage});
    }
  }
  return out;
}

// Returns the module containing `addr`, or nullptr if it's not inside any
// loaded module's static range (e.g. it's heap/stack memory).
const ModuleRange* FindContainingModule(const std::vector<ModuleRange>& modules, uintptr_t addr) {
  for (const auto& m : modules) {
    if (addr >= m.base && addr < m.end) return &m;
  }
  return nullptr;
}

std::vector<PointerEntry> CollectPointers(HANDLE h) {
  std::vector<PointerEntry> out;
  MEMORY_BASIC_INFORMATION mbi;
  uintptr_t addr = 0;
  while (VirtualQueryEx(h, (LPCVOID)addr, &mbi, sizeof(mbi)) == sizeof(mbi)) {
    bool readable = (mbi.State == MEM_COMMIT) &&
        (mbi.Protect & (PAGE_READWRITE | PAGE_WRITECOPY | PAGE_EXECUTE_READWRITE)) &&
        !(mbi.Protect & PAGE_GUARD);
    // One bulk read per region instead of one ReadProcessMemory syscall per
    // 8-byte candidate — the latter is hundreds of millions of syscalls
    // against a real game process and makes this look hung (same issue
    // scanFirst had, fixed the same way here).
    if (readable && mbi.RegionSize >= sizeof(uintptr_t)) {
      std::vector<uint8_t> buffer(mbi.RegionSize);
      SIZE_T bytesRead = 0;
      if (ReadProcessMemory(h, mbi.BaseAddress, buffer.data(), mbi.RegionSize, &bytesRead)) {
        uintptr_t base = (uintptr_t)mbi.BaseAddress;
        for (SIZE_T offset = 0; offset + sizeof(uintptr_t) <= bytesRead; offset += sizeof(uintptr_t)) {
          uintptr_t val;
          memcpy(&val, buffer.data() + offset, sizeof(val));
          if (val != 0) out.push_back({base + offset, val});
        }
      }
    }
    uintptr_t next = (uintptr_t)mbi.BaseAddress + mbi.RegionSize;
    if (next <= addr) break; // guard against non-advancing regions
    addr = next;
  }
  return out;
}

struct ChainResult {
  std::string moduleName;
  std::vector<uintptr_t> offsets;
};

// A pointer's value very often lands at the START of the object it points
// to, not at the exact field address being scanned for — e.g. a reference
// to a Health component points at that component's base, and the health
// float sits at componentBase + someFieldOffset. Requiring an exact
// e.value == target match (as an earlier version of this function did)
// misses this — by far the most common — case entirely. Instead, accept
// any pointer whose value is at or slightly before the target, treating
// the (small, bounded) gap as a struct/object field offset. This mirrors
// how tools like Cheat Engine's pointer scan work, and is a strict
// superset of exact matching (gap 0 still matches).
constexpr uintptr_t kMaxFieldOffset = 0x1000;

// Every pointer whose value is exactly `target` sorts to the same spot as
// `target` itself under value-ascending order, so ordering by `.value`
// lets a candidate range [target - kMaxFieldOffset, target] be found with
// binary search instead of a full scan.
bool ByValue(const PointerEntry& a, const PointerEntry& b) { return a.value < b.value; }

// The search explores a real tree (each candidate can itself require
// recursing into further candidates), and with an offset-tolerant match
// the branching factor per level can be large against a real game's
// gigabytes of memory. A node budget bounds total work independent of how
// deep or wide that tree gets, so a genuinely unresolvable chain fails fast
// instead of exhaustively enumerating every path. A separate cap bounds how
// many candidate chains we hold for ranking.
constexpr int kMaxNodesVisited = 200000;
constexpr size_t kMaxCandidateChains = 128;

// CollectChains gathers offset lists which, when resolved via the standard
// "deref all but the last offset" walk from the anchor module's base, land
// exactly on `target`. Each satisfies the interface invariant
// *(moduleBase + offsets[0]) + offsets[1] ... == targetAddress, with the
// final offset added but not dereferenced.
//
// The anchor is not restricted to a single module: any loaded module whose
// static range contains the pointer entry is accepted, since real games
// (Unity/Mono especially) frequently keep static roots in a runtime DLL
// rather than the main .exe.
//
// Base case: a pointer entry `e` whose value sits within kMaxFieldOffset
// bytes at-or-before `target` (fieldOffset = target - e.value), and whose
// own address already sits inside some module M. Reaching target requires
// one dereference of the pointer stored at e.address, then adding
// fieldOffset — encoded as {e.address - M.base, fieldOffset} (the trailing
// fieldOffset is added without a further dereference, landing on target).
//
// Recursive case: entry `e` whose value is within kMaxFieldOffset of target
// but whose address is not itself in any module. Recurse to reach e.address
// from some module base, then append fieldOffset to each inner chain — one
// more dereference at what used to be the inner chain's last step, mirroring
// the base case.
//
// `pointers` must already be sorted by `.value` (see ByValue). Unlike a
// first-match search, this collects EVERY chain (up to the budget/cap)
// rather than returning the first, so the caller can rank them: a chain's
// existence doesn't make it trustworthy — a 5-level path through large
// unaligned offsets is far more likely coincidental than a single-deref
// path off a static base, and only ranking can tell them apart.
void CollectChains(
    const std::vector<ModuleRange>& modules,
    uintptr_t target, int levelsLeft, const std::vector<PointerEntry>& pointers,
    int* nodesVisited, std::vector<ChainResult>& out) {
  if (out.size() >= kMaxCandidateChains) return;
  if (*nodesVisited >= kMaxNodesVisited) return;

  // Candidates are exactly those with value in [target - kMaxFieldOffset,
  // target]; find that contiguous run in the sorted vector via two binary
  // searches instead of scanning every pointer in the process.
  uintptr_t lowValue = (target >= kMaxFieldOffset) ? target - kMaxFieldOffset : 0;
  auto begin = std::lower_bound(pointers.begin(), pointers.end(),
      PointerEntry{0, lowValue}, ByValue);
  auto end = std::upper_bound(pointers.begin(), pointers.end(),
      PointerEntry{0, target}, ByValue);

  for (auto it = begin; it != end; ++it) {
    if (++(*nodesVisited) > kMaxNodesVisited) return;
    if (out.size() >= kMaxCandidateChains) return;

    const PointerEntry& e = *it;
    uintptr_t fieldOffset = target - e.value;

    if (const ModuleRange* m = FindContainingModule(modules, e.address)) {
      out.push_back(ChainResult{m->name, {e.address - m->base, fieldOffset}});
    } else if (levelsLeft > 0) {
      std::vector<ChainResult> inner;
      CollectChains(modules, e.address, levelsLeft - 1, pointers, nodesVisited, inner);
      for (auto& ic : inner) {
        ic.offsets.push_back(fieldOffset);
        out.push_back(std::move(ic));
        if (out.size() >= kMaxCandidateChains) return;
      }
    }
  }
}

// Ranks a chain for likely-realness. Lower is better, compared
// lexicographically: (depth, worst struct-traversal offset, misaligned
// count). offsets[0] is the static pointer's location within its module —
// essentially arbitrary (modules are megabytes), so its magnitude is NOT
// scored; only the dereference offsets (offsets[1..], the actual
// struct/object field traversals) are, since a real object graph uses
// small, aligned field offsets.
struct ChainScore {
  size_t depth;
  uintptr_t worstOffset;
  int misaligned;
};

ChainScore ScoreOf(const std::vector<uintptr_t>& offsets) {
  ChainScore s{offsets.size(), 0, 0};
  for (size_t i = 1; i < offsets.size(); i++) {
    if (offsets[i] > s.worstOffset) s.worstOffset = offsets[i];
    if (offsets[i] % 4 != 0) s.misaligned++;
  }
  return s;
}

bool ScoreBetter(const ChainScore& a, const ChainScore& b) {
  if (a.depth != b.depth) return a.depth < b.depth;
  if (a.worstOffset != b.worstOffset) return a.worstOffset < b.worstOffset;
  return a.misaligned < b.misaligned;
}

// The full modules-collect-sort-search pipeline, kept free of Napi:: types
// so it's safe to run on a background thread. Uses iterative deepening: try
// the shallowest depth first and stop at the first depth that yields any
// chains, so a direct single-deref static path is always preferred over a
// deeper one even before per-depth ranking runs. Re-searching the empty
// shallow depths is cheap, and the shared node budget still caps total work.
std::optional<ChainResult> RunResolvePointerChain(HANDLE h, uintptr_t target, int maxLevels) {
  auto modules = ListModules(h);
  auto pointers = CollectPointers(h);
  std::sort(pointers.begin(), pointers.end(), ByValue);

  int nodesVisited = 0;
  for (int limit = 0; limit <= maxLevels; limit++) {
    std::vector<ChainResult> candidates;
    CollectChains(modules, target, limit, pointers, &nodesVisited, candidates);
    if (!candidates.empty()) {
      const ChainResult* best = &candidates[0];
      ChainScore bestScore = ScoreOf(best->offsets);
      for (size_t i = 1; i < candidates.size(); i++) {
        ChainScore s = ScoreOf(candidates[i].offsets);
        if (ScoreBetter(s, bestScore)) {
          best = &candidates[i];
          bestScore = s;
        }
      }
      return *best;
    }
    if (nodesVisited >= kMaxNodesVisited) break;
  }
  return std::nullopt;
}

// Runs the search on a libuv worker thread instead of the main JS thread.
// Collecting pointers across a real game's entire committed memory, even
// with the sorted/bounded search, is real work — running it synchronously
// on the main thread blocks the whole Electron app for that duration,
// indistinguishable from a hang to the user.
class ResolvePointerChainWorker : public Napi::AsyncWorker {
 public:
  ResolvePointerChainWorker(Napi::Env env, HANDLE handle, uintptr_t target, int maxLevels)
      : Napi::AsyncWorker(env),
        handle_(handle),
        target_(target),
        maxLevels_(maxLevels),
        deferred_(Napi::Promise::Deferred::New(env)) {}

  Napi::Promise GetPromise() { return deferred_.Promise(); }

  void Execute() override { result_ = RunResolvePointerChain(handle_, target_, maxLevels_); }

  void OnOK() override {
    Napi::Env env = Env();
    if (!result_) {
      deferred_.Resolve(env.Null());
      return;
    }
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("moduleName", Napi::String::New(env, result_->moduleName));
    Napi::Array offsets = Napi::Array::New(env, result_->offsets.size());
    for (size_t i = 0; i < result_->offsets.size(); i++) {
      offsets.Set((uint32_t)i, Napi::String::New(env, ToHex(result_->offsets[i])));
    }
    obj.Set("offsets", offsets);
    deferred_.Resolve(obj);
  }

  void OnError(const Napi::Error& e) override { deferred_.Reject(e.Value()); }

 private:
  HANDLE handle_;
  uintptr_t target_;
  int maxLevels_;
  std::optional<ChainResult> result_;
  Napi::Promise::Deferred deferred_;
};

} // namespace

Napi::Value ResolvePointerChain(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  uintptr_t target = ParseHex(info[1].As<Napi::String>().Utf8Value());
  int maxLevels = info[2].As<Napi::Number>().Int32Value();

  auto* worker = new ResolvePointerChainWorker(env, h, target, maxLevels);
  Napi::Promise promise = worker->GetPromise();
  worker->Queue();
  return promise;
}

// Looks up a currently-loaded module's base address by name. Used to
// re-resolve a saved cheat's anchor module every read/write, since a cheat
// can be anchored to any loaded module, not just the one the process
// happened to attach against.
Napi::Value GetModuleBase(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HANDLE h = reinterpret_cast<HANDLE>(
      static_cast<uintptr_t>(info[0].As<Napi::Number>().Int64Value()));
  std::string moduleName = info[1].As<Napi::String>().Utf8Value();

  auto modules = ListModules(h);
  for (const auto& m : modules) {
    if (_stricmp(m.name.c_str(), moduleName.c_str()) == 0) {
      return Napi::String::New(env, ToHex(m.base));
    }
  }
  return env.Null();
}
