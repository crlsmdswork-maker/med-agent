# med-agent: agente de defesa de MED (Woovi BaaS)

Recebe MEDs das subcontas Woovi, investiga a venda nos dados do gateway com o Claude, decide se vale defender e envia a carta + evidências pela API da Woovi.

## Arquitetura

```
           ┌────────────── Cloudflare (gateway) ──────────────┐
           │  Worker "gateway-agent-api"  (cloudflare-gateway-api/worker.ts)
           │  GET /agent/orders/... · /agent/attachments/...  │  (só leitura, token)
           └───────────────────────▲──────────────────────────┘
                                   │ HTTPS
┌──────────────────────────── Railway (agentes) ─────────────────────────────┐
│  med-agent (web)          webhook da Woovi · API de revisão · arquivos      │
│  (no mesmo serviço)       a cada 15 min: pega MEDs que o webhook perdeu     │
│  Postgres                 casos, decisões, resultados                       │
└──────────────────────────────▲──────────────────────────────▲──────────────┘
                               │ webhooks OPENPIX:DISPUTE_*    │ POST /files, /dispute/{id}/evidence
                               └──────────── Woovi ────────────┘
```

Fluxo de um caso: `RECEIVED → ANALYZING → AWAITING_REVIEW → (aprovação) → SUBMITTED → CLOSED`.
Se o agente não recomendar defesa: `NOT_DEFENDED` (aceitar devolução ou risco de fraude do seller).

## Deploy no Railway (passo a passo)

1. **Suba este código num repositório privado no GitHub.**
2. No Railway: **New Project → Deploy from GitHub repo** → escolha o repositório. Ele detecta o `Dockerfile`. Renomeie o serviço para `med-agent`.
3. No mesmo projeto: **+ New → Database → PostgreSQL**.
4. **Project Settings → Shared Variables**: cadastre as variáveis do `.env.example` (menos `DATABASE_URL`, `PORT` e `PUBLIC_BASE_URL`).
5. No serviço `med-agent` → **Variables**:
   - compartilhe as Shared Variables com o serviço;
   - adicione `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`.
6. `med-agent` → **Settings**:
   - **Networking → Generate Domain** (vira a URL dos webhooks);
   - **Deploy → Healthcheck Path** = `/health`.
7. A varredura de disputas roda dentro do próprio serviço a cada 15 min (`POLL_INTERVAL_MINUTES`, `0` desliga). Não precisa de serviço de cron.
8. Teste: `https://SEU_DOMINIO/health` deve responder `{"ok":true}`.

> O Railway descontinuou o `railway.json`/`railway.toml` (serviços novos não aceitam mais), por isso a configuração é pelo painel + Dockerfile.

## Lado da Cloudflare (gateway)

Em `cloudflare-gateway-api/worker.ts` tem o esqueleto do Worker que expõe, **só para leitura**, os dados que o agente precisa. Preencha os `TODO` com as consultas ao seu banco e publique:

```bash
cd cloudflare-gateway-api
npx wrangler deploy
npx wrangler secret put AGENT_API_TOKEN   # mesmo valor de GATEWAY_API_TOKEN no Railway
```

No Railway, aponte `GATEWAY_API_URL` para a URL desse Worker. **Enquanto `GATEWAY_API_URL` estiver vazia, o agente usa dados de exemplo e "defende" tudo. Não use assim em produção.**

## Webhooks na Woovi

Para cada subconta, com o **AppID da subconta**, registre os 4 eventos apontando para o domínio do Railway:

```bash
curl -X POST https://api.woovi.com/api/v1/webhook \
  -H "Authorization: APPID_DA_SUBCONTA" -H "Content-Type: application/json" \
  -d '{"webhook":{"name":"med-agent","event":"OPENPIX:DISPUTE_CREATED",
       "url":"https://SEU_DOMINIO/webhook/woovi/seller-001",
       "authorization":"token-que-voce-escolheu","isActive":true}}'
# repita para OPENPIX:DISPUTE_ACCEPTED, OPENPIX:DISPUTE_REJECTED, OPENPIX:DISPUTE_CANCELED
```

`seller-001` e o token precisam bater com a entrada da subconta em `WOOVI_ACCOUNTS`. Registrar com a credencial errada não dá erro, só silêncio. Se os eventos de disputa não existirem em subconta BaaS (`GET /api/v1/webhook/events`), o poller cobre.

## Operação: API de revisão (Bearer ADMIN_TOKEN)

| Método | Rota | O quê |
|---|---|---|
| GET | `/cases?status=AWAITING_REVIEW` | fila, ordenada por prazo |
| GET | `/cases/:id` | caso com decisão, raciocínio e carta |
| POST | `/cases/:id/approve` | envia (body opcional `{ "letter": "carta editada" }`) |
| POST | `/cases/:id/dismiss` | não defender |
| POST | `/cases/:id/retry` | reanalisar |

## Travas de segurança

- O agente só pode citar anexos que a API do gateway retornou; o código rejeita qualquer outro e manda ele corrigir.
- `DEFEND` sem carta ou sem evidência é recusado.
- Casos com sinal de fraude do seller viram `ESCALATE_FRAUD_RISK` e nunca são defendidos sozinhos.
- Trocas de status atômicas no Postgres: webhook repetido, poller e duplo clique em "aprovar" não geram envio duplicado.
- Casos presos num restart/deploy são retomados automaticamente.
- `SUBMIT_MODE=review` por padrão. Passe para `auto` só depois de medir o acerto em revisão.

## Rodando localmente

```bash
cp .env.example .env    # aponte DATABASE_URL para um Postgres local
npm install
npm run dev             # servidor
npm run poll:dev        # poller
```

## Pendências para produção

- Validar `x-webhook-signature` (RSA-SHA256) além do header `authorization`.
- Painel web para a fila de revisão.
- Alerta (Slack/e-mail) para casos perto do prazo e para `ESCALATE_FRAUD_RISK`.
