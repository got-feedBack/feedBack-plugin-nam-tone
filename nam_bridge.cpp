// nam_bridge.cpp — C ABI wrapper around NeuralAmpModelerCore for the browser
// WASM build. Compiled to wasm/nam-core.{js,wasm} via Emscripten (see the
// "WASM Build" section of README.md). The exported symbols below are the exact
// contract consumed by worklet/nam-processor.js:
//   _nam_create / _nam_set_sample_rate / _nam_load_model /
//   _nam_process / _nam_is_loaded / _nam_destroy
//
// The build defines NAM_SAMPLE_FLOAT, so NAM_SAMPLE is float and the audio
// buffers exchanged with the worklet (via HEAPF32) are float, mono in / mono out.
//
// This file is intentionally committed: a previous iteration of this wrapper was
// lost (only the build command in the README survived), which made rebuilding the
// WASM — e.g. to add A2 architecture support — far harder than it needed to be.

#include <cstring>
#include <exception>
#include <memory>
#include <string>

#include <emscripten/emscripten.h>

#include "dsp.h"      // nam::DSP            (-I NAM)
#include "get_dsp.h"  // nam::get_dsp(...)   (-I NAM)
#include "json.hpp"   // nlohmann::json      (-I Dependencies/nlohmann)

namespace {

struct NamContext
{
  std::unique_ptr<nam::DSP> model;
  // The AudioContext sample rate, supplied by the worklet before load. NAM's
  // Reset() uses this to set up internal resampling when a model's expected
  // rate differs from the host rate. Default to the common 48 kHz so a missing
  // set-rate call still behaves sanely.
  double sampleRate = 48000.0;
  // Generous upper bound for the render quantum (worklet uses 128). Reset
  // pre-allocates internal buffers for this many frames.
  int maxBufferSize = 2048;
};

} // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
void* nam_create()
{
  return new (std::nothrow) NamContext();
}

EMSCRIPTEN_KEEPALIVE
void nam_destroy(void* ctx)
{
  delete static_cast<NamContext*>(ctx);
}

EMSCRIPTEN_KEEPALIVE
void nam_set_sample_rate(void* ctx, double sampleRate)
{
  auto* c = static_cast<NamContext*>(ctx);
  if (c != nullptr && sampleRate > 0.0)
    c->sampleRate = sampleRate;
}

// Returns 0 on success, non-zero on failure. A non-zero code is surfaced to the
// main thread by the worklet, so failures (parse error, unsupported file
// version, unknown architecture) degrade to a clear error instead of a WASM trap.
EMSCRIPTEN_KEEPALIVE
int nam_load_model(void* ctx, const char* json, int len)
{
  auto* c = static_cast<NamContext*>(ctx);
  if (c == nullptr || json == nullptr || len <= 0)
    return -1;

  try
  {
    auto config = nlohmann::json::parse(json, json + len);
    auto model = nam::get_dsp(config);
    if (!model)
      return -2;
    model->Reset(c->sampleRate, c->maxBufferSize);
    c->model = std::move(model);
    return 0;
  }
  catch (const std::exception&)
  {
    return 1; // parse / version-gate / architecture error
  }
  catch (...)
  {
    return 2;
  }
}

EMSCRIPTEN_KEEPALIVE
int nam_is_loaded(void* ctx)
{
  auto* c = static_cast<NamContext*>(ctx);
  return (c != nullptr && c->model) ? 1 : 0;
}

// Mono in / mono out. `in` and `out` are float* into the WASM heap (HEAPF32).
// NAM's process() takes NAM_SAMPLE** (float** under NAM_SAMPLE_FLOAT); adapt the
// single channel to a 1-element pointer array. Passes audio through unchanged
// when no model is loaded.
EMSCRIPTEN_KEEPALIVE
void nam_process(void* ctx, float* in, float* out, int n)
{
  auto* c = static_cast<NamContext*>(ctx);
  if (n <= 0 || in == nullptr || out == nullptr)
    return;

  if (c == nullptr || !c->model)
  {
    if (in != out)
      std::memcpy(out, in, static_cast<size_t>(n) * sizeof(float));
    return;
  }

  float* inPtrs[1] = {in};
  float* outPtrs[1] = {out};
  c->model->process(inPtrs, outPtrs, n);
}

} // extern "C"
