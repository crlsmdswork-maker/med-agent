// Serviço web: recebe webhooks da Woovi, expõe a fila de revisão e hospeda arquivos de evidência.
import express from "express";
import { accountByKey, config } from "./config.js";
import { gatewayData as data } from "./data-source.js";
import { processCase, submitCase } from "./pipeline.js";
import { pollOnce } from "./poller.js";
import { findStuckCases, getCase, getHostedFile, listCases, migrate, updateCase, upsertNewCase, type CaseStatus } from "./store.js";
import { getDispute, type WooviDispute } from "./woovi.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
const wrap =
  (fn: express.RequestHandler): express.RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Webhook da Woovi (um por subconta BaaS) ---------------------------------
// Registre com o AppID da subconta: POST /api/v1/webhook
//   { "webhook": { "name": "med-agent", "event": "OPENPIX:DISPUTE_CREATED",
//                  "url": "https://SEU_DOMINIO_RAILWAY/webhook/woovi/seller-001",
//                  "authorization": "<webhookAuth>", "isActive": true } }
// Repita para OPENPIX:DISPUTE_ACCEPTED, _REJECTED e _CANCELED.
app.post("/webhook/woovi/:accountKey", async (req, res) => {
  const acc = accountByKey(req.params.accountKey);
  if (!acc) return res.sendStatus(404);
  if (req.get("authorization") !== acc.webhookAuth) return res.sendStatus(401);
  // TODO produção: validar também x-webhook-signature (RSA-SHA256 com a chave pública da Woovi).

  const event: string | undefined = req.body?.event;
  const payload: WooviDispute | undefined = req.body?.dispute;
  res.sendStatus(200); // responde rápido; o resto é assíncrono (inclui o POST de teste do cadastro)
  if (!event || !payload) return;

  try {
    if (event === "OPENPIX:DISPUTE_CREATED") {
      const dispute = payload.id ? payload : { ...payload, ...(await getDispute(acc, payload.endToEndId)) };
      const { case: c, isNew } = await upsertNewCase(acc.key, dispute);
      if (isNew) void processCase(c.id, data);
    } else if (["OPENPIX:DISPUTE_ACCEPTED", "OPENPIX:DISPUTE_REJECTED", "OPENPIX:DISPUTE_CANCELED"].includes(event)) {
      const c = await getCase(payload.id ?? payload.endToEndId);
      if (c) await updateCase(c.id, { status: "CLOSED", outcome: event.replace("OPENPIX:DISPUTE_", "") });
    }
  } catch (err) {
    console.error("Erro ao tratar webhook", event, err);
  }
});

// ---- Arquivos hospedados (fallback quando a conta não tem envio por fileId) ----
app.get(
  "/evidence-files/:token",
  wrap(async (req, res) => {
    const f = await getHostedFile(req.params.token);
    if (!f) return void res.sendStatus(404);
    res.type(f.contentType).send(f.data);
  }),
);

// ---- API de revisão (para o seu painel interno) ------------------------------
const admin: express.RequestHandler = (req, res, next) =>
  req.get("authorization") === `Bearer ${config.adminToken}` ? next() : res.sendStatus(401);

app.get("/cases", admin, wrap(async (req, res) => void res.json(await listCases(req.query.status as CaseStatus | undefined))));
app.get(
  "/cases/:id",
  admin,
  wrap(async (req, res) => {
    const c = await getCase(req.params.id);
    c ? res.json(c) : res.sendStatus(404);
  }),
);

/** Aprova e envia. Body opcional: { "letter": "texto editado pelo operador" } */
app.post(
  "/cases/:id/approve",
  admin,
  wrap(async (req, res) => {
    const c = await getCase(req.params.id);
    if (!c) return void res.sendStatus(404);
    if (c.decision?.decision !== "DEFEND" && !req.body?.letter)
      return void res.status(409).json({ error: "O agente não recomendou defesa; envie uma carta em `letter` para defender mesmo assim." });
    try {
      await submitCase(c.id, data, req.body?.letter);
      res.json(await getCase(c.id));
    } catch (err) {
      res.status(409).json({ error: String(err), case: await getCase(c.id) });
    }
  }),
);

/** Decide não defender (aceitar devolução / risco). */
app.post(
  "/cases/:id/dismiss",
  admin,
  wrap(async (req, res) => {
    if (!(await getCase(req.params.id))) return void res.sendStatus(404);
    await updateCase(req.params.id, { status: "NOT_DEFENDED" });
    res.json(await getCase(req.params.id));
  }),
);

/** Reanalisa um caso. */
app.post(
  "/cases/:id/retry",
  admin,
  wrap(async (req, res) => {
    if (!(await getCase(req.params.id))) return void res.sendStatus(404);
    await updateCase(req.params.id, { status: "RECEIVED", error: null });
    void processCase(req.params.id, data);
    res.json(await getCase(req.params.id));
  }),
);

app.use(((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "erro interno" });
}) as express.ErrorRequestHandler);

await migrate();
// Retoma casos que ficaram presos num restart/deploy.
for (const c of await findStuckCases(10)) {
  await updateCase(c.id, { status: "RECEIVED" });
  void processCase(c.id, data);
}
app.listen(config.port, () => console.log(`med-agent ouvindo na porta ${config.port} (modo ${config.submitMode})`));

// Varredura periódica das disputas (pega o que o webhook perdeu).
const pollMinutes = Number(process.env.POLL_INTERVAL_MINUTES ?? 15);
if (pollMinutes > 0) {
  setTimeout(() => void pollOnce().catch((e) => console.error("poll", e)), 30_000);
  setInterval(() => void pollOnce().catch((e) => console.error("poll", e)), pollMinutes * 60_000);
}
