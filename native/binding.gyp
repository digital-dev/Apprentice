{
  "targets": [
    {
      "target_name": "memory_addon",
      "sources": [
        "src/addon.cc",
        "src/process_utils.cc",
        "src/scanner.cc",
        "src/pointer.cc",
        "src/memory_ops.cc",
        "src/write_watch.cc",
        "src/patch_ops.cc",
        "src/cave_ops.cc",
        "src/module_info.cc",
        "src/mono_call.cc",
        "src/mono_bridge.cc",
        "src/script_ops.cc",
        "src/disasm_ops.cc",
        "third_party/zydis/Zydis.c",
        # The vendored Lua sources are shipped as .cpp (renamed from Lua's
        # own .c) so every compiler builds them as C++ without a
        # target-wide language override. That is load-bearing, not
        # cosmetic: see third_party/lua/apprentice_lua_config.h — Lua
        # errors must unwind as C++ exceptions so destructors in
        # Apprentice's bound functions run. A target-wide /TP would have
        # done the same thing but also drags Zydis.c into C++, which its
        # amalgamated C source does not compile under (implicit int->enum
        # and void*->T* conversions on nearly every line).
        "third_party/lua/lapi.cpp",
        "third_party/lua/lauxlib.cpp",
        "third_party/lua/lbaselib.cpp",
        "third_party/lua/lcode.cpp",
        "third_party/lua/lcorolib.cpp",
        "third_party/lua/lctype.cpp",
        "third_party/lua/ldblib.cpp",
        "third_party/lua/ldebug.cpp",
        "third_party/lua/ldo.cpp",
        "third_party/lua/ldump.cpp",
        "third_party/lua/lfunc.cpp",
        "third_party/lua/lgc.cpp",
        "third_party/lua/linit.cpp",
        "third_party/lua/liolib.cpp",
        "third_party/lua/llex.cpp",
        "third_party/lua/lmathlib.cpp",
        "third_party/lua/lmem.cpp",
        "third_party/lua/loadlib.cpp",
        "third_party/lua/lobject.cpp",
        "third_party/lua/lopcodes.cpp",
        "third_party/lua/loslib.cpp",
        "third_party/lua/lparser.cpp",
        "third_party/lua/lstate.cpp",
        "third_party/lua/lstring.cpp",
        "third_party/lua/lstrlib.cpp",
        "third_party/lua/ltable.cpp",
        "third_party/lua/ltablib.cpp",
        "third_party/lua/ltm.cpp",
        "third_party/lua/lundump.cpp",
        "third_party/lua/lutf8lib.cpp",
        "third_party/lua/lvm.cpp",
        "third_party/lua/lzio.cpp"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/zydis",
        "third_party/lua",
        "src/platform"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "ZYDIS_STATIC_BUILD"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
      },
      "conditions": [
        ["OS=='win'", { "sources": [ "src/platform/platform_win32.cc" ], "libraries": ["-lpsapi.lib", "-lversion.lib"] }],
        ["OS=='linux'", { "sources": [ "src/platform/platform_linux.cc" ], "defines": ["LUA_USE_LINUX"], "libraries": ["-ldl", "-lm"] }]
      ]
    }
  ]
}
