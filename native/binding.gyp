{
  "targets": [
    {
      "target_name": "memory_addon",
      "sources": ["src/addon.cc", "src/process_utils.cc"],
      "include_dirs": ["<!@(node -p \"require('node-addon-api').include\")"],
      "dependencies": ["<!(node -p \"require('node-addon-api').gyp\")"],
      "libraries": ["-lpsapi.lib"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "msvs_settings": {
        "VCCLCompilerTool": { "ExceptionHandling": 1 }
      }
    }
  ]
}
