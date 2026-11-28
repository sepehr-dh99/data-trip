ARG RUST_IMAGE=rust:1.96-slim-bookworm
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=debian:bookworm-slim

FROM ${RUST_IMAGE} AS rust-build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential ca-certificates cmake libssl-dev perl pkg-config \
    && rm -rf /var/lib/apt/lists/*

FROM rust-build AS rust-tools
RUN rustup target add wasm32-unknown-unknown \
    && cargo install --locked wasm-bindgen-cli --version 0.2.130

FROM rust-tools AS wasm
WORKDIR /src
COPY crates/datatrip-import-format crates/datatrip-import-format
COPY crates/datatrip-wasm crates/datatrip-wasm
RUN cargo build --locked --manifest-path crates/datatrip-wasm/Cargo.toml --target wasm32-unknown-unknown --release \
    && wasm-bindgen --target web --out-dir /generated \
       crates/datatrip-wasm/target/wasm32-unknown-unknown/release/datatrip_wasm.wasm

FROM ${NODE_IMAGE} AS web-assets
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci
COPY src src
COPY --from=wasm /generated src/generated
COPY web.html tsconfig.json vite.web.config.ts ./
RUN npm run web:assets

FROM rust-build AS server
WORKDIR /src
COPY crates/datatrip-core crates/datatrip-core
COPY crates/datatrip-import-format crates/datatrip-import-format
COPY src-web src-web
RUN cargo build --locked --release --manifest-path src-web/Cargo.toml \
    && install -m 0755 src-web/target/release/datatrip-web /datatrip-web \
    && rm -rf src-web/target /usr/local/cargo/registry

FROM ${RUNTIME_IMAGE}
COPY --from=rust-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN install -d -o 10001 -g 10001 /data
WORKDIR /app
COPY --from=server /datatrip-web /usr/local/bin/datatrip-web
COPY --from=web-assets /src/dist-web /app/dist-web
USER 10001:10001
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s \
    CMD ["/usr/local/bin/datatrip-web", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/datatrip-web"]
CMD ["--config", "/etc/datatrip/web.yml"]
