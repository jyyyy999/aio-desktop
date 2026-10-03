/**
 * 파이썬 판과 같은 일을 시키고 시간을 잰다.
 *
 * 재는 것은 셋이다. 드랍에서 갈리는 것이 이 셋뿐이기 때문이다.
 *
 *   재고 조회   113바이트 ajax — 3초마다 도는 것
 *   목록 훑기   150KB HTML 파싱 — 15초마다 도는 것
 *   상세 파싱   155KB HTML — 담기 직전에 한 번
 *
 * 네트워크가 섞이면 무엇을 재는지 알 수 없게 되므로, 파싱은 미리 받아 둔 본문으로 잰다.
 */
import { performance } from "node:perf_hooks";
import { Session } from "./http.js";
import { fetchStock, DETAIL_URL } from "./site.js";
import { listItems, parseWatch } from "./list.js";
import { parse } from "node-html-parser";

const GNO = "85140383";
const KEYWORD = "원피스 카드게임";

function stats(name: string, ms: number[]) {
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;
  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  console.log(
    name.padEnd(22) +
    "n=" + String(ms.length).padStart(3) +
    "  평균 " + mean.toFixed(1).padStart(7) + "ms" +
    "  중앙 " + at(0.5).toFixed(1).padStart(7) + "ms" +
    "  최소 " + sorted[0]!.toFixed(1).padStart(7) + "ms" +
    "  p90 " + at(0.9).toFixed(1).padStart(7) + "ms",
  );
}

async function main() {
  const rounds = Number(process.env["ROUNDS"] ?? 20);
  const s = new Session();
  const watch = parseWatch(KEYWORD)!;

  // 1) 재고 조회 (네트워크 포함)
  const stock: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await fetchStock(s, GNO);
    stock.push(performance.now() - t0);
  }
  stats("재고조회(왕복)", stock);

  // 2) 목록 훑기 (네트워크 + 파싱)
  const list: number[] = [];
  for (let i = 0; i < Math.min(rounds, 8); i++) {
    const t0 = performance.now();
    await listItems(s, watch, {});
    list.push(performance.now() - t0);
  }
  stats("목록훑기(왕복+파싱)", list);

  // 3) 파싱만 — 본문을 한 번 받아 두고 반복해서 잰다
  const html = await s.html(DETAIL_URL + "?gno=" + GNO, "상세");
  const parseMs: number[] = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    const root = parse(html);
    const form = root.querySelector('form[name="Frm"]');
    form?.querySelectorAll("input[name]").length;
    parseMs.push(performance.now() - t0);
  }
  stats("상세파싱만(" + Math.round(html.length / 1024) + "KB)", parseMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
