/**
 * 롯데온 바로구매 도우미 — **테스트 판.**
 *
 * 하는 일은 본판(src/lotte/)과 같다. 다른 것은 **쓰는 파일**뿐이다.
 *
 *   lotteon_test_config.json     설정. 처음 켤 때 본판 것을 베껴 온다 (쿠키는 빼고)
 *   lotteon_test_state.json      산 기록
 *   lotteon-test-buy.log         로그
 *   lotteon-test-pg-dump.txt     결제창 받아쓰기
 *   lotteon-test-page-dump.txt   상품 페이지 받아쓰기
 *
 * 본판을 건드리지 않고 시험해 보라고 만든 것이다. 본판과 같은 파일을 쓰면 시험 삼아
 * 돌린 한 판이 본판의 산 기록·로그·결제창 받아쓰기를 덮는다 — 실제로 그렇게 덮여서
 * 결제창을 받아 적을 유일한 기회를 날린 적이 있다.
 *
 * **쿠키는 두 벌 관리하지 않는다.** 테스트 설정에 쿠키가 비어 있으면 본판 것을 빌려 온다.
 *
 * bnkr 쪽 테스트 판(src/bnkr-test/)과 같은 짜임이다.
 *
 *   node dist/lotte-test/index.js                지켜보다가 열리면 산다
 *   node dist/lotte-test/index.js --dump-pay     지금 사고 결제창을 받아 적는다
 *   node dist/lotte-test/index.js --whoami       빌려온 세션이 살아 있는지
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
import { closeIdle } from "./warm.js";

const HELP = `롯데온 바로구매 도우미 — 테스트 판 (본판과 파일을 갈라 씁니다)

  --once                한 번만 확인하고 종료
  --dry-run             사지 않고 무엇을 살지만 본다
  --drop                드랍 모드 — 1초 주기(±0.2), 재시도 쉼 0초, 실패해도 쉬지 않음
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
  --pin [비밀번호]       간편결제 비밀번호를 설정에 저장한다. 값 없이 쓰면 클립보드에서
                        가져온다. 파일에 평문으로 남으므로, 싫으면 LOTTEON_PG_PASSWORD
                        환경변수로 넘긴다. 값은 로그에 남기지 않는다
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
  drop: boolean;
  action: string | null;
  pin: string | null;
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
    pin: null, drop: false,
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
      case "--drop": args.drop = true; break;
      case "--action": [args.action, i] = must(i, arg); break;
      case "--cookie": [args.cookie, i] = maybe(i, "-clip-"); break;
      case "--link": [args.link, i] = maybe(i, "-clip-"); break;
      // 값 없이 써도 되는 옵션. 뒤에 오는 것이 옵션이면 값이 없는 것이다.
      case "--pin": [args.pin, i] = maybe(i, ""); break;
      default:
        // 쿠키 줄을 명령줄에 붙여넣으면 셸이 그것을 여러 조각으로 쪼개 던진다. 조각에는
        // 늘 "=" 가 들어 있으므로, 그것만으로 무슨 일이 났는지 짚어 줄 수 있다.
        if (arg.includes("=")) {
          throw new Error(
            `쿠키를 명령줄에 붙여넣은 것 같습니다 (셸이 ${JSON.stringify(arg.slice(0, 30))} … 로 쪼갰습니다).\n` +
            "Cookie 줄을 복사한 뒤 값 없이 부르세요:  npm run lotte:test:cookie",
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
      "  값 없이 부르면 클립보드에서 통째로 가져옵니다:  npm run lotte:test:cookie\n" +
      "  또는 표준입력으로:                              node dist/lotte-test/index.js --cookie -",
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
 * 간편결제 비밀번호를 설정에 저장한다. 값 없이 부르면 클립보드에서 가져온다.
 *
 * 파일(lotteon_test_config.json)에 평문으로 남으므로, 그것이 싫으면 환경변수
 * LOTTEON_PG_PASSWORD 로 넘기면 된다. **값 자체는 로그에 적지 않는다** — 자릿수만 남긴다.
 */
async function savePin(cfg: Config, value: string): Promise<void> {
  let raw = value;
  if (value === "") {
    raw = clipboardText("--pin -");
    log.info(`클립보드에서 ${raw.length}자를 읽었습니다.`);
  }
  const digits = raw.replace(/\D/g, "");
  if (!digits) {
    throw new Error("비밀번호를 알아보지 못했습니다. 숫자만 입력해 주세요. " +
      "값 없이 부르면 클립보드에서 가져옵니다.");
  }
  cfg.pg_password = digits;
  saveConfig(cfg);
  log.info(`간편결제 비밀번호를 저장했습니다 (${digits.length}자리).`);
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

  if (args.pin !== null) {
    await savePin(cfg, args.pin);
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

  // 드랍 모드는 감시에만 걸린다. 한 번 사고 끝나는 --buy 에는 걸음이 없다.
  run.drop = args.drop;

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
  // 띄워 두기만 한 창은 닫는다 — 안 닫으면 태스크를 다시 켤 때마다 쌓인다 (warm.ts).
  // 주문서·결제창까지 간 창은 남는다. 멈춤 유예(6초) 안에 끝내도록 3초에서 자른다.
  void Promise.race([closeIdle(), new Promise((r) => setTimeout(r, 3000))]).finally(() => process.exit(0));
});

main()
  .then(async () => {
    // 크롬은 남긴다(detach). 여기서 그냥 끝내면 크롬드라이버가 붙들고 있어 안 꺼진다.
    // 띄워 두기만 한 창(다른 상품 것)은 닫는다.
    await Promise.race([closeIdle(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(0);
  })
  .catch(async (e) => {
    // 세션이 끊긴 것은 고장이 아니다. 무슨 일인지만 적고 조용히 끝낸다.
    if (e instanceof SessionDead) log.error(e.message);
    else if (!(e instanceof Quit)) log.error(e instanceof Error ? e.message : String(e));
    await Promise.race([closeIdle(), new Promise((r) => setTimeout(r, 3000))]);
    process.exit(1);
  });
