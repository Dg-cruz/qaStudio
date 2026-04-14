# K6 Suite — Performance Testing

Suite completa para rodar e analisar testes de carga com k6, direto pelo navegador.

## Estrutura

```
k6-runner/
├── Server.js          # Backend Express (Node.js) — ver nota abaixo
├── package.json
├── templates/
│   ├── home.html      # Página inicial com os 2 botões
│   ├── index.html     # Página estática adicional (não servida por rota no Server.js atual)
│   ├── runner.html    # Formulário para rodar testes k6
│   └── analyzer.html  # K6 Analyzer com análise de IA
├── docs/              # Wiki e ERS (especificação, guias detalhados)
└── tmp/               # Scripts k6 temporários (auto-criado)
```

**Nota (maiúsculas no nome do ficheiro):** o ficheiro de entrada no repositório é `Server.js`. Em `package.json`, os scripts usam `server.js`. Em Windows isto costuma funcionar; em sistemas de ficheiros **sensíveis a maiúsculas**, `npm start` pode falhar — use `node Server.js` ou alinhe o nome com o script. Detalhes em `docs/wiki/instalacao-execucao-e-variaveis-de-ambiente.md`.

## Pré-requisitos

- [Node.js](https://nodejs.org/) v18+
- [k6](https://k6.io/docs/getting-started/installation/) instalado e no PATH (opcional para explorar a UI: sem k6, a app usa um **simulador** integrado; resultados não equivalem a um relatório k6 real — ver `docs/wiki/modo-k6-real-vs-simulador.md`)

### Instalar k6

**macOS:**
```bash
brew install k6
```

**Linux (Debian/Ubuntu):**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

**Windows:**
```bash
winget install k6
```

## Instalação e execução

```bash
cd k6-runner
npm install
npm start
```

Acesse: **http://127.0.0.1:5000** (porta padrão; se estiver ocupada e `PORT` não estiver definida, o servidor pode tentar a seguinte automaticamente).

## Variáveis de ambiente

| Variável | Efeito |
|----------|--------|
| `PORT` | Porta HTTP (omissão: **5000**). |
| `ANTHROPIC_API_KEY` | Necessária para `POST /analyze` (análise por IA). |

O projeto usa `dotenv`: pode definir variáveis num ficheiro `.env` na raiz do `k6-runner` (não versionar segredos). Mais contexto em `docs/wiki/instalacao-execucao-e-variaveis-de-ambiente.md` e `docs/wiki/analyzer-analise-por-ia.md`.

## Documentação

Guias modulares e especificação: pasta **`docs/`** (por exemplo `docs/wiki/visao-geral-e-navegacao.md` e `docs/ERS-k6-runner.md`).

## Páginas

| Rota        | Descrição                                      |
|-------------|------------------------------------------------|
| `/`         | Home — escolha entre Runner e Analyzer         |
| `/runner`   | Formulário para configurar e rodar testes k6   |
| `/analyzer` | K6 Analyzer — cole métricas e analise com IA  |

## Tipos de teste disponíveis

| Tipo       | Objetivo                                      |
|------------|-----------------------------------------------|
| Smoke      | Validação básica com carga mínima (1 VU/30s)  |
| Load       | Carga normal esperada em produção             |
| Stress     | Encontra o ponto de ruptura do sistema        |
| Spike      | Simula picos súbitos de tráfego               |
| Soak       | Estabilidade e memory leaks ao longo do tempo |
| Breakpoint | Carga crescente até o sistema falhar          |

## Como funciona

1. Acesse `/runner`, preencha URL, método, VUs, duração e tipo de teste
2. Clique em **RODAR** — o backend gera um script k6 e executa
3. Acompanhe o output em tempo real no terminal integrado
4. Copie o resumo gerado e cole no **K6 Analyzer** para análise de IA

## API

- `GET  /api/k6-status`   — JSON: `installed` (k6 no PATH), `simulator` (true quando não há k6 e o próximo run usa simulador)
- `POST /api/run-test`    — executa teste (SSE streaming)
- `POST /analyze`         — análise IA das métricas (corpo JSON conforme UI; requer `ANTHROPIC_API_KEY`)

A aplicação não tem login: quem alcançar a URL do servidor na rede pode usar estas rotas. Boas práticas em `docs/wiki/seguranca-privacidade-e-boas-praticas.md`.
