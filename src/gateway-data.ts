// Ponte entre o agente e os SEUS dados (banco do gateway, logística, suporte).
// O agente só pode citar o que essas funções retornarem; é isso que impede evidência inventada.
//
// >>> Substitua `mockGatewayData` por uma implementação que consulta o seu banco. <<<

export interface Attachment {
  id: string; // id estável, ex.: "order-123/nf.pdf"
  name: string;
  contentType: "application/pdf" | "image/png" | "image/jpeg";
  description: string;
}

export interface OrderInfo {
  orderId: string;
  sellerId: string;
  sellerName: string;
  sellerCnpj: string;
  productType: "PHYSICAL" | "DIGITAL" | "SERVICE";
  items: { description: string; quantity: number; unitValueCents: number }[];
  totalCents: number;
  createdAt: string;
  paidAt: string;
  buyer: { name: string; document: string; email?: string; phone?: string; ip?: string; deviceId?: string };
  payer: { name?: string; document?: string }; // dados do pagador do Pix (podem diferir do comprador!)
  attachments: Attachment[];
}

export interface FulfillmentInfo {
  status: "DELIVERED" | "IN_TRANSIT" | "NOT_SHIPPED" | "ACCESSED" | "NOT_ACCESSED" | "SERVICE_RENDERED" | "UNKNOWN";
  events: { at: string; description: string }[]; // rastreio, logins na área de membros, downloads...
  attachments: Attachment[];
}

export interface SupportInfo {
  messages: { at: string; from: "BUYER" | "SELLER"; channel: string; text: string }[];
  attachments: Attachment[];
}

export interface RiskInfo {
  payerPreviousOrders: number;
  payerPreviousMeds: number;
  sellerMedRate30d: number; // MEDs / transações Pix nos últimos 30 dias
  sellerOpenMeds: number;
  flags: string[]; // ex.: "payer_document_differs_from_buyer", "seller_in_watchlist"
}

export interface GatewayData {
  findOrderByEndToEndId(endToEndId: string): Promise<OrderInfo | null>;
  getFulfillment(orderId: string): Promise<FulfillmentInfo>;
  getSupportHistory(orderId: string): Promise<SupportInfo>;
  getRiskSignals(orderId: string): Promise<RiskInfo>;
  getAttachmentBytes(attachmentId: string): Promise<Buffer>;
}

// ---------------------------------------------------------------------------
// Mock só para rodar o fluxo de ponta a ponta. Apague quando ligar no seu banco.
// ---------------------------------------------------------------------------
export const mockGatewayData: GatewayData = {
  async findOrderByEndToEndId(endToEndId) {
    return {
      orderId: "ord_123",
      sellerId: "seller-001",
      sellerName: "Loja Exemplo LTDA",
      sellerCnpj: "00.000.000/0001-00",
      productType: "PHYSICAL",
      items: [{ description: "Fone Bluetooth X", quantity: 1, unitValueCents: 19990 }],
      totalCents: 19990,
      createdAt: "2026-11-01T14:02:00Z",
      paidAt: "2026-11-01T14:03:10Z",
      buyer: { name: "João da Silva", document: "***.456.789-**", email: "joao@exemplo.com", ip: "200.1.2.3" },
      payer: { name: "João da Silva", document: "***.456.789-**" },
      attachments: [
        { id: "ord_123/nfe.pdf", name: "nfe.pdf", contentType: "application/pdf", description: "Nota fiscal eletrônica do pedido" },
      ],
    };
  },
  async getFulfillment() {
    return {
      status: "DELIVERED",
      events: [
        { at: "2026-11-02T10:00:00Z", description: "Postado nos Correios (código QB123456789BR)" },
        { at: "2026-11-05T15:21:00Z", description: "Entregue ao destinatário, assinado por João da Silva" },
      ],
      attachments: [
        { id: "ord_123/rastreio.pdf", name: "rastreio.pdf", contentType: "application/pdf", description: "Comprovante de entrega dos Correios" },
      ],
    };
  },
  async getSupportHistory() {
    return {
      messages: [{ at: "2026-11-06T09:00:00Z", from: "BUYER", channel: "whatsapp", text: "Chegou certinho, obrigado!" }],
      attachments: [
        { id: "ord_123/whatsapp.png", name: "whatsapp.png", contentType: "image/png", description: "Print da conversa em que o comprador confirma o recebimento" },
      ],
    };
  },
  async getRiskSignals() {
    return { payerPreviousOrders: 3, payerPreviousMeds: 0, sellerMedRate30d: 0.002, sellerOpenMeds: 1, flags: [] };
  },
  async getAttachmentBytes() {
    // PDF mínimo válido, só para teste.
    return Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  },
};

// ---------------------------------------------------------------------------
// Implementação real: o gateway (na Cloudflare) expõe uma API só para os agentes.
// Contrato que o Worker do gateway precisa implementar (todas com Authorization: Bearer GATEWAY_API_TOKEN):
//   GET /agent/orders/by-e2e/:endToEndId   -> OrderInfo  (404 se não achar)
//   GET /agent/orders/:orderId/fulfillment -> FulfillmentInfo
//   GET /agent/orders/:orderId/support     -> SupportInfo
//   GET /agent/orders/:orderId/risk        -> RiskInfo
//   GET /agent/attachments/:attachmentId   -> bytes do arquivo (Content-Type: application/pdf | image/png | image/jpeg)
// ---------------------------------------------------------------------------
export function httpGatewayData(baseUrl: string, token: string): GatewayData {
  const get = async (path: string): Promise<Response> => {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    return res;
  };
  const json = async <T>(path: string): Promise<T> => {
    const res = await get(path);
    if (!res.ok) throw new Error(`Gateway ${path} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  };
  return {
    async findOrderByEndToEndId(e2e) {
      const res = await get(`/agent/orders/by-e2e/${encodeURIComponent(e2e)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`Gateway by-e2e -> HTTP ${res.status}`);
      return (await res.json()) as OrderInfo;
    },
    getFulfillment: (id) => json(`/agent/orders/${encodeURIComponent(id)}/fulfillment`),
    getSupportHistory: (id) => json(`/agent/orders/${encodeURIComponent(id)}/support`),
    getRiskSignals: (id) => json(`/agent/orders/${encodeURIComponent(id)}/risk`),
    async getAttachmentBytes(attId) {
      const res = await get(`/agent/attachments/${encodeURIComponent(attId)}`);
      if (!res.ok) throw new Error(`Gateway attachment ${attId} -> HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}
