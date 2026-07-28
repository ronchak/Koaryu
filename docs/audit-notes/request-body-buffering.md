# Request body buffering measurement and mitigation

> Implemented and measured on July 27, 2026. The original planning note correctly treated “double buffering” as a hypothesis. Measurement showed that the backend middleware retains references to ASGI chunks rather than creating a second contiguous body, while the Next.js proxy intentionally does create a second contiguous `ArrayBuffer`. Only backend CSV-import concurrency needed a runtime change.

## Outcome

Koaryu keeps every existing pre-parser request-size limit and byte-for-byte replay guarantee. The backend now admits at most four CSV-import requests per process at once. Later imports wait before the middleware calls `receive()`, which lets Uvicorn apply transport backpressure rather than accumulating another request-sized in-process buffer.

The gate is deliberately narrow:

- it covers only the three CSV import endpoints with the 30.311 MiB request envelope;
- it is acquired after `Content-Length` validation, so a declared overflow still receives an immediate `413` without consuming the body;
- streamed overflow is still read only through the configured limit and then receives `413`;
- the slot remains held through multipart parsing and endpoint execution, covering the portion of the request that owns the retained body and parsed upload;
- ordinary JSON, Stripe webhooks, and student photos keep their existing behavior and smaller limits.

No proxy runtime change is warranted. Vercel rejects bodies above 4.5 MB before the Next route executes, and the deployment must keep `NEXT_PUBLIC_USE_API_PROXY=false` when full-size CSV imports are required. The measured in-process proxy peak below that platform boundary is small relative to the documented 2 GB function memory class. Replacing the bounded concatenate with streaming would complicate overflow handling and exact-byte forwarding without solving a deployed memory problem.

## Reproduce

Install the pinned backend and frontend dependencies, then run:

```sh
npm run profile:request-bodies
```

For a four-case smoke profile:

```sh
npm run profile:request-bodies:quick
```

The backend profiler runs the real `RequestBodyLimitMiddleware` and Starlette request/form parsers. The proxy profiler runs the real Next route and `readBoundedProxyRequestBody` with a synthetic upstream. Each row executes in a fresh child process. Payloads are generated lazily in 64 KiB chunks so the generator is not itself a request-sized baseline allocation. The profilers fail if status, overflow consumption, or byte integrity differs from the expected contract.

RSS/latency and allocation are separate backend passes because `tracemalloc` changes both RSS and timing. Node allocation is the peak V8 heap plus external-memory delta; the separate ArrayBuffer column makes the request copies visible. These are local synthetic measurements, not production traffic observations or capacity guarantees.

Environment:

- Apple Silicon macOS
- Python 3.11.15
- FastAPI 0.139.0
- Starlette 1.3.1
- python-multipart 0.0.32
- Uvicorn 0.30.0
- Node 25.9.0
- Next.js 16.2.12

The deployed assumptions are the repository's single Uvicorn process on Render `starter` and the Next.js Node runtime on Vercel. Render documents `starter` as 512 MB / 0.5 CPU. Vercel documents a 2 GB default for Node.js functions and a separate, non-configurable 4.5 MB request/response payload ceiling. Re-run the profile after a dependency, worker-count, instance-class, request-limit, or proxy-body implementation change.

## Direct backend results

The full application import reached 140.062 MiB peak RSS before serving a request. The request-only workers had a roughly 52-61 MiB baseline; the table reports deltas from each fresh worker baseline.

Representative post-mitigation results:

| request | body MiB | concurrency | RSS delta MiB | Python allocation peak MiB | p50 ms | max ms | result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| JSON | 1.000 | 1 | 3.234 | 3.077 | 2.818 | 2.818 | `204`, bytes exact |
| JSON | 1.000 | 4 | 8.625 | 5.915 | 7.253 | 9.833 | `204`, bytes exact |
| multipart file | 2.000 | 1 | 4.375 | 2.632 | 15.542 | 15.542 | `204`, file rolled |
| multipart file | 10.000 | 1 | 14.453 | 10.660 | 53.124 | 53.124 | `204`, file rolled |
| multipart file | 10.000 | 4 | 54.422 | 41.163 | 149.482 | 150.013 | `204`, bytes exact |
| maximum envelope | 30.311 | 1 | 39.969 | 31.040 | 69.558 | 69.558 | `400`, bytes exact |
| maximum envelope | 30.311 | 4 | 156.875 | 122.683 | 209.872 | 229.781 | `400`, bytes exact |
| maximum envelope | 30.311 | 8 | 159.594 | 122.700 | 304.824 | 407.312 | `400`, bytes exact |
| declared JSON overflow | 0.062 sent | 1 | 0.000 | 0.011 | 0.045 | 0.045 | `413`, zero body bytes read |
| streamed JSON overflow | 1.000 | 1 | 1.172 | 1.074 | 1.011 | 1.011 | `413` at limit + 1 |
| streamed multipart overflow | 30.311 | 1 | 38.000 | 30.484 | 27.940 | 27.940 | `413` at limit + 1 |

The maximum-envelope case intentionally puts the remaining envelope into the non-file `payload` field. Starlette rejects that field at its 1 MiB part limit, so the HTTP result is `400`; it still exercises the middleware's worst configured retention before parsing starts.

Before the admission gate, eight concurrent maximum envelopes added 303.375 MiB RSS. Combining that delta with the 140.062 MiB full-app baseline projected roughly 443 MiB, or 87% of the 512 MiB instance, before endpoint/service allocations. After the four-request gate, eight clients plateaued near the four-request peak at 159.594 MiB. The same projection is roughly 300 MiB, leaving about 212 MiB for endpoint work, allocator variance, and runtime overhead.

Four simultaneous maximum-envelope CSV imports are therefore the supported per-process memory assumption on the configured Render instance. Higher client concurrency is accepted but backpressured in groups of four. This depends on the intentional single-process deployment; every additional Uvicorn worker would get its own four-slot gate and its own import baseline.

## Proxied results

The proxy helper retains incoming `Uint8Array` chunks, allocates one exact-size `Uint8Array`, copies every chunk into it, and hands its `ArrayBuffer` to `fetch`. The measured ArrayBuffer peak is therefore about twice the accepted body size per simultaneous request until garbage collection can release the original chunks.

Only rows below 4.5 MB can execute as deployed Vercel Function requests. The larger rows are intentional local stress tests of Koaryu's configured proxy limit and copy behavior; Vercel would return its platform `413 FUNCTION_PAYLOAD_TOO_LARGE` first.

Representative results:

| request | body MiB | concurrency | RSS delta MiB | Node allocation peak MiB | ArrayBuffer delta MiB | p50 ms | result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| JSON | 1.000 | 1 | 2.531 | 2.451 | 2.000 | 8.456 | `204`, bytes exact |
| JSON | 1.000 | 4 | 6.531 | 8.800 | 8.000 | 18.716 | `204`, bytes exact |
| multipart | 10.000 | 1 | 18.531 | 21.089 | 20.001 | 45.712 | `204`, bytes exact |
| multipart | 10.000 | 4 | 79.672 | 81.480 | 80.002 | 163.848 | `204`, bytes exact |
| maximum envelope | 30.311 | 1 | 59.813 | 63.246 | 60.621 | 156.696 | `204`, bytes exact |
| maximum envelope | 30.311 | 4 | 224.828 | 215.894 | 212.174 | 555.057 | `204`, bytes exact |
| maximum envelope | 30.311 | 8 | 460.891 | 397.649 | 363.605 | 1108.862 | `204`, bytes exact |
| declared JSON overflow | 0.062 sent | 1 | 0.328 | 0.279 | 0.000 | 3.366 | `413`, zero body bytes read |
| streamed JSON overflow | 1.000 | 1 | 1.828 | 1.484 | 1.000 | 16.439 | `413` at limit + 1 |
| streamed multipart overflow | 30.311 | 1 | 29.484 | 33.015 | 30.311 | 204.071 | `413` at limit + 1 |

The synthetic upstream reads the handed-off buffer without making another copy. A real network stack may retain additional internal data, so the proxy rows are a lower bound for forwarding. At the deployed 4.5 MB boundary, the measured copy slope remains small relative to Vercel's documented 2 GB default; larger bodies never enter the route. The current bounded implementation remains appropriate, and deployment guidance now explicitly keeps full-size CSV imports on the direct browser-to-Render path.

## Actual retention and spooling semantics

The relevant code and pinned dependency sources establish:

1. ASGI delivers request bodies as one or more `http.request` messages. `more_body=true` means the consumer must continue receiving and concatenate logically; chunk boundaries are not part of the HTTP body contract.
2. Uvicorn 0.30's h11 and httptools protocols pause transport reading after their receive buffer exceeds a 64 KiB high-water mark. `receive()` returns that buffer in an ASGI message and resets the protocol's body reference.
3. Koaryu's middleware appends each returned message dictionary to a `deque`. It does not copy or concatenate the chunk. Replay returns the same message objects and removes references with `popleft()`. Unit tests assert object identity and exact bytes.
4. Starlette `Request.stream()` yields the replayed chunk bytes. `Request.body()` retains those chunks and creates a contiguous `b"".join(...)` result for JSON consumers.
5. Starlette 1.3.1 uses `SpooledTemporaryFile(max_size=1 MiB)` for multipart file parts. Files above 1 MiB roll to disk. Non-file parts default to a separate 1 MiB `max_part_size`. The profile observes 256 KiB files in memory and 2/10 MiB files rolled to disk.
6. Koaryu intentionally completes the size check before invoking FastAPI/Starlette. The concurrency gate does not change that ordering.

Primary references:

- [ASGI HTTP request message specification](https://asgi.readthedocs.io/en/latest/specs/www.html#request-receive-event)
- [Starlette 1.3.1 multipart parser source](https://github.com/Kludex/starlette/blob/1.3.1/starlette/formparsers.py)
- [Starlette 1.3.1 request source](https://github.com/Kludex/starlette/blob/1.3.1/starlette/requests.py)
- [Render instance types](https://render.com/docs/compute-plans)
- [Vercel function memory limits](https://vercel.com/docs/functions/limitations#memory-size-limits)
- [Vercel function request body limit](https://vercel.com/docs/functions/limitations#request-body-size)

## Verification contract

Targeted tests cover:

- same-object and byte-for-byte ASGI replay for JSON and multipart;
- four-slot CSV admission before body reads;
- declared CSV overflow bypassing a full admission queue;
- streamed backend overflow;
- proxy declared and streamed overflow;
- proxy byte-for-byte multipart forwarding with the original boundary.

The profilers independently check the same status and integrity properties for every measured size/concurrency row and exit nonzero on a mismatch.
