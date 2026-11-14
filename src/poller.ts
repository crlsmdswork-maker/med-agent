// Serviço de cron no Railway: varre as disputas de cada subconta e pega o que o webhook perdeu.
// Roda, termina e sai (o Railway agenda via cronSchedule em railway.poller.json).
import { config } from "./config.js";
import { gatewayData as data } from "./data-source.js";
import { processCase } from "./pipeline.js";
import { closePool, findStuckCases, getCase, migrate, updateCase, upsertNewCase } from "./store.js";
import { listDisputes } from "./woovi.js";

const OPEN = new Set(["OPENED", "IN_REVIEW", "PENDING", "PENDING_DOCUMENTATION"]);
const FINAL = new Set(["ACCEPTED", "REJECTED", "CANCELED", "CLOSED"]);

async function main() {
  await migrate();
  const end = new Date();
  const start = new Date(end.getTime() - 10 * 24 * 3600_000);

  for (const acc of config.accounts) {
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
      console.log(`[${acc.key}] ${disputes.length} disputas verificadas`);
    } catch (err) {
      console.error(`[${acc.key}] falha no poll`, err);
    }
  }

  // Casos presos há mais de 30 min (o serviço web normalmente já retoma, isto é redundância).
  for (const c of await findStuckCases(30)) {
    await updateCase(c.id, { status: "RECEIVED" });
    await processCase(c.id, data);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
