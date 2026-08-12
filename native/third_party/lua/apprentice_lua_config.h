/*
** apprentice_lua_config.h — Apprentice's build-time configuration for the
** vendored Lua 5.4.7 source.
**
** Included from the top of `luaconf.h` (right after its include guard
** opens), so EVERY vendored translation unit sees it before any other Lua
** header content, and so does every consumer that includes `lua.h`.
**
** Purpose: force Lua's error unwinding onto C++ exceptions rather than
** longjmp/setjmp. A `lua_error` raised from deep inside one of Apprentice's
** bound C functions must unwind that function's C++ destructors (std::string,
** std::vector, RAII handle wrappers in the memory bindings added in later
** tasks). `longjmp` would skip them, leaking handles and memory on every
** script error.
**
** Mechanism: `ldo.c` defines LUAI_THROW/LUAI_TRY/luai_jmpbuf only inside
** `#if !defined(LUAI_THROW)`, so defining all three here suppresses its
** block entirely and ours is used. This is Lua's own documented override
** hook.
**
** Note that Lua 5.4.7's own default for `__cplusplus && !LUA_USE_LONGJMP` is
** already exactly these definitions; we restate them explicitly so the
** guarantee is a property of Apprentice's build rather than of an upstream
** default that a future point release could change silently. The two
** #error guards below make the requirement fail loudly rather than
** degrade quietly to longjmp.
*/

#ifndef apprentice_lua_config_h
#define apprentice_lua_config_h

#if !defined(__cplusplus)
#error "Apprentice requires the vendored Lua sources to be compiled as C++. \
Lua errors must unwind as C++ exceptions so that destructors in Apprentice's \
bound functions run. That is why every file in this directory carries a .cpp \
extension (renamed from Lua's own .c) — if you are seeing this, a file was \
renamed back to .c, or was added to binding.gyp under its .c name. Rename it \
to .cpp rather than forcing the language target-wide with /TP or -x c++: a \
target-wide override also captures third_party/zydis/Zydis.c, which does not \
compile as C++."
#endif

#if defined(LUA_USE_LONGJMP)
#error "LUA_USE_LONGJMP must not be defined for Apprentice's build: it would \
route lua_error through longjmp and skip C++ destructors."
#endif

#include <exception>

/* C++ exception based unwinding. `c` is a `struct lua_longjmp*`; ldo.c has
** already stored the error code in `c->status` before calling LUAI_THROW,
** and LUAI_TRY must leave a nonzero status behind for any foreign exception
** (status -1) so `luaD_rawrunprotected` reports failure rather than success.
** `luai_jmpbuf` is only the type of the now-unused `b` field of
** `struct lua_longjmp`, so a plain int is the correct placeholder. */
#define LUAI_THROW(L, c)  throw(c)
#define LUAI_TRY(L, c, a) \
  try { a } catch (...) { if ((c)->status == 0) (c)->status = -1; }
#define luai_jmpbuf       int

#endif /* apprentice_lua_config_h */
