/**
 * scraper-auth.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scraping autenticado com suporte a:
 *   - SPAs (Vue, React, Angular)
 *   - Login por formulário
 *   - 2FA automático via TOTP secret key
 *   - 2FA manual via modal no frontend (callback onNeed2FA)
 *   - Botão de submit separado para o formulário de 2FA
 * ─────────────────────────────────────────────────────────────────────────────
 */

const puppeteer = require('puppeteer');
const { authenticator } = require('otplib');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function cleanHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 12000);
}

function generateTOTP(secret) {
  try {
    return authenticator.generate(secret.replace(/\s/g, '').toUpperCase());
  } catch (err) {
    throw new Error(`Erro ao gerar TOTP: ${err.message}`);
  }
}

async function waitForReady(page, selectors, timeout = 15000) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const sel of list) {
      try {
        const ready = await page.evaluate((s) => {
          // IDs começando com número precisam de getAttribute, não querySelector direto
          let el;
          try {
            el = document.querySelector(s);
          } catch (_) {
            // fallback: busca por id via getAttribute se o seletor for #<algo>
            const idMatch = s.match(/^#(.+)$/);
            if (idMatch) el = document.getElementById(idMatch[1]);
          }
          if (!el) return false;
          const rect  = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            rect.width > 0 && rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display    !== 'none' &&
            style.opacity    !== '0' &&
            !el.disabled
          );
        }, sel);
        if (ready) return sel;
      } catch (_) {}
    }
    await sleep(300);
  }
  throw new Error(`Elemento não ficou interativo: ${list.join(' | ')}`);
}

async function fillField(page, selector, value) {
  await page.evaluate((sel) => {
    // Suporte a IDs com números (ex: #2fa_password) via getElementById
    let el;
    try {
      el = document.querySelector(sel);
    } catch (_) {
      const idMatch = sel.match(/^#(.+)$/);
      if (idMatch) el = document.getElementById(idMatch[1]);
    }
    if (!el) return;
    el.focus();
    el.value = '';
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, selector);
  await sleep(150);

  // Para digitar em campos com ID numérico, usa evaluate direto
  for (const char of value) {
    await page.evaluate((sel, ch) => {
      let el;
      try { el = document.querySelector(sel); } catch (_) {
        const m = sel.match(/^#(.+)$/);
        if (m) el = document.getElementById(m[1]);
      }
      if (!el) return;
      el.value += ch;
      el.dispatchEvent(new KeyboardEvent('keypress', { key: ch, bubbles: true }));
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, selector, char);
    await sleep(60);
  }
  await sleep(200);
}

async function safeClick(page, selector) {
  // Clica usando getElementById para IDs com números
  const clicked = await page.evaluate((sel) => {
    let el;
    try { el = document.querySelector(sel); } catch (_) {
      const m = sel.match(/^#(.+)$/);
      if (m) el = document.getElementById(m[1]);
    }
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  }, selector);

  if (!clicked) {
    try { await page.click(selector); } catch (_) {
      await page.keyboard.press('Enter');
    }
  }
}

async function clickLoginSubmit(page, submitSelector) {
  try {
    await waitForReady(page, [submitSelector], 3000);
    await safeClick(page, submitSelector);
    return;
  } catch (_) {}

  await page.evaluate(() => {
    const texts = ['fazer login', 'entrar', 'login', 'sign in'];
    for (const el of document.querySelectorAll('button, input[type="submit"]')) {
      if (texts.some(t => (el.textContent || el.value || '').toLowerCase().includes(t))) {
        el.click(); return;
      }
    }
  });
}

async function click2FASubmit(page, totpSubmitSelector) {
  // 1. Tenta o seletor específico do profiles.json (ex: "#2fa_button")
  if (totpSubmitSelector) {
    try {
      await safeClick(page, totpSubmitSelector);
      console.log(`[auth] Botão 2FA clicado: "${totpSubmitSelector}"`);
      return;
    } catch (_) {}
  }

  // 2. Busca pelo ng-click do Angular ou pelo id
  const clicked = await page.evaluate(() => {
    // Tenta getElementById direto (funciona com IDs numéricos)
    const byId = document.getElementById('2fa_button');
    if (byId) { byId.click(); return true; }

    // Busca por atributo ng-click com ajaxTwoFaLogin
    const byNgClick = document.querySelector('[ng-click*="TwoFa"], [ng-click*="twoFa"]');
    if (byNgClick) { byNgClick.click(); return true; }

    // Busca botão visível pelo texto
    const texts = ['fazer login', 'confirmar', 'verificar', 'enviar', 'ok'];
    for (const el of document.querySelectorAll('button')) {
      const t = (el.textContent || '').toLowerCase().trim();
      const style = window.getComputedStyle(el);
      const visible = style.display !== 'none' && !el.classList.contains('ng-hide');
      if (visible && texts.some(tx => t.includes(tx))) {
        el.click(); return true;
      }
    }
    return false;
  });

  if (!clicked) await page.keyboard.press('Enter');
}

// Detecta tela de 2FA sem usar seletores CSS inválidos
async function is2FAPage(page) {
  return page.evaluate(() => {
    // Verifica pelo getElementById (evita problema com IDs numéricos no querySelector)
    const form2fa = document.getElementById('2fa-form');
    if (form2fa) {
      const style = window.getComputedStyle(form2fa);
      if (style.display !== 'none' && !form2fa.classList.contains('ng-hide')) return true;
    }

    // Verifica campo #2fa_password visível
    const field2fa = document.getElementById('2fa_password');
    if (field2fa) {
      const style = window.getComputedStyle(field2fa);
      if (style.display !== 'none' && style.visibility !== 'hidden') return true;
    }

    // Verifica por texto na página
    const body = (document.body?.innerText || '').toLowerCase();
    const keywords = [
      'autenticação de dois', 'two-factor', 'código de autenticação',
      'verificação em duas', 'authenticator', 'insira o código'
    ];
    return keywords.some(k => body.includes(k));
  });
}

async function findOTPField(page, customSelector) {
  // Tenta o seletor customizado primeiro
  if (customSelector) {
    try { return await waitForReady(page, [customSelector], 3000); } catch (_) {}
  }

  // Tenta via getElementById (seguro para IDs com números)
  const foundById = await page.evaluate(() => {
    const ids = ['2fa_password', 'otp', 'totp', 'code', 'token'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) {
        const style = window.getComputedStyle(el);
        if (style.display !== 'none') return `#${id}`;
      }
    }
    return null;
  });
  if (foundById) return foundById;

  // Fallback por atributos seguros
  const candidates = [
    'input[maxlength="6"]',
    'input[name*="otp"]',
    'input[placeholder*="código"]',
    'input[placeholder*="2FA"]',
    'input[placeholder*="Código"]',
  ];
  for (const sel of candidates) {
    try { return await waitForReady(page, [sel], 2000); } catch (_) {}
  }

  throw new Error('Campo de código 2FA não encontrado. Defina em profiles.json → selectors.totpField');
}

// ─── Função principal ─────────────────────────────────────────────────────────

async function scrapeWithAuth(opts) {
  const {
    loginUrl,
    targetUrl,
    username,
    password,
    totpSecret,
    onNeed2FA,
    selectors = {},
    waitAfterLogin = 4000,
  } = opts;

  if (!loginUrl || !targetUrl || !username || !password) {
    throw new Error('loginUrl, targetUrl, username e password são obrigatórios.');
  }

  const usernameCandidates = selectors.usernameField ? [selectors.usernameField] : [
    'input[type="email"]', 'input[name="email"]', 'input[name="username"]',
    'input[name="user"]', 'input[id*="email"]', 'input[id*="user"]',
    'input[id*="login"]', 'input[placeholder*="usuário"]',
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])',
  ];

  const passwordSel   = selectors.passwordField    || 'input[type="password"]';
  const submitSel     = selectors.submitButton     || 'button[type="submit"]';
  const totpSubmitSel = selectors.totpSubmitButton || null;

  let browser;

  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1280,800'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 800 });

    await page.setRequestInterception(true);
    page.on('request', req => {
      ['image', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue();
    });

    // ── 1. Abre login ─────────────────────────────────────────────────────────
    console.log(`[auth] Abrindo: ${loginUrl}`);
    await page.goto(loginUrl, { waitUntil: 'networkidle2', timeout: 25000 });
    await sleep(2500);

    // ── 2. Usuário ────────────────────────────────────────────────────────────
    let userSel;
    try {
      userSel = await waitForReady(page, usernameCandidates, 12000);
    } catch (_) {
      throw new Error(`Campo de usuário não encontrado. URL: ${page.url()}`);
    }
    console.log(`[auth] Campo usuário: "${userSel}"`);
    await fillField(page, userSel, username);

    // ── 3. Senha ──────────────────────────────────────────────────────────────
    await waitForReady(page, [passwordSel], 5000).catch(() => {
      throw new Error(`Campo de senha não encontrado. Seletor: "${passwordSel}"`);
    });
    await fillField(page, passwordSel, password);

    // ── 4. Submit login ───────────────────────────────────────────────────────
    console.log(`[auth] Submetendo login...`);
    await clickLoginSubmit(page, submitSel);
    await sleep(3000); // Angular troca ng-show sem navegar — aguarda renderização

    // ── 5. Verifica 2FA ───────────────────────────────────────────────────────
    const needs2FA = await is2FAPage(page);
    console.log(`[auth] 2FA necessário: ${needs2FA ? 'sim' : 'não'}`);

    if (needs2FA) {
      let code;

      if (totpSecret) {
        code = generateTOTP(totpSecret);
        console.log(`[auth] Código TOTP gerado automaticamente.`);
      } else if (typeof onNeed2FA === 'function') {
        console.log(`[auth] Aguardando código 2FA manual (timeout: 2 min)...`);
        code = await Promise.race([
          onNeed2FA(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Tempo esgotado aguardando o código 2FA.')), 120000)
          ),
        ]);
        if (!code || String(code).trim().length !== 6) {
          throw new Error('Código 2FA inválido — deve ter exatamente 6 dígitos.');
        }
        code = String(code).trim();
        console.log(`[auth] Código 2FA recebido.`);
      } else {
        throw new Error('2FA detectado. Informe a TOTP Secret Key ou use o modo manual.');
      }

      const otpSel = await findOTPField(page, selectors.totpField);
      console.log(`[auth] Campo OTP: "${otpSel}"`);

      await sleep(500);
      await fillField(page, otpSel, code);
      await sleep(500);

      console.log(`[auth] Submetendo 2FA...`);
      await click2FASubmit(page, totpSubmitSel);
      await sleep(waitAfterLogin);

      if (await is2FAPage(page)) {
        throw new Error('Código 2FA rejeitado. Verifique se o código está correto e não expirou.');
      }
      console.log(`[auth] 2FA aceito!`);

    } else {
      await sleep(waitAfterLogin);
      const cur = page.url();
      const stillOnLogin = cur.includes('/login') || cur.includes('#/login') || cur === loginUrl;
      if (stillOnLogin) {
        const errMsg = await page.evaluate(() => {
          // Verifica mensagens de erro visíveis (sem ng-hide)
          const candidates = [
            document.getElementById('login_fail'),
            document.getElementById('2fa_fail'),
            document.querySelector('[class*="error"]'),
            document.querySelector('[role="alert"]'),
          ];
          for (const el of candidates) {
            if (el && !el.classList.contains('ng-hide') && el.textContent?.trim()) {
              return el.textContent.trim();
            }
          }
          return null;
        });
        throw new Error(errMsg ? `Login falhou: ${errMsg}` : 'Login falhou — verifique as credenciais.');
      }
    }

    console.log(`[auth] Autenticado. URL: ${page.url()}`);

    // ── 6. Navega para URL alvo ───────────────────────────────────────────────
    let finalUrl = page.url();
    if (targetUrl !== loginUrl) {
      console.log(`[auth] Navegando para: ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await sleep(2500);
      finalUrl = page.url();
    }

    // ── 7. Extrai conteúdo ────────────────────────────────────────────────────
    const title   = await page.title();
    const content = cleanHtml(await page.content());
    console.log(`[auth] Extraído: ${content.length} chars | "${title}"`);

    return { content, title, finalUrl };

  } finally {
    await browser?.close().catch(() => {});
  }
}

module.exports = { scrapeWithAuth };