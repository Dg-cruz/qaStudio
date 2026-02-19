# 🧪 QA Studio — Gerador Inteligente com Claude AI

---

## 📁 Estrutura do projeto

```
qa-studio/
├── backend/
│   ├── server.js          ← servidor Node.js (Express + Anthropic SDK)
│   │                         também serve o frontend — sem CORS!
│   ├── package.json
│   ├── .env.example
│   └── .gitignore
└── frontend/
    └── index.html         ← interface (NÃO abrir direto — usar via servidor)
```

---

## 🚀 Como rodar (passo a passo)

### 1. Obter sua chave da API Anthropic
Acesse https://console.anthropic.com/ → API Keys → criar nova chave (`sk-ant-...`)

### 2. Configurar o backend
```bash
cd backend
npm install
cp .env.example .env
```
Abra `.env` e cole sua chave:
```
ANTHROPIC_API_KEY=sk-ant-SUA_CHAVE_AQUI
```

### 3. Rodar o servidor
```bash
npm run dev
```

### 3.1 Rodar os testes do Cypress
# Na raiz do seu projeto Cypress
```
cp qa-studio.cy.js cypress/e2e/
npx cypress open
```

### 4. Acessar a ferramenta
Abra no navegador: **http://localhost:3001**

> ⚠️ Não abra o index.html diretamente — sempre acesse via http://localhost:3001

---

## 🔧 Extensões recomendadas no VS Code
- **REST Client** — testar as rotas da API
- **ESLint / Prettier** — qualidade de código

## 🛠 Tecnologias
- Frontend: HTML + CSS + JS puro
- Backend: Node.js + Express + Anthropic SDK
- IA: Claude claude-opus-4-5

## 🔒 Segurança
A chave da API fica apenas no `.env` (já no `.gitignore`). O frontend é servido pelo próprio backend — sem CORS e sem expor a chave.
