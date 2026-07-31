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
        "third_party/zydis/Zydis.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/zydis",
        "src/platform"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "ZYDIS_STATIC_BUILD"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
      },
      "conditions": [
        ["OS=='win'", { "sources": [ "src/platform/platform_win32.cc" ], "libraries": ["-lpsapi.lib", "-lversion.lib"] }],
        ["OS=='linux'", { "sources": [ "src/platform/platform_linux.cc" ] }]
      ]
    }
  ]
}
