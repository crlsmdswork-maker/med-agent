// Cliente da API da Woovi para disputas (MED).
// Endpoints conferidos na documentação pública (nov/2026):
//   GET  /api/v1/dispute?start=&end=          lista disputas
//   GET  /api/v1/dispute/{endToEndId}         uma disputa
//   POST /api/v1/files  (multipart, purpose=DISPUTE_EVIDENCE)   upload de arquivo (PDF, PNG, JPEG)
//   POST /api/v1/dispute/{id}/evidence        anexa evidências ({ documents: [{ fileId | url, description, correlationID }] })
// Envio por fileId exige a feature DISPUTE_EVIDENCE_FILE_ID; sem ela vem 403 e é preciso mandar `url`.

import { config, type WooviAccount } from "./config.js";

export interface WooviDispute {
  id?: string;
  status: string; // OPENED, IN_REVIEW, PENDING_DOCUMENTATION, ACCEPTED, REJECTED, CANCELED...
  endToEndId: string;
  value: number; // centavos
  disputeReason?: string;
  situationType?: string; // SCAM, ...
  name?: string; // pagador
  email?: string;
  phoneNumber?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface EvidenceDocument {
  fileId?: string;
  url?: string;
  description: string;
  correlationID: string;
}

export class WooviError extends Error {
  constructor(public status: number, public body: string) {
    super(`Woovi HTTP ${status}: ${body.slice(0, 500)}`);
  }
}

async function call<T>(acc: WooviAccount, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.wooviBaseUrl}${path}`, {
    ...init,
    headers: { Authorization: acc.appId, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new WooviError(res.status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function getDispute(acc: WooviAccount, endToEndId: string): Promise<WooviDispute> {
  const r = await call<{ dispute: WooviDispute }>(acc, `/api/v1/dispute/${encodeURIComponent(endToEndId)}`);
  return r.dispute;
}

export async function listDisputes(acc: WooviAccount, start: Date, end: Date): Promise<WooviDispute[]> {
  const qs = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
  const r = await call<{ disputes?: WooviDispute[]; data?: WooviDispute[] }>(acc, `/api/v1/dispute?${qs}`);
  return r.disputes ?? r.data ?? [];
}

export async function uploadFile(
  acc: WooviAccount,
  file: { name: string; contentType: "application/pdf" | "image/png" | "image/jpeg"; data: Buffer },
  correlationID: string,
): Promise<{ id: string; url: string }> {
  const form = new FormData();
  form.set("purpose", "DISPUTE_EVIDENCE");
  form.set("correlationID", correlationID);
  form.set("file", new Blob([new Uint8Array(file.data)], { type: file.contentType }), file.name);
  const r = await call<{ file: { id: string; url: string } }>(acc, "/api/v1/files", { method: "POST", body: form });
  return r.file;
}

export async function submitEvidence(acc: WooviAccount, disputeId: string, documents: EvidenceDocument[]) {
  return call<{ documents: unknown[] }>(acc, `/api/v1/dispute/${encodeURIComponent(disputeId)}/evidence`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ documents }),
  });
}
