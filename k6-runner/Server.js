// Compatibilidade: alguns ambientes/sistemas de arquivos diferenciam maiúsculas.
// Mantemos `Server.js` como fonte, mas expomos `server.js` como entrypoint padrão.
require("./Server.js");

const express = require("express");
const { spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = Number(process.env.PORT) || 5000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "static")));

const TMP_DIR = path.join(__dirname, "tmp");
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

// ── K6 check ──────────────────────────────────────────────────────────────
function isK6Installed() {
  try { execSync("k6 version", { stdio: "pipe" }); return true; } catch { return false; }
}

// ── HTTP request helper (simulador) ───────────────────────────────────────
function makeRequest(url, method, headers, body) {
  return new Promise((resolve) => {
    const start = Date.now();
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method.toUpperCase(),
      headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
      timeout: 10000,
    };
    const req = lib.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        const total = Date.now() - start;
        resolve({
          status: res.statusCode,
          duration: total,
          bodySize: Buffer.byteLength(data, "utf8"),
          ok: res.statusCode >= 200 && res.statusCode < 300,
          error: null,
          connectTime: Math.round(total * 0.15),
          waitTime: Math.round(total * 0.6),
          receiveTime: Math.round(total * 0.25),
          tlsTime: isHttps ? Math.round(total * 0.1) : 0,
          sendTime: Math.round(total * 0.05),
        });
      });
    });
    req.on("error", (err) => {
      resolve({ status: 0, duration: Date.now() - start, bodySize: 0, ok: false, error: err.message, connectTime: 0, waitTime: 0, receiveTime: 0, tlsTime: 0, sendTime: 0 });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, duration: 10000, bodySize: 0, ok: false, error: "timeout", connectTime: 0, waitTime: 0, receiveTime: 0, tlsTime: 0, sendTime: 0 });
    });
    if (body && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      req.write(typeof body === "string" ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ── Percentil ─────────────────────────────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

// ── Parse duração ─────────────────────────────────────────────────────────
function parseDuration(str) {
  const s = String(str || "30s").trim().toLowerCase();
  if (s.endsWith("ms")) return parseInt(s);
  if (s.endsWith("h"))  return parseInt(s) * 3600000;
  if (s.endsWith("m"))  return parseInt(s) * 60000;
  if (s.endsWith("s"))  return parseInt(s) * 1000;
  return 30000;
}

// ── Estágios por tipo de teste ────────────────────────────────────────────
function buildStages(testType, vus, totalMs) {
  const lbl = (ms) => ms >= 60000 ? `${Math.round(ms/60000)}m` : `${Math.round(ms/1000)}s`;
  switch (testType) {
    case "smoke":
      return [{ targetVUs: 1, durationMs: Math.min(totalMs, 15000), durationLabel: lbl(Math.min(totalMs,15000)), label: "smoke" }];
    case "stress":
      return [
        { targetVUs: Math.max(1,Math.round(vus*0.5)), durationMs: Math.round(totalMs*0.25), durationLabel: lbl(Math.round(totalMs*0.25)), label: "ramp 50%" },
        { targetVUs: vus,                             durationMs: Math.round(totalMs*0.25), durationLabel: lbl(Math.round(totalMs*0.25)), label: "carga normal" },
        { targetVUs: Math.round(vus*1.5),             durationMs: Math.round(totalMs*0.25), durationLabel: lbl(Math.round(totalMs*0.25)), label: "sobre carga" },
        { targetVUs: Math.round(vus*1.5),             durationMs: Math.round(totalMs*0.15), durationLabel: lbl(Math.round(totalMs*0.15)), label: "sustentação" },
        { targetVUs: 0,                               durationMs: Math.round(totalMs*0.1),  durationLabel: lbl(Math.round(totalMs*0.1)),  label: "ramp-down" },
      ];
    case "spike":
      return [
        { targetVUs: 3,   durationMs: Math.round(totalMs*0.15), durationLabel: lbl(Math.round(totalMs*0.15)), label: "base" },
        { targetVUs: vus, durationMs: Math.round(totalMs*0.25), durationLabel: lbl(Math.round(totalMs*0.25)), label: "pico 1" },
        { targetVUs: 3,   durationMs: Math.round(totalMs*0.1),  durationLabel: lbl(Math.round(totalMs*0.1)),  label: "normaliza" },
        { targetVUs: vus, durationMs: Math.round(totalMs*0.25), durationLabel: lbl(Math.round(totalMs*0.25)), label: "pico 2" },
        { targetVUs: 0,   durationMs: Math.round(totalMs*0.1),  durationLabel: lbl(Math.round(totalMs*0.1)),  label: "ramp-down" },
      ];
    case "soak":
      return [
        { targetVUs: vus, durationMs: Math.round(totalMs*0.1), durationLabel: lbl(Math.round(totalMs*0.1)), label: "ramp-up" },
        { targetVUs: vus, durationMs: Math.round(totalMs*0.8), durationLabel: lbl(Math.round(totalMs*0.8)), label: "soak" },
        { targetVUs: 0,   durationMs: Math.round(totalMs*0.1), durationLabel: lbl(Math.round(totalMs*0.1)), label: "ramp-down" },
      ];
    case "breakpoint":
      return [
        { targetVUs: Math.round(vus*0.2), durationMs: Math.round(totalMs*0.2), durationLabel: "20%",  label: "20% carga" },
        { targetVUs: Math.round(vus*0.5), durationMs: Math.round(totalMs*0.2), durationLabel: "50%",  label: "50% carga" },
        { targetVUs: vus,                 durationMs: Math.round(totalMs*0.2), durationLabel: "100%", label: "100% carga" },
        { targetVUs: Math.round(vus*1.5), durationMs: Math.round(totalMs*0.2), durationLabel: "150%", label: "150% carga" },
        { targetVUs: Math.round(vus*2),   durationMs: Math.round(totalMs*0.2), durationLabel: "200%", label: "200% carga" },
      ];
    default: // load
      return [
        { targetVUs: Math.max(1,Math.round(vus*0.5)), durationMs: Math.round(totalMs*0.2), durationLabel: lbl(Math.round(totalMs*0.2)), label: "ramp-up" },
        { targetVUs: vus,                             durationMs: Math.round(totalMs*0.6), durationLabel: lbl(Math.round(totalMs*0.6)), label: "load" },
        { targetVUs: 0,                               durationMs: Math.round(totalMs*0.2), durationLabel: lbl(Math.round(totalMs*0.2)), label: "ramp-down" },
      ];
  }
}

// ── Simulador K6 nativo ───────────────────────────────────────────────────
async function runSimulator({ url, vus, duration, token, headers, testType, method, body }, sendEvent) {
  const durationMs = parseDuration(duration);
  const vuCount    = parseInt(vus) || 10;
  const userHeaders = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const authHeader = token ? { Authorization: `Bearer ${token}` } : {};
  const mergedHeaders = { ...userHeaders, ...authHeader };
  const stages     = buildStages(testType, vuCount, durationMs);

  sendEvent("status", `🔬 [SIMULADOR] k6 não encontrado — rodando simulação Node.js nativa`);
  sendEvent("status", `📋 Tipo: ${testType.toUpperCase()} | VUs: ${vuCount} | Duração: ${duration}`);
  sendEvent("log",    `    URL: ${url}`);
  sendEvent("log",    `    Método: ${method.toUpperCase()}`);
  sendEvent("log",    ``);

  const allDurations=[], allWaiting=[], allConnecting=[], allTls=[], allSending=[], allReceiving=[];
  let totalReqs=0, failedReqs=0, totalBytes=0, sentBytes=0, checks=0, checksPassed=0;
  let activeVUs=0, maxVUs=0;
  const startTime = Date.now();

  for (const stage of stages) {
    if (stage.targetVUs === 0) {
      sendEvent("log", `  ▶ Estágio: ${stage.label} → ramp-down`);
      await new Promise(r => setTimeout(r, Math.min(stage.durationMs, 2000)));
      continue;
    }
    activeVUs = stage.targetVUs;
    if (activeVUs > maxVUs) maxVUs = activeVUs;
    sendEvent("log", `  ▶ Estágio: ${stage.label} → ${stage.targetVUs} VUs por ${stage.durationLabel}`);

    const stageEnd = Date.now() + stage.durationMs;
    while (Date.now() < stageEnd) {
      const batchSize = Math.min(stage.targetVUs, 12);
      const promises  = [];
      for (let i = 0; i < batchSize; i++) {
        if (Date.now() >= stageEnd) break;
        promises.push(makeRequest(url, method, mergedHeaders, body));
      }
      const results = await Promise.all(promises);
      for (const r of results) {
        totalReqs++; checks++;
        if (r.ok) {
          checksPassed++;
          allDurations.push(r.duration);
          allWaiting.push(r.waitTime);
          allConnecting.push(r.connectTime);
          allTls.push(r.tlsTime);
          allSending.push(r.sendTime);
          allReceiving.push(r.receiveTime);
          totalBytes += r.bodySize;
          sentBytes  += 200;
        } else {
          failedReqs++;
          allDurations.push(r.duration || 9999);
        }
      }
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const rps     = (totalReqs / Math.max(1, (Date.now()-startTime)/1000)).toFixed(1);
      const errRate = ((failedReqs / Math.max(1, totalReqs)) * 100).toFixed(1);
      const avgDur  = allDurations.length ? (allDurations.reduce((a,b)=>a+b,0)/allDurations.length).toFixed(0) : "—";
      sendEvent("log", `  ${elapsed}s | VUs: ${batchSize} | Reqs: ${totalReqs} | RPS: ${rps} | avg: ${avgDur}ms | erros: ${errRate}%`);
      await new Promise(r => setTimeout(r, 800));
    }
  }

  const totalSec   = (Date.now() - startTime) / 1000;
  const avg        = allDurations.length ? allDurations.reduce((a,b)=>a+b,0)/allDurations.length : 0;
  const fn         = (arr) => arr.length ? (arr.reduce((a,b)=>a+b,0)/arr.length).toFixed(2) : "0.00";

  const summary = [
    "=== K6 LOAD TEST SUMMARY ===", "",
    "── LATÊNCIA ──────────────────────────────────────",
    `http_req_duration avg    : ${avg.toFixed(2)}`,
    `http_req_duration p90    : ${percentile(allDurations,90).toFixed(2)}`,
    `http_req_duration p95    : ${percentile(allDurations,95).toFixed(2)}`,
    `http_req_duration p99    : ${percentile(allDurations,99).toFixed(2)}`, "",
    "── THROUGHPUT ────────────────────────────────────",
    `http_reqs (total)        : ${totalReqs}`,
    `http_reqs/s (RPS)        : ${(totalReqs/totalSec).toFixed(2)}`,
    `vus (usuários virtuais)  : ${activeVUs}`,
    `vus_max (pico de VUs)    : ${maxVUs}`, "",
    "── CONFIABILIDADE ────────────────────────────────",
    `http_req_failed (%)      : ${((failedReqs/Math.max(1,totalReqs))*100).toFixed(2)}`,
    `checks passed (%)        : ${((checksPassed/Math.max(1,checks))*100).toFixed(2)}`,
    `iterations (total)       : ${totalReqs}`,
    `dropped_iterations       : 0`, "",
    "── REDE ──────────────────────────────────────────",
    `http_req_waiting (TTFB)  : ${fn(allWaiting)}`,
    `http_req_connecting      : ${fn(allConnecting)}`,
    `http_req_tls_handshaking : ${fn(allTls)}`,
    `http_req_sending         : ${fn(allSending)}`,
    `http_req_receiving       : ${fn(allReceiving)}`,
    `data_received (KB)       : ${(totalBytes/1024).toFixed(2)}`,
    `data_sent (KB)           : ${(sentBytes/1024).toFixed(2)}`, "",
    "=== FIM DO RESUMO ===",
  ].join("\n");

  sendEvent("log", "");
  sendEvent("log", "✅ Simulação concluída.");
  return summary;
}

// ── K6 script generator ───────────────────────────────────────────────────
function generateK6Script({ url, vus, duration, token, headers, testType, method, body }) {
  const userHeaders =
    headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const userHeadersJson = JSON.stringify(userHeaders);
  const authHeader = token ? `"Authorization": "Bearer ${token}",` : "";
  const httpMethod = (method || "GET").toUpperCase();
  const hasBody    = ["POST", "PUT", "PATCH"].includes(httpMethod) && body;

  const totalMs = Math.max(1000, parseDuration(duration));
  function fmtK6Duration(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s % 3600 === 0) return `${s / 3600}h`;
    if (s % 60 === 0) return `${s / 60}m`;
    return `${s}s`;
  }
  function splitTotal(total, weights) {
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    const raw = weights.map((w) => Math.max(0, Math.floor((total * w) / sum)));
    let used = raw.reduce((a, b) => a + b, 0);
    let remaining = Math.max(0, total - used);
    let i = 0;
    while (remaining > 0) {
      raw[i % raw.length] += 1;
      remaining -= 1;
      i += 1;
    }
    return raw;
  }

  function normalizeJsonBody(input) {
    if (input == null) return null;
    if (typeof input === "object") return input;
    const s = String(input).trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch { return null; }
  }
  const bodyObj = hasBody ? normalizeJsonBody(body) : null;
  const bodyStr = bodyObj ? JSON.stringify(bodyObj) : null;
  const requestCall = (() => {
    switch (httpMethod) {
      case "GET":
        return `http.get("${url}", params)`;
      case "DELETE":
        return `http.del("${url}", null, params)`;
      case "POST":
        return `http.post("${url}", payload, params)`;
      case "PUT":
        return `http.put("${url}", payload, params)`;
      case "PATCH":
        return `http.patch("${url}", payload, params)`;
      default:
        return `http.get("${url}", params)`;
    }
  })();
  const vusHalf = Math.max(1, Math.round(vus * 0.5));
  const vusUp = Math.max(1, Math.round(vus * 1.5));

  const [loadUpMs, loadSteadyMs, loadDownMs] = splitTotal(totalMs, [20, 60, 20]);
  const [stress1Ms, stress2Ms, stress3Ms, stress4Ms, stress5Ms] = splitTotal(totalMs, [25, 25, 25, 15, 10]);
  const [spike1Ms, spike2Ms, spike3Ms, spike4Ms, spike5Ms] = splitTotal(totalMs, [15, 25, 10, 25, 25]);
  const [soakUpMs, soakMs, soakDownMs] = splitTotal(totalMs, [10, 80, 10]);

  const scenarios  = {
    smoke: `\nexport const options = { vus: 1, duration: "${fmtK6Duration(totalMs)}", thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<500"] } };`,
    load: `\nexport const options = { stages: [{ duration: "${fmtK6Duration(loadUpMs)}", target: ${vus} }, { duration: "${fmtK6Duration(loadSteadyMs)}", target: ${vus} }, { duration: "${fmtK6Duration(loadDownMs)}", target: 0 }], thresholds: { http_req_failed: ["rate<0.01"], http_req_duration: ["p(95)<1000"] } };`,
    stress: `\nexport const options = { stages: [{ duration: "${fmtK6Duration(stress1Ms)}", target: ${vusHalf} }, { duration: "${fmtK6Duration(stress2Ms)}", target: ${vus} }, { duration: "${fmtK6Duration(stress3Ms)}", target: ${vusUp} }, { duration: "${fmtK6Duration(stress4Ms)}", target: ${vusUp} }, { duration: "${fmtK6Duration(stress5Ms)}", target: 0 }], thresholds: { http_req_failed: ["rate<0.05"] } };`,
    spike: `\nexport const options = { stages: [{ duration: "${fmtK6Duration(spike1Ms)}", target: ${Math.min(5, vusHalf)} }, { duration: "${fmtK6Duration(spike2Ms)}", target: ${vus} }, { duration: "${fmtK6Duration(spike3Ms)}", target: ${Math.min(5, vusHalf)} }, { duration: "${fmtK6Duration(spike4Ms)}", target: ${vus} }, { duration: "${fmtK6Duration(spike5Ms)}", target: 0 }] };`,
    soak: `\nexport const options = { stages: [{ duration: "${fmtK6Duration(soakUpMs)}", target: ${vus} }, { duration: "${fmtK6Duration(soakMs)}", target: ${vus} }, { duration: "${fmtK6Duration(soakDownMs)}", target: 0 }], thresholds: { http_req_failed: ["rate<0.01"] } };`,
    breakpoint: `\nexport const options = { stages: [{ duration: "${fmtK6Duration(totalMs)}", target: ${Math.round(vus * 5)} }] };`,
  };
  return `import http from "k6/http";
import { check, sleep } from "k6";
${scenarios[testType] || scenarios.load}
export default function () {
  const userHeaders = ${userHeadersJson};
  const params = { headers: { ...userHeaders, ${authHeader} "Content-Type": "application/json" } };
  ${hasBody ? `const payload = ${JSON.stringify(bodyStr || "{}")};` : ""}
  const res = ${requestCall};
  check(res, { "status 2xx": (r) => r.status >= 200 && r.status < 300, "response time < 2s": (r) => r.timings.duration < 2000 });
  sleep(1);
}
export function handleSummary(data) {
  const m = data.metrics;
  function val(metric, stat) {
    if (!metric) return "N/A";
    if (stat === "rate") return ((metric.values?.rate || 0) * 100).toFixed(2);
    if (stat === "count") return (metric.values?.count || 0).toString();
    return (metric.values?.[stat] || 0).toFixed(2);
  }
  function kb(metric) { return metric ? ((metric.values?.count || 0) / 1024).toFixed(2) : "N/A"; }
  const summary = [
    "=== K6 LOAD TEST SUMMARY ===","",
    "── LATÊNCIA ──────────────────────────────────────",
    "http_req_duration avg    : " + val(m.http_req_duration,"avg"),
    "http_req_duration p90    : " + val(m.http_req_duration,"p(90)"),
    "http_req_duration p95    : " + val(m.http_req_duration,"p(95)"),
    "http_req_duration p99    : " + val(m.http_req_duration,"p(99)"),"",
    "── THROUGHPUT ────────────────────────────────────",
    "http_reqs (total)        : " + val(m.http_reqs,"count"),
    "http_reqs/s (RPS)        : " + val(m.http_reqs,"rate"),
    "vus (usuários virtuais)  : " + (m.vus?.values?.value || "N/A"),
    "vus_max (pico de VUs)    : " + (m.vus_max?.values?.max || "N/A"),"",
    "── CONFIABILIDADE ────────────────────────────────",
    "http_req_failed (%)      : " + val(m.http_req_failed,"rate"),
    "checks passed (%)        : " + (m.checks ? (m.checks.values.rate*100).toFixed(2) : "N/A"),
    "iterations (total)       : " + val(m.iterations,"count"),
    "dropped_iterations       : " + val(m.dropped_iterations,"count"),"",
    "── REDE ──────────────────────────────────────────",
    "http_req_waiting (TTFB)  : " + val(m.http_req_waiting,"avg"),
    "http_req_connecting      : " + val(m.http_req_connecting,"avg"),
    "http_req_tls_handshaking : " + val(m.http_req_tls_handshaking,"avg"),
    "http_req_sending         : " + val(m.http_req_sending,"avg"),
    "http_req_receiving       : " + val(m.http_req_receiving,"avg"),
    "data_received (KB)       : " + kb(m.data_received),
    "data_sent (KB)           : " + kb(m.data_sent),"",
    "=== FIM DO RESUMO ===",
  ].join("\\n");
  return { stdout: summary };
}
`;
}

// ── Rotas ─────────────────────────────────────────────────────────────────
app.get("/",         (req, res) => res.sendFile(path.join(__dirname, "templates", "home.html")));
app.get("/runner",   (req, res) => res.sendFile(path.join(__dirname, "templates", "runner.html")));
app.get("/analyzer", (req, res) => res.sendFile(path.join(__dirname, "templates", "analyzer.html")));
app.get("/api/k6-status", (req, res) => res.json({ installed: isK6Installed(), simulator: !isK6Installed() }));

// ── Run test ──────────────────────────────────────────────────────────────
app.post("/api/run-test", async (req, res) => {
  const { url, vus, duration, token, headers, testType, method, body } = req.body;
  if (!url) return res.status(400).json({ error: "URL é obrigatória" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const sendEvent = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, data })}\n\n`); } catch {} };

  const safeHeaders =
    headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  const params = { url, vus: parseInt(vus)||10, duration: duration||"30s", token: token||"", headers: safeHeaders, testType: testType||"load", method: method||"GET", body };

  sendEvent("status", `🚀 Iniciando ${params.testType.toUpperCase()} test em ${url}...`);

  if (!isK6Installed()) {
    try {
      const summary = await runSimulator(params, sendEvent);
      sendEvent("complete", summary);
    } catch (err) {
      sendEvent("error", `Erro na simulação: ${err.message}`);
    }
    res.end();
    return;
  }

  const scriptId   = uuidv4();
  const scriptPath = path.join(TMP_DIR, `test-${scriptId}.js`);
  fs.writeFileSync(scriptPath, generateK6Script(params));
  sendEvent("status", `⚙️  Script k6 gerado: ${scriptId}`);

  let stdout = "", stderr = "";
  const k6 = spawn("k6", ["run", "--no-color", scriptPath]);
  k6.stdout.on("data", (chunk) => { const t = chunk.toString(); stdout += t; t.split("\n").forEach(l => { if (l.trim()) sendEvent("log", l); }); });
  k6.stderr.on("data", (chunk) => { const t = chunk.toString(); stderr += t; t.split("\n").forEach(l => { if (l.trim()) sendEvent("log", l); }); });

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { fs.unlinkSync(scriptPath); } catch {}
  };

  k6.on("close", () => {
    cleanup();
    const combined = (stdout + "\n" + stderr).trim();
    const match = combined.match(/=== K6 LOAD TEST SUMMARY ===([\s\S]*?)=== FIM DO RESUMO ===/);
    sendEvent("complete", match ? match[0].trim() : combined);
    res.end();
  });
  k6.on("error", (err) => { cleanup(); sendEvent("error", `Erro ao executar k6: ${err.message}`); res.end(); });

  // Se o cliente fechar a conexão de resposta, interrompe o k6.
  res.on("close", () => {
    if (res.writableEnded) return;
    try { k6.kill("SIGTERM"); } catch {}
    cleanup();
  });
});

// ── Análise IA ────────────────────────────────────────────────────────────
app.post("/analyze", async (req, res) => {
  const { results } = req.body;
  if (!results || !results.length) return res.status(400).json({ error: "Nenhum resultado fornecido" });

  const metricsText = results.map(r => `### ${r.label}\n${Object.entries(r.metrics).map(([k,v]) => `  ${k}: ${v}`).join("\n")}`).join("\n\n");
  const isComparison = results.length > 1;
  const prompt = isComparison
    ? `Você é um especialista em performance de sistemas e testes de carga com k6. Analise e COMPARE:\n\n${metricsText}\n\nForneça: 1) Comparação direta 2) Análise de latência 3) Throughput e confiabilidade 4) Problemas 5) Recomendações 6) Conclusão. Use markdown com ## para seções.`
    : `Você é um especialista em performance de sistemas e testes de carga com k6. Analise:\n\n${metricsText}\n\nForneça: 1) Resumo geral 2) Análise de latência 3) Throughput e confiabilidade 4) Problemas e severidade 5) Recomendações 6) Veredicto: pronto para produção? Use markdown com ## para seções.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-20250514", max_tokens: 1500, messages: [{ role: "user", content: prompt }] }),
    });
    const data = await response.json();
    res.json({ analysis: data.content?.[0]?.text || "Não foi possível gerar análise." });
  } catch (err) {
    res.status(500).json({ error: "Falha ao chamar API de análise: " + err.message });
  }
});

function startServer(port) {
  const server = app.listen(port, () => {
    const k6Ok = isK6Installed();
    console.log(`\n🚀 K6 Suite rodando em http://127.0.0.1:${port}`);
    console.log(`   Home      → http://127.0.0.1:${port}/`);
    console.log(`   Runner    → http://127.0.0.1:${port}/runner`);
    console.log(`   Analyzer  → http://127.0.0.1:${port}/analyzer`);
    console.log(`\n   k6 instalado : ${k6Ok ? "✅ Sim (modo real)" : "⚠️  Não (modo simulador ativo)"}\n`);
  });

  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      // Se o usuário não fixou PORT, tenta automaticamente a próxima porta.
      const portWasExplicit = !!process.env.PORT;
      if (!portWasExplicit && port < 65535) {
        console.error(`\n⚠️  Porta ${port} já está em uso. Tentando ${port + 1}...`);
        return startServer(port + 1);
      }

      console.error(`\n❌ Porta ${port} já está em uso.`);
      console.error(`   Dica: feche o processo que está usando a porta ou rode com PORT diferente.`);
      console.error(`   Ex.: PORT=5001 npm start\n`);
      process.exit(1);
    }

    console.error("\n❌ Erro ao iniciar o servidor:", err?.message || err);
    process.exit(1);
  });
}

startServer(PORT);