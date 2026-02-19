require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const { scrapeWithAuth } = require('./scraper-auth');
const PROFILES = JSON.parse(fs.readFileSync(require('path').join(__dirname, 'profiles.json'), 'utf8'));

const app = express();
const PORT = process.env.PORT || 3001;

// ─── Middlewares ─────────────────────────────────────────────────────────────
// CORS aberto — não precisa mais, o frontend é servido pelo mesmo servidor
app.use(cors());
app.use(express.json());

if (!process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY.includes('XXXXX')) {
  console.error('\n❌ ANTHROPIC_API_KEY não configurada!');
  console.error('👉 Copie .env.example para .env e adicione sua chave.\n');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Serve o frontend estático ────────────────────────────────────────────────
// O backend serve os arquivos da pasta ../frontend diretamente
// Assim não há CORS: tudo vem da mesma origem (localhost:3001)
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── Scraper ──────────────────────────────────────────────────────────────────
async function scrapeUrl(url) {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; QAStudio/1.0)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!response.ok) throw new Error(`Não foi possível acessar a URL (HTTP ${response.status})`);

  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json') || url.endsWith('.json')) {
    const json = await response.json();
    return { type: 'json', content: JSON.stringify(json, null, 2).slice(0, 12000) };
  }

  const html = await response.text();
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 12000);

  return { type: 'html', content: clean };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────
const buildPrompt = ({ mode, feature, context, priority, language, urlContext }) => {
  const lang = language === 'en-US' ? 'English' : 'Português do Brasil';
  const ctx = [context, urlContext].filter(Boolean).join('\n\n---\n\n') || 'Não informado';

  const prompts = {
    plan: `Você é um QA Engineer sênior especialista em testes de software. Gere um plano de testes completo e profissional.

Feature: ${feature}
Contexto: ${ctx}
Prioridade: ${priority}
Idioma de resposta: ${lang}

Estruture com as seções:
1. **Objetivo**
2. **Escopo** (incluso e excluído)
3. **Critérios de Entrada e Saída**
4. **Tipos de Teste** (funcional, regressão, usabilidade, performance, segurança — aplique os relevantes)
5. **Ambientes de Teste**
6. **Riscos e Dependências**
7. **Métricas de Sucesso**

Seja detalhado e profissional.`,

    script: `Você é um QA Engineer sênior. Gere casos de teste detalhados no formato de test scripts.

Feature: ${feature}
Contexto: ${ctx}
Prioridade: ${priority}
Idioma de resposta: ${lang}

Para cada caso de teste inclua:
- **ID** (ex: TC-001)
- **Título**
- **Pré-condições**
- **Passos** (numerados e detalhados)
- **Dados de Teste**
- **Resultado Esperado**
- **Status** (A Executar)

Cubra: happy path, fluxos alternativos, casos negativos e edge cases. Gere no mínimo 6 casos.`,

    bdd: `Você é um QA Engineer especialista em BDD. Gere cenários Gherkin profissionais.

Feature: ${feature}
Contexto: ${ctx}
Prioridade: ${priority}
Idioma de resposta: ${lang}

Use o formato padrão Gherkin:
- Feature description
- Background (se aplicável)
- Scenarios com Given / When / Then / And / But
- Scenario Outline com Examples para casos parametrizados

Use linguagem de domínio, seja específico e cubra fluxos positivos, negativos e edge cases. Gere no mínimo 5 cenários.`,

    bug: `Você é um QA Engineer sênior. Gere um relatório de bug completo e profissional.

Bug / Problema: ${feature}
Descrição: ${ctx}
Prioridade: ${priority}
Idioma de resposta: ${lang}

Estruture com:
1. **Título** — resumo claro e objetivo
2. **Ambiente** — versão, SO, browser, device
3. **Severidade e Prioridade**
4. **Descrição** (atual vs esperado)
5. **Passos para Reproduzir**
6. **Resultado Atual**
7. **Resultado Esperado**
8. **Evidências** (o que capturar)
9. **Impacto no Usuário / Negócio**
10. **Possível Causa Raiz**
11. **Workaround** (se existir)`,
    cypress: `Você é um QA Engineer sênior especialista em automação com Cypress. Gere um arquivo de testes Cypress completo e pronto para executar.

Feature: ${feature}
Contexto: ${ctx}
URL base (se disponível no contexto): use cy.visit() com o caminho correto

REGRAS OBRIGATÓRIAS:
- Gere APENAS código JavaScript válido — nenhum texto fora do código
- Use describe() agrupando os it() por contexto
- Seletores: prefira data-cy attributes. Se não souber, use texto visível com cy.contains() ou IDs/classes semânticos
- Cubra: happy path, validações de campos obrigatórios, fluxos negativos, edge cases
- Use beforeEach() para setup comum (cy.visit, login, etc.)
- Use cy.intercept() para mockar chamadas de API onde fizer sentido
- Adicione comentários explicativos em cada bloco
- Crie Custom Commands com Cypress.Commands.add() se houver ações repetidas
- Gere no mínimo 6 testes (it blocks) distribuídos em contextos
- Inclua no topo: /// <reference types=cypress />

Estrutura:
/// <reference types=cypress />

Cypress.Commands.add('nomeDoCommand', (params) => { /* se necessário */ })

describe('[Feature] ${feature}', () => {
  beforeEach(() => { cy.visit('/caminho') })

  context('Happy Path', () => {
    it('deve fazer X com sucesso', () => { ... })
  })
  context('Validações', () => {
    it('deve exibir erro quando campo Y estiver vazio', () => { ... })
  })
  context('Fluxos Negativos', () => {
    it('não deve permitir Z quando ...', () => { ... })
  })
})

Retorne SOMENTE o código, sem nenhum texto antes ou depois.`,

  };

  return prompts[mode] || prompts.plan;
};

// ─── GET /health ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'QA Studio Backend rodando ✅' });
});

// ─── POST /api/analyze-url ────────────────────────────────────────────────────
app.post('/api/analyze-url', async (req, res) => {
  const { url } = req.body;
  if (!url || !url.startsWith('http')) return res.status(400).json({ error: 'URL inválida. Use http:// ou https://' });

  try {
    const scraped = await scrapeUrl(url);

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,    
      messages: [{
        role: 'user',
        content: `Você é um QA Engineer analisando uma página para criar testes de software.

Analise o conteúdo abaixo (tipo: ${scraped.type}) e extraia informações para QA.
URL: ${url}

Conteúdo:
---
${scraped.content}
---

Responda APENAS com JSON válido, sem markdown, sem explicações:
{
  "feature": "nome curto da funcionalidade principal (max 80 chars)",
  "context": "descrição detalhada: o que a página faz, fluxos, campos, interações, regras de negócio (max 800 chars)",
  "suggestedMode": "plan | script | bdd | bug",
  "pageTitle": "título da página ou sistema"
}`
      }]
    });

    const rawText = message.content[0].text.trim().replace(/```json|```/g, '').trim();
    const extracted = JSON.parse(rawText);
    res.json({ success: true, url, ...extracted });

  } catch (err) {
    console.error('Erro em /api/analyze-url:', err.message);
    if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED') || err.message.includes('timeout')) {
      return res.status(422).json({ error: 'Não foi possível acessar a URL. Verifique se ela é pública e acessível.' });
    }
    if (err instanceof SyntaxError) return res.status(500).json({ error: 'Erro ao processar resposta da IA. Tente novamente.' });
    res.status(500).json({ error: err.message || 'Erro interno.' });
  }
});


// Armazena sessões de 2FA pendentes em memória
// { sessionId -> { resolve, reject } }
const pending2FA = new Map();

// ─── POST /api/analyze-url-auth ───────────────────────────────────────────────
app.post('/api/analyze-url-auth', async (req, res) => {
  const { loginUrl, targetUrl, username, password, totpSecret, selectors, waitAfterLogin, profileId } = req.body;

  const profile = profileId && PROFILES[profileId] ? PROFILES[profileId] : {};

  const finalLoginUrl  = loginUrl    || profile.loginUrl;
  const finalTargetUrl = targetUrl   || profile.loginUrl;
  const finalUsername  = username    || process.env.AUTH_DEFAULT_USERNAME;
  const finalPassword  = password    || process.env.AUTH_DEFAULT_PASSWORD;
  const finalTotp      = totpSecret  || profile.totpSecret || process.env.AUTH_DEFAULT_TOTP_SECRET;
  const finalSelectors = { ...(profile.selectors || {}), ...(selectors || {}) };
  const finalWait      = waitAfterLogin || profile.waitAfterLogin || 3000;
  // Se não tiver secret key, usa modo manual (modal)
  const useManual2FA   = !finalTotp && (profile.manual2FA !== false);

  if (!finalLoginUrl)                    return res.status(400).json({ error: 'loginUrl é obrigatório.' });
  if (!finalUsername || !finalPassword)  return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });

  // Gera um ID de sessão único para este fluxo de autenticação
  const sessionId = `auth_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // Configura SSE para comunicação em tempo real com o frontend
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    send('status', { message: '🔐 Abrindo browser e fazendo login...' });

    // Callback chamado pelo scraper quando detecta tela de 2FA manual
    const onNeed2FA = useManual2FA
      ? () => new Promise((resolve, reject) => {
          // Registra a sessão pendente
          pending2FA.set(sessionId, { resolve, reject });
          // Notifica o frontend para abrir o modal
          send('need2FA', { sessionId, message: 'Digite o código do seu app autenticador.' });
        })
      : undefined;

    const { content, title, finalUrl } = await scrapeWithAuth({
      loginUrl:       finalLoginUrl,
      targetUrl:      finalTargetUrl,
      username:       finalUsername,
      password:       finalPassword,
      totpSecret:     finalTotp || undefined,
      onNeed2FA,
      selectors:      finalSelectors,
      waitAfterLogin: finalWait,
    });

    if (!content || content.length < 50) {
      throw new Error('Conteúdo extraído está vazio. Verifique se o login funcionou.');
    }

    send('status', { message: '🤖 Login OK! Analisando conteúdo com IA...' });

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages: [{
        role: 'user',
        content: `Você é um QA Engineer analisando uma página autenticada para criar testes.

URL: ${finalUrl}
Título: ${title}

Conteúdo:
---
${content}
---

Responda APENAS com JSON válido, sem markdown:
{
  "feature": "nome curto da funcionalidade principal (max 80 chars)",
  "context": "descrição detalhada: fluxos, campos, interações, regras de negócio (max 800 chars)",
  "suggestedMode": "plan | script | bdd | bug",
  "pageTitle": "${title}"
}`
      }]
    });

    const extracted = JSON.parse(
      message.content[0].text.trim().replace(/```json|```/g, '').trim()
    );

    // Envia resultado final via SSE
    send('done', { success: true, url: finalUrl, authenticated: true, ...extracted });
    res.end();

  } catch (err) {
    console.error('[/api/analyze-url-auth]', err.message);
    // Limpa sessão pendente em caso de erro
    const pending = pending2FA.get(sessionId);
    if (pending) { pending.reject(err); pending2FA.delete(sessionId); }
    send('error', { error: err.message });
    res.end();
  }
});

// ─── GET /api/profiles ────────────────────────────────────────────────────────
app.get('/api/profiles', (req, res) => {
  const safe = Object.entries(PROFILES)
    .filter(([k]) => !k.startsWith('_'))
    .map(([id, p]) => ({ id, name: p.name, loginUrl: p.loginUrl, manual2FA: !!p.manual2FA }));
  res.json(safe);
});

// ─── POST /api/generate ───────────────────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { mode, feature, context, priority, language, urlContext } = req.body;

  if (!feature?.trim()) return res.status(400).json({ error: 'O campo "feature" é obrigatório.' });
  if (!['plan', 'script', 'bdd', 'bug', 'cypress'].includes(mode)) return res.status(400).json({ error: 'Modo inválido.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 16000,
      messages: [{ role: 'user', content: buildPrompt({ mode, feature, context, priority, language, urlContext }) }]
    });

    stream.on('text', t => res.write(`data: ${JSON.stringify({ text: t })}\n\n`));
    stream.on('message', () => { res.write(`data: ${JSON.stringify({ done: true })}\n\n`); res.end(); });
    stream.on('error', e => { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); });

  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: 'Erro interno do servidor.' })}\n\n`);
    res.end();
  }
});

// ─── POST /api/submit-2fa ────────────────────────────────────────────────────
// Recebe o código digitado pelo usuário no modal e desbloqueia o scraper
app.post('/api/submit-2fa', (req, res) => {
  const { sessionId, code } = req.body;

  if (!sessionId || !code) {
    return res.status(400).json({ error: 'sessionId e code são obrigatórios.' });
  }

  const pending = pending2FA.get(sessionId);
  if (!pending) {
    return res.status(404).json({ error: 'Sessão não encontrada ou já expirada.' });
  }

  pending2FA.delete(sessionId);
  pending.resolve(String(code).trim());

  res.json({ ok: true });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ QA Studio rodando em → http://localhost:${PORT}`);
  console.log(`   Abra esse link no navegador para usar a ferramenta.\n`);
});
