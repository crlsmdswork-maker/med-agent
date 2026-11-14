// Esqueleto do Worker que o GATEWAY (na Cloudflare) expõe para os agentes no Railway.
// Rotas só de leitura, protegidas por token. Preencha os TODOs com as consultas ao seu banco
// (D1, Hyperdrive/Postgres, ou a API interna do gateway). Os formatos de resposta estão em
// ../src/gateway-data.ts (OrderInfo, FulfillmentInfo, SupportInfo, RiskInfo).
//
// wrangler.toml (exemplo):
//   name = "gateway-agent-api"
//   main = "worker.ts"
//   compatibility_date = "2026-11-01"
//   [[d1_databases]]            # se usar D1
//   binding = "DB"
//   database_name = "gateway"
//   database_id = "..."
// Segredo: npx wrangler secret put AGENT_API_TOKEN   (o mesmo valor de GATEWAY_API_TOKEN no Railway)

export interface Env {
  AGENT_API_TOKEN: string;
  DB?: D1Database; // se usar D1
  // BUCKET?: R2Bucket; // se os anexos (NF, prints) ficam no R2
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "GET") return json({ error: "method" }, 405);
    if (req.headers.get("authorization") !== `Bearer ${env.AGENT_API_TOKEN}`) return json({ error: "unauthorized" }, 401);

    const url = new URL(req.url);
    const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["agent", ...]
    if (p[0] !== "agent") return json({ error: "not found" }, 404);

    // GET /agent/orders/by-e2e/:endToEndId -> OrderInfo | 404
    if (p[1] === "orders" && p[2] === "by-e2e" && p[3]) {
      // TODO: buscar o pedido pago com este endToEndId (Pix), com comprador, pagador, seller e anexos.
      // Ex. D1: const row = await env.DB!.prepare("SELECT ... FROM orders WHERE pix_e2e_id = ?").bind(p[3]).first();
      return json({ error: "not found" }, 404);
    }

    // GET /agent/orders/:orderId/(fulfillment|support|risk)
    if (p[1] === "orders" && p[2] && p[3]) {
      const orderId = p[2];
      switch (p[3]) {
        case "fulfillment":
          // TODO: status de entrega/acesso + eventos (rastreio, logins na área de membros) + anexos
          return json({ status: "UNKNOWN", events: [], attachments: [] });
        case "support":
          // TODO: mensagens comprador <-> seller/suporte + prints
          return json({ messages: [], attachments: [] });
        case "risk":
          // TODO: compras/MEDs anteriores do pagador, taxa de MED do seller (30d), flags
          return json({ payerPreviousOrders: 0, payerPreviousMeds: 0, sellerMedRate30d: 0, sellerOpenMeds: 0, flags: [] });
      }
      void orderId;
    }

    // GET /agent/attachments/:attachmentId -> bytes (PDF/PNG/JPEG)
    if (p[1] === "attachments" && p[2]) {
      // TODO: ex. R2: const obj = await env.BUCKET!.get(p[2]); if (!obj) return json({}, 404);
      //       return new Response(obj.body, { headers: { "content-type": obj.httpMetadata?.contentType ?? "application/pdf" } });
      return json({ error: "not found" }, 404);
    }

    return json({ error: "not found" }, 404);
  },
};
