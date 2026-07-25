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
        "third_party/zydis/Zydis.c"
      ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "third_party/zydis"
      ],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "libraries": ["-lpsapi.lib"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS", "ZYDIS_STATIC_BUILD"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] }
      }
    }
  ]
}
