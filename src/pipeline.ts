// Orquestra um caso: analisa com o agente → (revisão humana) → envia evidências à Woovi.
import { randomUUID } from "node:crypto";
import { accountByKey, config } from "./config.js";
import { analyzeDispute } from "./agent.js";
import type { GatewayData } from "./gateway-data.js";
import { renderDefensePdf } from "./letter.js";
import { getCase, hostFile, transition, updateCase } from "./store.js";
import { submitEvidence, uploadFile, WooviError, type EvidenceDocument } from "./woovi.js";

export async function processCase(caseId: string, data: GatewayData) {
  // Só um processo pega o caso (webhook e poller podem disparar ao mesmo tempo).
  if (!(await transition(caseId, ["RECEIVED"], "ANALYZING"))) return;
  const c = (await getCase(caseId))!;

  try {
    const decision = await analyzeDispute(c.dispute, data);
    await updateCase(caseId, { decision });

    if (decision.decision !== "DEFEND") {
      await updateCase(caseId, { status: decision.decision === "NEED_HUMAN" ? "AWAITING_REVIEW" : "NOT_DEFENDED" });
      return;
    }

    const auto = config.submitMode === "auto" && decision.confidence >= config.autoSubmitMinConfidence;
    await updateCase(caseId, { status: "AWAITING_REVIEW" });
    if (auto) await submitCase(caseId, data);
  } catch (err) {
    await updateCase(caseId, { status: "FAILED", error: String(err) });
  }
}

/** Envia a defesa aprovada para a Woovi. Chamado automaticamente ou pelo endpoint de aprovação. */
export async function submitCase(caseId: string, data: GatewayData, editedLetter?: string) {
  if (!(await transition(caseId, ["AWAITING_REVIEW", "FAILED"], "SUBMITTING"))) {
    throw new Error("Caso não está pronto para envio (ou já está sendo enviado)");
  }
  const c = (await getCase(caseId))!;
  try {
    const acc = accountByKey(c.accountKey);
    if (!acc) throw new Error(`Conta ${c.accountKey} não configurada`);
    const letter = editedLetter ?? c.decision?.defenseLetter;
    if (!letter || !c.decision) throw new Error("Caso sem carta de defesa");
    if (new Date(c.deadlineAt) < new Date()) console.warn(`[${caseId}] atenção: prazo interno já passou`);

    type F = { name: string; contentType: "application/pdf" | "image/png" | "image/jpeg"; data: Buffer; description: string };
    const files: F[] = [
      {
        name: "carta-de-defesa.pdf",
        contentType: "application/pdf",
        data: await renderDefensePdf(c.dispute, letter, c.decision.evidence.map((e) => e.description)),
        description: "Carta de defesa do recebedor",
      },
    ];
    for (const ev of c.decision.evidence) {
      const att = c.decision.attachments.find((a) => a.id === ev.attachmentId)!;
      files.push({ name: att.name, contentType: att.contentType, data: await data.getAttachmentBytes(att.id), description: ev.description });
    }

    const byUrl = async (suffix = ""): Promise<EvidenceDocument[]> =>
      Promise.all(
        files.map(async (f, i) => ({
          url: await hostForWoovi(f.contentType, f.data),
          description: f.description,
          correlationID: `${caseId}-${i}${suffix}`,
        })),
      );

    // 1ª tentativa: upload na Woovi + fileId. Se a conta não tiver a feature, cai para URL hospedada aqui.
    let documents: EvidenceDocument[] = [];
    try {
      for (const [i, f] of files.entries()) {
        const correlationID = `${caseId}-${i}`; // idempotente: reenvio não duplica
        const up = await uploadFile(acc, f, correlationID);
        documents.push({ fileId: up.id, description: f.description, correlationID });
      }
      await submitEvidence(acc, caseId, documents);
    } catch (err) {
      if (!(err instanceof WooviError && err.status === 403)) throw err;
      documents = await byUrl("-url");
      await submitEvidence(acc, caseId, documents);
    }
    await updateCase(caseId, { status: "SUBMITTED", error: null, ...(editedLetter ? { decision: { ...c.decision, defenseLetter: editedLetter } } : {}) });
  } catch (err) {
    await updateCase(caseId, { status: "FAILED", error: String(err) });
    throw err;
  }
}

async function hostForWoovi(contentType: string, data: Buffer): Promise<string> {
  if (!config.publicBaseUrl) throw new Error("PUBLIC_BASE_URL não configurada: necessária para enviar evidência por URL");
  const token = randomUUID();
  await hostFile(token, contentType, data);
  return `${config.publicBaseUrl}/evidence-files/${token}`;
}
