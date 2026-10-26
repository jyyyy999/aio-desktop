/**
 * 디스코드 알림. 집의 관례를 따른다 — dry-run 이면 보내지 않고 무엇을 보낼지만 적는다.
 * 모니터의 발견 알림은 데스크톱 매니저가 보낸다 (원본은 dry-run 이라 안 보낸다).
 */
import { log, sayStar } from "./log.js";
import { run, webhookOf, type KreamConfig } from "./config.js";

const COLOR = { found: 0x2ecc71, human: 0xf1c40f, paid: 0x9b59b6, bad: 0xe74c3c } as const;

interface Embed {
  title: string;
  description?: string;
  color?: number;
  fields?: { name: string; value: string; inline?: boolean }[];
}

async function send(cfg: KreamConfig, embed: Embed): Promise<boolean> {
  const url = webhookOf(cfg);
  if (run.dryRun) {
    log.info(`[dry-run] 디스코드 전송 생략 — ${embed.title}`);
    return true;
  }
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ embeds: [{ ...embed, timestamp: new Date().toISOString() }] }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      log.warn(`디스코드로 알리지 못했습니다 (HTTP ${res.status})`);
      return false;
    }
    sayStar("디스코드로 알렸습니다");
    return true;
  } catch (e) {
    log.warn(`디스코드로 알리지 못했습니다: ${(e as Error).message}`);
    return false;
  }
}

const productFields = (name: string, url: string) => [
  { name: "상품", value: name || url, inline: false },
  { name: "주소", value: url, inline: false },
];

export function notifyFound(cfg: KreamConfig, name: string, url: string, price: number): Promise<boolean> {
  return send(cfg, {
    title: "🟢 KREAM 재고 — 구매를 시작합니다",
    description: price ? `${price.toLocaleString("en-US")}원` : undefined,
    color: COLOR.found,
    fields: productFields(name, url),
  });
}

export function notifyHuman(cfg: KreamConfig, name: string, url: string, why: string): Promise<boolean> {
  return send(cfg, { title: "✋ KREAM — 창에서 마저 해 주세요", description: why, color: COLOR.human, fields: productFields(name, url) });
}

export function notifyPaid(cfg: KreamConfig, name: string, url: string, orderNo: string, total: number): Promise<boolean> {
  return send(cfg, {
    title: "🟣 KREAM 결제 완료",
    color: COLOR.paid,
    fields: [
      ...productFields(name, url),
      { name: "주문번호", value: orderNo, inline: true },
      ...(total ? [{ name: "금액", value: `${total.toLocaleString("en-US")}원`, inline: true }] : []),
    ],
  });
}

export function notifyFailed(cfg: KreamConfig, name: string, url: string, reason: string): Promise<boolean> {
  return send(cfg, { title: "🔴 KREAM 구매 실패", description: reason, color: COLOR.bad, fields: productFields(name, url) });
}
