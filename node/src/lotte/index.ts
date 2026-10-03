/**
 * 롯데온 바로구매 도우미 — Node.js/TypeScript 판.
 *
 *   지켜보기(초 단위) → 구매 가능 감지 → 바로 구매하기 → 주문서 → 필수 동의
 *   → 결제하기 → **PG 결제창을 띄우고 멈춘다** → 디스코드 알림 → [사람] 결제
 *
 * **결제창까지가 끝이다.** 결제창 안에서는 아무것도 누르지 않는다 — 카드 인증도,
 * 간편결제 비밀번호도, 앱 승인도 사람이 한다. bnkr 판은 결제창에서 몇 개를 더 눌러
 * QR 을 폰으로 보내지만, 이 판은 창을 띄우는 데까지만 간다.
 *
 * 로그인도 자동화하지 않는다. **브라우저에서 직접 로그인한 세션 쿠키를 빌려 쓴다.**
 *
 * 조회는 HTTP 로 한다 — 롯데온은 네이버와 달리 Node 의 요청을 밀어내지 않는다
 * (재 봤다: 200 · 27KB · 192ms). 그래서 bnkr 판처럼 여럿을 동시에 볼 수 있다.
 *
 *   node dist/lotte/index.js                지켜보다가 열리면 산다
 *   node dist/lotte/index.js --cookie       클립보드의 Cookie 줄을 설정에 저장
 *   node dist/lotte/index.js --link         클립보드의 상품 주소를 대상으로 삼고 곧장 감시
 *   node dist/lotte/index.js --whoami       빌려온 세션이 살아 있는지
 */
import { existsSync, unlinkSync } from "node:fs";
import { log, sayOk, sayStep } from "../log.js";
import {
  ACTIONS, actionOf, cookieOf, loadConfig, loadState, Quit, run, saveConfig, saveState,
  STATE_PATH, type Config, type OrderAction, type State,
} from "./config.js";
import { looksLikeCookie, newSession, type Session } from "./http.js";
import { clipboardText, cmdAdd, cmdBuy, cmdLink, cmdProbe, cmdStatus, cmdWhoami } from "./commands.js";
import { SessionDead, watch } from "./watch.js";
import { targetFor } from "./targets.js";

const HELP = `롯데온 바로구매 도우미 (Node.js 판) — 결제창까지 데려다 놓고 멈춥니다

  --once                한 번만 확인하고 종료
  --dry-run             사지 않고 무엇을 살지만 본다
  --status              대상 상품의 현재 재고만
  --probe [URL]         상품 페이지를 뜯어보고 lotteon-page-dump.txt 에 남긴다
  --whoami              빌려온 세션이 살아 있는지
  --add URL …           살 상품을 넣는다
  --link [URL]          클립보드의 상품 주소를 대상으로 삼고 곧장 감시한다 (- 는 표준입력)
  --buy [URL]           지금 바로 산다, 결제창까지 (주소 없이 부르면 설정의 첫 상품)
  --dump-pay [URL]      --buy 와 같되, 결제창에 무엇이 있었는지 받아 적는다
  --action open|agree|submit   이번만 어디까지 갈지 (기본은 설정의 order_action)
  --reset               산 기록을 지운다
  --cookie [쿠키]        Cookie: 줄을 저장한다. 값 없이 쓰면 클립보드에서 가져온다
                        (파워셸이 세미콜론에서 자르는 것을 피하는 길). - 는 표준입력
`;

interface Args {
  once: boolean;
  dryRun: boolean;
  status: boolean;
  whoami: boolean;
  reset: boolean;
  help: boolean;
  add: string[] | null;
  probe: string | null;
  cookie: string | null;
  link: string | null;
  buy: string | null;
  dumpPay: string | null;
  action: string | null;
}

/**
 * 손으로 짠 인자 파서.
 *
 * argparse 의 nargs="+" 와 "값 없이 써도 되는 옵션"(--cookie·--link·--buy…)이 둘 다
 * 필요한데, Node 의 parseArgs 는 어느 쪽도 못 한다. 다른 판과 같은 말이 통해야 하므로
 * 여기서 센다.
 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: false, dryRun: false, status: false, whoami: false, reset: false, help: false,
    add: null, probe: null, cookie: null, link: null, buy: null, dumpPay: null, action: null,
  };

  const isFlag = (v: string | undefined) => v !== undefined && v.startsWith("--");
  // nargs="?" 자리. 뒤에 오는 것이 옵션이면 값이 없는 것이다.
  const maybe = (i: number, blank: string): [string, number] =>
    isFlag(argv[i + 1]) || argv[i + 1] === undefined ? [blank, i] : [argv[i + 1]!, i + 1];
  // 값이 반드시 있어야 하는 자리.
  const must = (i: number, flag: string): [string, number] => {
    const value = argv[i + 1];
    if (value === undefined || isFlag(value)) throw new Error(`${flag} 뒤에 값이 필요합니다.\n\n${HELP}`);
    return [value, i + 1];
  };
  // nargs="+" 자리. 다음 옵션이 나올 때까지가 그 옵션의 값이다.
  const rest = (i: number, flag: string): [string[], number] => {
    const out: string[] = [];
    let at = i + 1;
    while (at < argv.length && !isFlag(argv[at])) out.push(argv[at++]!);
    if (!out.length) throw new Error(`${flag} 뒤에 값이 필요합니다.\n\n${HELP}`);
    return [out, at - 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "--once": args.once = true; break;
      case "--dry-run": args.dryRun = true; break;
      case "--status": args.status = true; break;
      case "--whoami": args.whoami = true; break;
      case "--reset": args.reset = true; break;
      case "-h": case "--help": args.help = true; break;
      case "--add": [args.add, i] = rest(i, arg); break;
      case "--probe": [args.probe, i] = maybe(i, ""); break;
      case "--buy": [args.buy, i] = maybe(i, ""); break;
      case "--dump-pay": [args.dumpPay, i] = maybe(i, ""); break;
      case "--action": [args.action, i] = must(i, arg); break;
      case "--cookie": [args.cookie, i] = maybe(i, "-clip-"); break;
      case "--link": [args.link, i] = maybe(i, "-clip-"); break;
      default:
        // 쿠키 줄을 명령줄에 붙여넣으면 셸이 그것을 여러 조각으로 쪼개 던진다. 조각에는
        // 늘 "=" 가 들어 있으므로, 그것만으로 무슨 일이 났는지 짚어 줄 수 있다.
        if (arg.includes("=")) {
          throw new Error(
            `쿠키를 명령줄에 붙여넣은 것 같습니다 (셸이 ${JSON.stringify(arg.slice(0, 30))} … 로 쪼갰습니다).\n` +
            "Cookie 줄을 복사한 뒤 값 없이 부르세요:  npm run lotte:cookie",
          );
        }
        throw new Error(`모르는 인자입니다: ${arg}\n\n${HELP}`);
    }
  }
  return args;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => resolve(text));
    process.stdin.on("error", reject);
  });
}

/** 쿠키를 설정에 저장한다. 이름을 골라 담을 필요는 없다 — 브라우저가 보내는 줄 그대로다. */
async function saveCookie(cfg: Config, value: string): Promise<void> {
  let raw: string;
  if (value === "-clip-") {
    raw = clipboardText("--cookie -");
    log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
  } else if (value === "-") {
    process.stderr.write("Cookie: 줄을 붙여넣고 Ctrl+Z 를 누른 뒤 Enter (취소는 Ctrl+C)\n");
    raw = await readStdin();
  } else {
    raw = value;
  }

  raw = raw.trim();
  const names = raw.split(";").filter((p) => p.includes("=")).map((p) => p.split("=")[0]!.trim());

  // 파워셸이 세미콜론에서 자른 자국. 이걸 짚어 주지 않으면 왜 안 되는지 알기 어렵다.
  if (names.length === 1 && value !== "-clip-" && value !== "-") {
    throw new Error(
      `쿠키가 한 조각(${names[0]})뿐입니다. 파워셸이 세미콜론에서 잘랐을 수 있습니다.\n` +
      "  값 없이 부르면 클립보드에서 통째로 가져옵니다:  npm run lotte:cookie\n" +
      "  또는 표준입력으로:                              node dist/lotte/index.js --cookie -",
    );
  }
  if (!looksLikeCookie(raw)) {
    log.warn("쿠키 조각이 거의 없습니다. 로그인한 창에서 복사한 것이 맞는지 봐주세요.");
  }

  cfg.cookie = raw;
  saveConfig(cfg);
  sayOk(`쿠키 ${names.length}개를 저장했습니다: ` +
    names.slice(0, 8).join(", ") + (names.length > 8 ? " …" : ""));
  sayStep("--whoami 로 확인해 보세요.");
}

/**
 * 지켜보는 중인 상태. SIGINT 로 끊길 때 적어 두려고 붙잡아 둔다.
 * 기록을 잃으면 다음 실행에서 같은 것을 또 산다.
 */
let live: State | null = null;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  run.dryRun = args.dryRun;
  const cfg = loadConfig();

  // 이번만 어디까지 갈지. 설정을 고치지 않고 한 번 시험해 볼 자리다.
  if (args.action !== null) {
    const asked = args.action.toLowerCase() as OrderAction;
    if (!ACTIONS.includes(asked)) {
      throw new Error(`--action 은 ${ACTIONS.join(" / ")} 중 하나입니다: ${args.action}`);
    }
    cfg.order_action = asked;
  }

  if (args.cookie !== null) {
    await saveCookie(cfg, args.cookie);
    return;
  }

  if (args.add) {
    cmdAdd(cfg, args.add);
    return;
  }

  if (args.link !== null) {
    // 대상만 바꾸고 멈추지 않는다. 아래 감시로 그대로 흘러간다 —
    // "복사해 두고 명령 한 번" 이 이 옵션의 전부다.
    await cmdLink(cfg, args.link, readStdin);
  }

  if (args.reset) {
    if (existsSync(STATE_PATH)) unlinkSync(STATE_PATH);
    sayOk("기록을 지웠습니다.");
    return;
  }

  // 재고만 볼 때는 쿠키를 싣지 않는다. 공개 페이지라 필요 없고, 실수로 남길 일도 없다.
  const readOnly = args.status || args.probe !== null || run.dryRun;
  const session: Session = newSession(readOnly ? "" : cookieOf(cfg));

  if (args.probe !== null) return cmdProbe(cfg, session, args.probe);
  if (args.status) return cmdStatus(cfg, session);
  if (args.whoami) return cmdWhoami(cfg, session);

  const state = loadState();
  live = state;

  const buying = args.dumpPay ?? args.buy;
  if (buying !== null) {
    try {
      await cmdBuy(cfg, session, state, buying || targetFor(cfg, "").url, args.dumpPay !== null);
    } finally {
      saveState(state);
    }
    return;
  }

  log.debug(`어디까지 가는가: ${actionOf(cfg)}`);
  try {
    await watch(cfg, session, state, args.once);
  } finally {
    saveState(state);
  }
}

process.on("SIGINT", () => {
  log.info("멈췄습니다.");
  if (live) {
    try {
      saveState(live);
    } catch {
      // 못 적어도 여기서 더 할 수 있는 것이 없다.
    }
  }
  process.exit(0);
});

main()
  .then(() => {
    // 크롬은 남긴다(detach). 여기서 그냥 끝내면 크롬드라이버가 붙들고 있어 안 꺼진다.
    process.exit(0);
  })
  .catch((e) => {
    // 세션이 끊긴 것은 고장이 아니다. 무슨 일인지만 적고 조용히 끝낸다.
    if (e instanceof SessionDead) {
      log.error(e.message);
      process.exit(1);
    }
    if (e instanceof Quit) process.exit(1);
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
