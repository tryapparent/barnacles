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
COPY public/assets/youngserif.woff2 public/assets/source-serif-4.woff2 public/assets/youngserif-ofl.txt public/assets/source-serif-4-ofl.txt public/assets/field.jpg /brand/
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

USER root
RUN node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const build = '/usr/share/grafana/public/build';
const manifestPath = build + '/assets-manifest.json';
const original = '5923.b9c876b4bf528d8511cb.js';
const asset = readFileSync(build + '/' + original, 'utf8');
const hash = (algorithm, data, encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
if (hash('sha256', asset) !== '64f28eb77a28d4ba3e16a84dd62b2bd5e8dbcba95a302058af169b81aaf7cbe9') {
  throw new Error('Grafana theme bundle changed. Recheck the Plow theme patch.');
}

const cream = '#FFF4DF';
const ink = '#1A130D';
const meadow = '#6A934F';
const focus = '#B6CE91';
const theme = {
  name: 'Plow',
  colors: {
    mode: 'dark',
    background: { canvas: ink, primary: '#392820', secondary: '#30221B', elevated: '#463329' },
    text: { primary: cream, secondary: '#E1CDB8', disabled: '#B9A18B', link: focus, maxContrast: '#FFFFFF' },
    border: { weak: '#FFF4DF26', medium: '#FFF4DF40', strong: '#FFF4DF66' },
    primary: {
      main: meadow, shade: '#80A764', text: focus, border: focus, contrastText: ink,
      transparent: '#6A934F33', borderTransparent: '#B6CE9166',
    },
    action: { hover: '#FFF4DF1F', selected: '#6A934F33', selectedBorder: focus, focus: '#B6CE914D' },
    gradients: {
      brandHorizontal: 'linear-gradient(270deg, #6A934F 0%, #B6CE91 100%)',
      brandVertical: 'linear-gradient(0deg, #6A934F 0%, #B6CE91 100%)',
    },
  },
};
const definition = /s=\{name:"Debug",.*?\},M=\{name:"Desert bloom"/g;
if ([...asset.matchAll(definition)].length !== 1) {
  throw new Error('Expected one Grafana Debug theme definition.');
}
const profileFilter = 'filter(u=>u.isExtra?y.includes(u.id):!0)';
if (asset.split(profileFilter).length !== 2) {
  throw new Error('Expected one Grafana theme picker filter.');
}
const patched = asset.replace(definition, 's=' + JSON.stringify(theme) + ',M={name:"Desert bloom"')
  .replace(profileFilter, 'filter(u=>u.isExtra?u.id==="debug"||y.includes(u.id):!0)')
  .split('\n//# sourceMappingURL=')[0] + '\n';
const replacement = '5923.' + hash('sha256', patched).slice(0, 20) + '.js';
const oldSource = 'public/build/' + original;
const newSource = 'public/build/' + replacement;
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest[original]?.src !== oldSource ||
    !manifest.entrypoints.app.assets.js.includes(oldSource) ||
    !manifest.entrypoints.swagger.assets.js.includes(oldSource)) {
  throw new Error('Grafana asset manifest no longer matches the patched bundle.');
}
manifest[replacement] = {
  src: newSource,
  integrity: ['sha384', 'sha512'].map(algorithm => algorithm + '-' + hash(algorithm, patched, 'base64')).join(' '),
};
delete manifest[original];
for (const entrypoint of Object.values(manifest.entrypoints)) {
  entrypoint.assets.js = entrypoint.assets.js.map(src => src === oldSource ? newSource : src);
}
writeFileSync(build + '/' + replacement, patched);
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
unlinkSync(build + '/' + original);
JS
USER 472
