FROM golang:1.26.5-bookworm@sha256:53eeac89074db483fdf0ab3be1df32bf6e47562263d2d0d6baa7f26acb4957dd AS plugin
WORKDIR /src
COPY analyze/datasource/go.mod analyze/datasource/go.sum ./
RUN go mod download
COPY analyze/datasource/ ./
RUN CGO_ENABLED=0 go test -mod=readonly ./...
RUN CGO_ENABLED=0 go build -mod=readonly -trimpath -o "/out/gpx_plow_linux_$(go env GOARCH)" .

FROM caddy:2.10-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d AS brand
ADD --checksum=sha256:ed6f7e8b07fa6bc6922c3e6a41948408833bb0c60a2a867579437048718dc5d5 https://grafana.com/api/plugins/marcusolsson-dynamictext-panel/versions/6.3.1/download /tmp/business-text.zip
RUN unzip -q /tmp/business-text.zip -d /plugins
ADD --checksum=sha256:6ba68b9927ad2a640d32cbea050ffc2b5d0ae6cbaa785afe470da9d6bf0ef39f https://raw.githubusercontent.com/tryapparent/plow/100c02f1802d626a8150120c5073ce293f3058ad/public/assets/youngserif.woff2 /brand/youngserif.woff2
ADD --checksum=sha256:a6608ab32f7090f577e51a3b6d4b4f0609762686b88f9084d65a5623b44da11d https://raw.githubusercontent.com/tryapparent/plow/100c02f1802d626a8150120c5073ce293f3058ad/public/assets/source-serif-4.woff2 /brand/source-serif-4.woff2
ADD --checksum=sha256:39f676ae87250f747d2bb5d4bbde83d575b79922037ab1cdaa2abc70508d1114 https://raw.githubusercontent.com/tryapparent/plow/100c02f1802d626a8150120c5073ce293f3058ad/public/assets/youngserif-ofl.txt /brand/youngserif-ofl.txt
ADD --checksum=sha256:0fd8b796c1c6220a559a5682cfd00d1c8488b428369f7cb70deb671888cef85f https://raw.githubusercontent.com/tryapparent/plow/100c02f1802d626a8150120c5073ce293f3058ad/public/assets/source-serif-4-ofl.txt /brand/source-serif-4-ofl.txt
ADD --checksum=sha256:727a37a311aa6157801961a1a41413dc3c44a6ed4388bf8e4507a0bf58601b10 https://raw.githubusercontent.com/tryapparent/plow/100c02f1802d626a8150120c5073ce293f3058ad/public/assets/field.jpg /brand/field.jpg
RUN chmod 0644 /brand/*

FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS policy
WORKDIR /src
COPY tooling/bend.ts tooling/bend.ts
COPY analyze/policy/main.ts analyze/policy/*.bend analyze/policy/
RUN mkdir -p /out /dashboards && node analyze/policy/main.ts --compile /out
COPY grafana/dashboards/run-breakdown.json /src/dashboards.json
RUN node -e 'const fs = require("node:fs"); for (const d of require("/src/dashboards.json")) fs.writeFileSync("/dashboards/" + d.uid + ".json", JSON.stringify(d))'

FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS capture
WORKDIR /opt/plow
COPY tooling/bend.ts tooling/bend.ts
COPY collect/fixture.ts collect/*.bend collect/
COPY collect/t3/read.ts collect/t3/read.ts
RUN mkdir /opt/plow/policy && node --input-type=module -e 'import { buildPolicies } from "./tooling/bend.ts"; await buildPolicies("/opt/plow/policy", [[new URL("./collect/project.bend", import.meta.url), "collect.mjs"], [new URL("./collect/capture.bend", import.meta.url), "capture.mjs"]])'
ENV PLOW_COLLECT_MODULE=/opt/plow/policy/collect.mjs \
    PLOW_CAPTURE_MODULE=/opt/plow/policy/capture.mjs

FROM grafana/mcp-grafana:2.3.0@sha256:c27248b5919d09d64ea273ca1b128b32902c6796f6e2dfcd11849d4f1363f9ed AS grafana-mcp-upstream

FROM node:22.23.0-bookworm-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS grafana-mcp
COPY --from=grafana-mcp-upstream /app/mcp-grafana /usr/local/bin/mcp-grafana
COPY infra/access/gateway.mjs /opt/plow/gateway.mjs
ENTRYPOINT ["node", "/opt/plow/gateway.mjs", "mcp"]

FROM grafana/grafana:12.3.0-ubuntu@sha256:cee936306135e1925ab21dffa16f8a411535d16ab086bef2309339a8e74d62df
COPY --from=policy /usr/local/bin/node /usr/local/bin/node
COPY --from=plugin /out/ /opt/plow/plugins/plow-agent-observability-datasource/
COPY analyze/datasource/plugin.json analyze/datasource/module.js /opt/plow/plugins/plow-agent-observability-datasource/
COPY grafana/assets/plow-cream.png /usr/share/grafana/public/build/plow-cream.png
COPY --from=brand /plugins/ /opt/plow/plugins/
COPY --from=brand /brand/ /usr/share/grafana/public/build/plow-brand/
COPY --from=policy /out/ /opt/plow/policy/
COPY --from=policy /dashboards/ /opt/plow/dashboards/
COPY grafana/dashboards/codex-trace*.json grafana/dashboards/collection-health.json /opt/plow/dashboards/
COPY analyze/policy/main.ts /opt/plow/policy/main.ts
COPY --chmod=0755 infra/lgtm/policy.sh /opt/plow/policy/analyze
ENV GF_PATHS_PLUGINS=/opt/plow/plugins \
    PLOW_POLICY_COMMAND=/opt/plow/policy/analyze \
    PLOW_POLICY_MODULE=/opt/plow/policy/run.mjs \
    PLOW_ACTIVITY_MODULE=/opt/plow/policy/activity.mjs
