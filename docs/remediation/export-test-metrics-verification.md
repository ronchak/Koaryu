# Export test measurement correction

PR174 addresses BT4-01 in the export scale fixture. Its RSS delta had platform-dependent units and process-lifetime scope, so it was not an export memory measurement. Allocation tracing also distorted the same fixture's real-time deadline check. The unchanged test failed once during PR172 CI at 50,000 rows, then passed on one unchanged-head rerun. That is evidence of unreliable test measurement, not authority to increase a production limit.

The fixture keeps its existing injected budget clock fixed while measuring Python allocations during artifact construction. Real elapsed time remains a diagnostic. The raw RSS delta and traced wall-time assertions are removed. The allocation ceiling, exact fetched/emitted rows and provider calls, byte limit, output agreement, spool rollover and closure remain. Tracing stops in finally if construction fails. This does not claim total process memory or production latency.

The production 15-second limit and monotonic clock are unchanged. Existing deterministic tests still accept exactly 15 seconds, reject 16 seconds and require spool closure after rejection. Other retained tests cover row/byte limits, bounded streaming, failures, cancellation and client thread ownership. No new profiler, framework, runtime behavior or provider operation is introduced.

The one test file shrinks from 774 to 773 lines. All 15 cases remain; two misleading assertions are removed. Both the worker and a fresh independent Astra reviewer ran those 15 tests successfully. Root read the complete diff and checked that no repository consumer depends on the removed metric or renamed test.

The original reviewed source was `f7ed60a3b438d323fe74e397a57d0f025800082f`. The rebased source is `5edbc3d866c96894a3aba1ac7d176116d4c2d59c` on PR172 main `08b1e77f593b0f01dcbf038c5ab58001ea3289fb`; the implementation diff is byte-identical, SHA256 `56036b9116fc0a96cb6fc29c1ed0bda22aee716b721d0eac0132d7115834af37`. Final-head review and release CI remain merge gates. Dashboard memory-scope finding BT1-07 remains pending.
