// Rede de segurança: varre as disputas de cada subconta e pega o que o webhook perdeu.
// Roda dentro do serviço web a cada POLL_INTERVAL_MINUTES (padrão 15). Também pode rodar sozinho:
//   node dist/poller.js
import { config } from "./config.js";
import { gatewayData as data } from "./data-source.js";
import { processCase } from "./pipeline.js";
import { closePool, findStuckCases, getCase, migrate, updateCase, upsertNewCase } from "./store.js";
import { listDisputes } from "./woovi.js";

const OPEN = new Set(["OPENED", "IN_REVIEW", "PENDING", "PENDING_DOCUMENTATION"]);
const FINAL = new Set(["ACCEPTED", "REJECTED", "CANCELED", "CLOSED"]);

let running = false;

export async function pollOnce() {
  if (running) return; // evita duas varreduras ao mesmo tempo
  running = true;
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 10 * 24 * 3600_000);

    for (const acc of config.accounts) {
      if (acc.appId.startsWith("PREENCHER")) continue; // conta ainda não configurada
      try {
        const disputes = await listDisputes(acc, start, end);
        for (const d of disputes) {
          const existing = await getCase(d.id ?? d.endToEndId);
          if (!existing && OPEN.has(d.status)) {
            const { case: c, isNew } = await upsertNewCase(acc.key, d);
            if (isNew) await processCase(c.id, data);
          } else if (existing && FINAL.has(d.status) && existing.status !== "CLOSED") {
            await updateCase(existing.id, { status: "CLOSED", outcome: d.status, dispute: d });
          }
        }
        console.log(`[poll ${acc.key}] ${disputes.length} disputas verificadas`);
      } catch (err) {
        console.error(`[poll ${acc.key}] falha`, err);
      }
    }

    for (const c of await findStuckCases(30)) {
      await updateCase(c.id, { status: "RECEIVED" });
      await processCase(c.id, data);
    }
  } finally {
    running = false;
  }
}

// Execução avulsa: `node dist/poller.js`
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate()
    .then(pollOnce)
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
