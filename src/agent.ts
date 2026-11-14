// O agente de defesa de MED.
// Loop de tool use: o modelo consulta os dados do gateway pelas ferramentas e termina
// chamando `submit_decision`. O código valida que toda evidência citada foi de fato
// retornada por uma ferramenta; se não foi, a decisão é rejeitada.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { config } from "./config.js";
import type { Attachment, GatewayData } from "./gateway-data.js";
import type { WooviDispute } from "./woovi.js";

const anthropic = new Anthropic(); // usa ANTHROPIC_API_KEY

export const DecisionSchema = z.object({
  decision: z.enum(["DEFEND", "ACCEPT_REFUND", "ESCALATE_FRAUD_RISK", "NEED_HUMAN"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().describe("Resumo interno do porquê (não vai para a Woovi)"),
  defenseLetter: z.string().nullable().describe("Carta de defesa em português, só quando decision = DEFEND"),
  evidence: z
    .array(z.object({ attachmentId: z.string(), description: z.string().max(200) }))
    .describe("Anexos a enviar, só ids retornados pelas ferramentas"),
  missingEvidence: z.array(z.string()).describe("O que faltou e pediria ao seller"),
});
export type AgentDecision = z.infer<typeof DecisionSchema> & { attachments: Attachment[] };

const SYSTEM = `Você é o analista de MED (Mecanismo Especial de Devolução do Pix) de um gateway de pagamentos brasileiro.
Para cada MED recebido você investiga a transação com as ferramentas e decide se o gateway deve defender o seller.

Regras inegociáveis:
1. Use SOMENTE fatos retornados pelas ferramentas. Nunca invente, suponha ou "complete" datas, códigos de rastreio, conversas, nomes ou documentos.
2. Em "evidence", cite apenas attachmentId que apareceram nas respostas das ferramentas.
3. Se os sinais indicarem que o seller ou a venda é fraudulenta (ex.: produto nunca enviado, pagador diferente do comprador sem explicação, seller com taxa de MED anormal, flags de risco), NÃO defenda: decida ESCALATE_FRAUD_RISK.
4. Se o MED for procedente (cliente não recebeu, cobrança indevida), decida ACCEPT_REFUND.
5. Se faltarem evidências essenciais para defender, decida NEED_HUMAN e liste em missingEvidence o que pedir ao seller.
6. Só decida DEFEND quando houver prova objetiva de entrega/prestação e vínculo entre pagador e comprador.

A carta de defesa (quando DEFEND) deve ser em português formal, objetiva, até ~350 palavras, com:
- identificação da transação (endToEndId, valor, data) e do recebedor;
- o que foi vendido e para quem;
- a prova de entrega/acesso/prestação, com datas;
- o vínculo entre o pagador do Pix e o comprador;
- a lista dos documentos anexos;
- pedido de rejeição do MED por ausência de fraude.
Não use linguagem agressiva, não acuse o pagador de crime, não faça promessas.

Termine SEMPRE chamando a ferramenta submit_decision exatamente uma vez.`;

const tools: Anthropic.Tool[] = [
  {
    name: "get_order",
    description: "Busca o pedido vinculado ao Pix pelo endToEndId: itens, comprador, pagador, seller e anexos (NF etc.).",
    input_schema: { type: "object", properties: { endToEndId: { type: "string" } }, required: ["endToEndId"] },
  },
  {
    name: "get_fulfillment",
    description: "Status e eventos de entrega/acesso/prestação do pedido, com anexos (rastreio, logs de acesso).",
    input_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  {
    name: "get_support_history",
    description: "Mensagens entre comprador e seller/suporte, com anexos (prints).",
    input_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  {
    name: "get_risk_signals",
    description: "Sinais de risco: histórico do pagador, taxa de MED do seller, flags.",
    input_schema: { type: "object", properties: { orderId: { type: "string" } }, required: ["orderId"] },
  },
  {
    name: "submit_decision",
    description: "Registra a decisão final sobre o MED. Chame uma única vez, ao final.",
    input_schema: {
      type: "object",
      properties: {
        decision: { type: "string", enum: ["DEFEND", "ACCEPT_REFUND", "ESCALATE_FRAUD_RISK", "NEED_HUMAN"] },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        reasoning: { type: "string" },
        defenseLetter: { type: ["string", "null"] },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: { attachmentId: { type: "string" }, description: { type: "string" } },
            required: ["attachmentId", "description"],
          },
        },
        missingEvidence: { type: "array", items: { type: "string" } },
      },
      required: ["decision", "confidence", "reasoning", "defenseLetter", "evidence", "missingEvidence"],
    },
  },
];

export async function analyzeDispute(dispute: WooviDispute, data: GatewayData): Promise<AgentDecision> {
  const seenAttachments = new Map<string, Attachment>();
  const remember = (atts: Attachment[] | undefined) => atts?.forEach((a) => seenAttachments.set(a.id, a));

  async function runTool(name: string, input: Record<string, string>): Promise<unknown> {
    switch (name) {
      case "get_order": {
        const o = await data.findOrderByEndToEndId(input.endToEndId);
        remember(o?.attachments);
        return o ?? { error: "Pedido não encontrado para este endToEndId" };
      }
      case "get_fulfillment": {
        const f = await data.getFulfillment(input.orderId);
        remember(f.attachments);
        return f;
      }
      case "get_support_history": {
        const s = await data.getSupportHistory(input.orderId);
        remember(s.attachments);
        return s;
      }
      case "get_risk_signals":
        return data.getRiskSignals(input.orderId);
      default:
        return { error: `Ferramenta desconhecida: ${name}` };
    }
  }

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Novo MED recebido. Dados da Woovi:\n${JSON.stringify(
        {
          endToEndId: dispute.endToEndId,
          valorCentavos: dispute.value,
          motivo: dispute.disputeReason,
          tipo: dispute.situationType,
          pagador: { nome: dispute.name, email: dispute.email, telefone: dispute.phoneNumber },
          abertoEm: dispute.createdAt,
        },
        null,
        2,
      )}\n\nInvestigue e decida.`,
    },
  ];

  for (let turn = 0; turn < 12; turn++) {
    const res = await anthropic.messages.create({
      model: config.anthropicModel,
      max_tokens: 4096,
      system: SYSTEM,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      messages.push({ role: "user", content: "Finalize chamando submit_decision." });
      continue;
    }

    const final = toolUses.find((t) => t.name === "submit_decision");
    if (final) {
      const parsed = DecisionSchema.parse(final.input);
      // Trava anti-alucinação: toda evidência citada precisa ter vindo de uma ferramenta.
      const unknown = parsed.evidence.filter((e) => !seenAttachments.has(e.attachmentId));
      if (unknown.length) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: final.id,
              is_error: true,
              content: `Estes attachmentId não foram retornados por nenhuma ferramenta: ${unknown
                .map((u) => u.attachmentId)
                .join(", ")}. Corrija e chame submit_decision de novo.`,
            },
          ],
        });
        continue;
      }
      if (parsed.decision === "DEFEND" && (!parsed.defenseLetter || parsed.evidence.length === 0)) {
        messages.push({
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: final.id,
              is_error: true,
              content: "DEFEND exige defenseLetter e ao menos uma evidência. Ajuste ou mude a decisão para NEED_HUMAN.",
            },
          ],
        });
        continue;
      }
      return { ...parsed, attachments: parsed.evidence.map((e) => seenAttachments.get(e.attachmentId)!) };
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      try {
        const out = await runTool(t.name, t.input as Record<string, string>);
        results.push({ type: "tool_result", tool_use_id: t.id, content: JSON.stringify(out) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: t.id, is_error: true, content: String(err) });
      }
    }
    messages.push({ role: "user", content: results });
  }

  throw new Error("O agente não chegou a uma decisão em 12 turnos");
}
