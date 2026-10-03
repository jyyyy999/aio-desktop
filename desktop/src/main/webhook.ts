/**
 * 디스코드 웹훅. 태스크의 알림은 원본이 보낸다 (롯데 notify.ts · 네이버 discord.ts) — 매니저는 웹훅 주소를
 * 태스크 설정에 넣어 줄 뿐이다. 매니저가 직접 보내는 것은 둘뿐이다:
 *   시험 보내기     주소가 살아 있는지
 *   모니터 재고 발견  모니터는 dry-run 으로 돌아 원본이 보내지 않는다
 */
import { SITES } from "../shared/sites.js";
import type { MonitorFound } from "../shared/types.js";

export { isDiscordWebhook } from "../shared/sites.js";

/** 디스코드에 하나 보낸다. 받으면 204 (빈 답) 를 준다. */
async function post(url: string, payload: unknown): Promise<{ ok: boolean; message: string }> {
  let res: Response;
  try {
    res = await fetch(url.trim(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    return { ok: false, message: `보내지 못했습니다: ${(e as Error).message}` };
  }
  if (res.status < 300) return { ok: true, message: "보냈습니다 — 디스코드 채널을 확인하세요." };
  const why = res.status === 401 || res.status === 404 ? " (지워졌거나 잘못된 웹훅입니다)" : res.status === 429 ? " (너무 자주 보냈습니다)" : "";
  return { ok: false, message: `디스코드가 ${res.status} 로 답했습니다${why}.` };
}

/** 시험 메시지 하나. */
export function sendTest(url: string): Promise<{ ok: boolean; message: string }> {
  return post(url, {
    embeds: [{
      title: "✅ AIO Task Manager 웹훅 연결 테스트",
      description: "롯데온·네이버 태스크의 알림(재입고·주문서·결제창·세션 끊김·결제 완료)과 모니터의 재고 발견이 이 채널로 옵니다.",
      color: 0x7c5cff,
      timestamp: new Date().toISOString(),
    }],
  });
}

/** 모니터가 재고를 발견했다. */
export function sendFound(url: string, found: MonitorFound): Promise<{ ok: boolean; message: string }> {
  const site = SITES[found.site].name;
  const next = found.onFound === "switch_to_task"
    ? "앱에서 '구매 전환' 을 누르면 같은 대상으로 지금 구매 태스크가 뜹니다."
    : "알림만 보내는 모니터입니다. 모니터는 계속 봅니다.";
  return post(url, {
    content: `🔴 **${found.name}** 재고 발견! ${found.url}`,
    embeds: [{
      title: `🔴 재고 발견! — ${site} ${found.name}`,
      url: found.url,
      description: next,
      color: 0xef4444,
      fields: [
        { name: "발견", value: new Date(found.at).toLocaleString("ko-KR"), inline: true },
        { name: "사이트", value: site, inline: true },
        { name: "원본이 찍은 줄", value: `\`\`\`${found.detail.slice(0, 900)}\`\`\``, inline: false },
      ],
      footer: { text: "AIO Task Manager · 모니터 (사지 않고 확인만)" },
      timestamp: found.at,
    }],
  });
}
