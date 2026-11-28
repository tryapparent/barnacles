FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS plugin
WORKDIR /src
COPY analyze/datasource/go.mod analyze/datasource/go.sum ./
RUN go mod download
COPY analyze/datasource/ ./
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o "/out/gpx_plow_linux_$(go env GOARCH)" .

FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS policy
WORKDIR /src
COPY tooling/bend.ts tooling/bend.ts
COPY analyze/policy/main.ts analyze/policy/run.bend analyze/policy/
RUN mkdir /out && node analyze/policy/main.ts --compile /out

FROM grafana/grafana:12.3.0-ubuntu@sha256:cee936306135e1925ab21dffa16f8a411535d16ab086bef2309339a8e74d62df
COPY --from=policy /usr/local/bin/node /usr/local/bin/node
COPY --from=plugin /out/ /opt/plow/plugins/plow-agent-observability-datasource/
COPY analyze/datasource/plugin.json analyze/datasource/module.js /opt/plow/plugins/plow-agent-observability-datasource/
COPY grafana/assets/plow-cream.png /usr/share/grafana/public/build/plow-cream.png
COPY --from=policy /out/run.mjs /opt/plow/policy/run.mjs
COPY analyze/policy/main.ts /opt/plow/policy/main.ts
COPY --chmod=0755 infra/lgtm/policy.sh /opt/plow/policy/analyze
ENV GF_PATHS_PLUGINS=/opt/plow/plugins \
    PLOW_POLICY_COMMAND=/opt/plow/policy/analyze \
    PLOW_POLICY_MODULE=/opt/plow/policy/run.mjs
