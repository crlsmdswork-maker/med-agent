// Configuração central. Tudo vem de variáveis de ambiente (veja .env.example).

export interface WooviAccount {
  /** Chave interna sua (ex.: id do seller). Vai no path do webhook: /webhook/woovi/:accountKey */
  key: string;
  /** AppID da subconta BaaS na Woovi (cada subconta tem o seu). */
  appId: string;
  /** Token que você escolheu no campo `authorization` ao registrar o webhook. */
  webhookAuth: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Variável de ambiente ausente: ${name}`);
  return v;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  wooviBaseUrl: process.env.WOOVI_BASE_URL ?? "https://api.woovi.com", // sandbox: https://api.woovi-sandbox.com
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
  /** Railway injeta DATABASE_URL quando você referencia o Postgres: ${{Postgres.DATABASE_URL}} */
  databaseUrl: required("DATABASE_URL"),

  /** API que o gateway (Cloudflare) expõe para o agente ler pedidos/entregas. Vazio = dados de exemplo. */
  gatewayApiUrl: process.env.GATEWAY_API_URL ?? "",
  gatewayApiToken: process.env.GATEWAY_API_TOKEN ?? "",

  /** URL pública deste serviço no Railway (ex.: https://med-agent-production.up.railway.app). */
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : ""),

  /**
   * Modo de envio:
   *  - "review": o agente prepara a defesa e um humano aprova (POST /cases/:id/approve)
   *  - "auto":   envia sozinho quando decisão = DEFEND e confiança >= AUTO_SUBMIT_MIN_CONFIDENCE
   * Comece em "review".
   */
  submitMode: (process.env.SUBMIT_MODE ?? "review") as "review" | "auto",
  autoSubmitMinConfidence: Number(process.env.AUTO_SUBMIT_MIN_CONFIDENCE ?? 0.85),

  /**
   * A página de MED BaaS da Woovi fala em 3 dias para enviar evidências; a central de ajuda fala em 5.
   * Usamos o menor para não perder prazo.
   */
  evidenceDeadlineHours: Number(process.env.EVIDENCE_DEADLINE_HOURS ?? 72),

  /** Token para a API interna de revisão (aprovar/rejeitar casos). */
  adminToken: required("ADMIN_TOKEN"),

  /** JSON: [{ "key": "seller-001", "appId": "...", "webhookAuth": "..." }] */
  accounts: JSON.parse(process.env.WOOVI_ACCOUNTS ?? "[]") as WooviAccount[],
};

export function accountByKey(key: string): WooviAccount | undefined {
  return config.accounts.find((a) => a.key === key);
}
