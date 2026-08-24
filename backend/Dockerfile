FROM python:3.11.9-slim-bookworm@sha256:8fb099199b9f2d70342674bd9dbccd3ed03a258f26bbd1d556822c6dfc60c317

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends libjemalloc2 \
    && jemalloc_path="$(dpkg -L libjemalloc2 | sed -n '/\/libjemalloc\.so\.2$/p' | head -n 1)" \
    && test -n "$jemalloc_path" \
    && ln -s "$jemalloc_path" /usr/local/lib/libjemalloc.so.2 \
    && rm -rf /var/lib/apt/lists/*

ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so.2

WORKDIR /app

COPY requirements.txt ./requirements.txt
RUN python -m pip install --no-cache-dir --require-hashes -r requirements.txt

COPY app ./app
COPY scripts/start-render.sh ./scripts/start-render.sh

RUN useradd --create-home --uid 10001 koaryu \
    && chown -R koaryu:koaryu /app

USER koaryu

EXPOSE 10000

CMD ["./scripts/start-render.sh"]
