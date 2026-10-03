/**
 * 네이버 브랜드스토어·스마트스토어 바로구매 도우미 — Node.js/TypeScript 판.
 *
 * naver_buy.py 가 하던 일을 그대로 한다. 하는 일도, 멈추는 자리도 같다.
 *
 *   감시(초 단위) → 구매 가능 감지 → 바로구매 클릭 → 디스코드 알림 + 주문서 → [사람] 결제
 *
 * **결제 확정은 사람이 누른다.** 네이버페이 주문서까지만 간다. 여기서 한 걸음 더 갈
 * 이유도 없다 — 네이버는 결제가 끝나야 재고를 깎는다. 주문서를 열어 둔다고 물건을 잡아
 * 두는 것이 아니라서, 사람이 늦게 눌러 놓치는 것과 자동으로 눌러 앞지르는 것 사이에
 * 우리가 얻는 것은 "알림 받고 뛰어오는 시간" 뿐이다.
 *
 * 로그인도 자동화하지 않는다. 네이버 로그인에는 캡차와 기기 등록이 걸려 있다.
 * **브라우저에서 직접 로그인한 세션 쿠키를 빌려 쓴다** (신분은 NID_AUT·NID_SES 가 진다).
 * 봇 차단을 우회하거나, 캡차를 풀거나, 계정을 여러 개 굴리지 않는다.
 *
 * 설정·상태·로그는 파이썬 판이 쓰던 파일을 그대로 쓴다.
 *
 *   node dist/naver/index.js                지켜보다가 열리면 산다
 *   node dist/naver/index.js --cookie       클립보드의 Cookie 줄을 설정에 저장
 *   node dist/naver/index.js --link         클립보드의 상품 주소를 대상으로 삼고 곧장 감시
 *   node dist/naver/index.js --whoami       빌려온 세션이 살아 있는지
 *   node dist/naver/index.js --dump-pay     지금 사고, 결제하기 뒤 화면을 받아 적는다
 */
import { existsSync, unlinkSync } from "node:fs";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import {
  CAPTCHA_TICKET, hasLoginCookie, newSession, type Session,
} from "./http.js";
import {
  ACTIONS, actionOf, cookieOf, loadConfig, loadState, overrideForRun, Quit, run, saveConfig,
  saveState, STATE_PATH,
  type Config, type OrderAction, type State,
} from "./config.js";
import {
  clipboardText, cmdAdd, cmdBuy, cmdLink, cmdProbe, cmdStatus, cmdWhoami,
} from "./commands.js";
import { NeedsWindow, SessionDead, watch } from "./watch.js";
import { watchInBrowser, WindowClosed } from "./window.js";
import { targetFor } from "./targets.js";

const HELP = `네이버 브랜드스토어·스마트스토어 바로구매 도우미 (Node.js 판)

  --once                한 번만 확인하고 종료
  --dry-run             사지 않고 무엇을 살지만 본다
  --status              대상 상품의 현재 재고만
  --probe [URL]         상품 페이지를 뜯어보고 naver-page-dump.txt 에 남긴다
  --whoami              빌려온 세션이 살아 있는지
  --add URL …           살 상품을 넣는다
  --link [URL]          클립보드의 상품 주소를 대상으로 삼고 곧장 감시한다 (- 는 표준입력)
  --buy [URL]           지금 바로 산다, order_action 이 정한 데까지 (주소 없이 부르면 설정의 첫 상품)
  --dump-pay [URL]      --buy 와 같되, 끝난 뒤 화면을 naver-pg-dump.txt 에 받아 적는다
  --action open|submit  이번만 어디까지 갈지 (기본은 설정의 order_action)
  --watch-browser [URL] 크롬 창을 띄워 그 안에서 지켜본다 (캡차가 있는 스마트스토어용)
  --pin [비밀번호]        간편결제 비밀번호를 설정에 저장한다. 값 없이 쓰면 클립보드에서
                        가져온다. 저장하면 submit 에서 **결제까지 끝난다**. 지우려면 --pin clear
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
  pin: string | null;
  link: string | null;
  buy: string | null;
  dumpPay: string | null;
  action: string | null;
  watchBrowser: string | null;
}

/**
 * 손으로 짠 인자 파서.
 *
 * argparse 의 nargs="+" 와 "값 없이 써도 되는 옵션"(--cookie·--link·--buy…)이 둘 다
 * 필요한데, Node 의 parseArgs 는 어느 쪽도 못 한다. 파이썬 판과 같은 말이 통해야 하므로
 * 여기서 센다.
 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    once: false, dryRun: false, status: false, whoami: false, reset: false, help: false,
    add: null, probe: null, cookie: null, pin: null, link: null, buy: null, dumpPay: null, action: null,
    watchBrowser: null,
  };

  const isFlag = (v: string | undefined) => v !== undefined && v.startsWith("--");
  // nargs="?" 자리. 뒤에 오는 것이 옵션이면 값이 없는 것이다.
  const maybe = (i: number, blank: string): [string, number] =>
    isFlag(argv[i + 1]) || argv[i + 1] === undefined ? [blank, i] : [argv[i + 1]!, i + 1];
  // 값이 꼭 있어야 하는 자리.
  const must = (i: number, flag: string): [string, number] => {
    if (isFlag(argv[i + 1]) || argv[i + 1] === undefined) {
      throw new Error(`${flag} 뒤에 값이 필요합니다.\n\n${HELP}`);
    }
    return [argv[i + 1]!, i + 1];
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
      case "--watch-browser": [args.watchBrowser, i] = maybe(i, ""); break;
      case "--cookie": [args.cookie, i] = maybe(i, "-clip-"); break;
      case "--pin": [args.pin, i] = maybe(i, "-clip-"); break;
      case "--link": [args.link, i] = maybe(i, "-clip-"); break;
      default:
        // 쿠키 줄을 명령줄에 붙여넣으면 셸이 그것을 여러 조각으로 쪼개 던진다. 조각에는
        // 늘 "=" 가 들어 있으므로, 그것만으로 무슨 일이 났는지 짚어 줄 수 있다.
        if (arg.includes("=")) {
          throw new Error(
            `쿠키를 명령줄에 붙여넣은 것 같습니다 (셸이 ${JSON.stringify(arg.slice(0, 30))} … 로 쪼갰습니다).\n` +
            "Cookie 줄을 복사한 뒤 값 없이 부르세요:  npm run naver:cookie",
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
      "  값 없이 부르면 클립보드에서 통째로 가져옵니다:  npm run naver:cookie\n" +
      "  또는 표준입력으로:                              node dist/naver/index.js --cookie -",
    );
  }

  if (!hasLoginCookie(raw)) {
    log.warn("NID_AUT·NID_SES 가 안 보입니다. 로그인한 창에서 복사한 것이 맞는지 봐주세요.");
  }

  cfg.cookie = raw;
  saveConfig(cfg);
  sayOk(`쿠키 ${names.length}개를 저장했습니다: ` +
    names.slice(0, 8).join(", ") + (names.length > 8 ? " …" : ""));

  // 캡차 티켓이 실려 왔는지. 스마트스토어 상품을 HTTP 로 보려면 이게 있어야 한다.
  if (names.some((name) => name.toLowerCase() === CAPTCHA_TICKET.toLowerCase())) {
    sayStar(`캡차 티켓(${CAPTCHA_TICKET})도 들어 있습니다 — 스마트스토어도 열릴 수 있습니다`);
  } else {
    log.info(`캡차 티켓(${CAPTCHA_TICKET})은 없습니다. 없어도 됩니다 — ` +
      "세션이 싱싱하면 스마트스토어도 열립니다.");
  }
  sayStep("--whoami 로 확인해 보세요.");
}

/**
 * 간편결제 비밀번호를 설정에 저장한다. 값 없이 부르면 클립보드에서 가져온다.
 *
 * 파일(naver_buy_config.json)에 평문으로 남는다. 그게 싫으면 환경변수 NAVER_PG_PASSWORD 로
 * 넘기면 된다. **값 자체는 로그에 적지 않는다** — 자릿수만 남긴다. 클립보드에서 가져왔으면
 * 클립보드는 사람이 비우도록 일러 준다.
 */
function savePin(cfg: Config, value: string): void {
  if (value.toLowerCase() === "clear") {
    cfg.pg_password = "";
    saveConfig(cfg);
    sayOk("간편결제 비밀번호를 지웠습니다 — submit 은 이제 인증 화면 앞에서 멈춥니다.");
    return;
  }
  const raw = value === "-clip-" ? clipboardText("--pin <비밀번호>") : value;
  const digits = raw.replace(/\D/g, "");
  if (!digits) {
    throw new Error("비밀번호를 알아보지 못했습니다. 숫자만 넣어 주세요 (값 없이 부르면 클립보드에서).");
  }
  if (digits.length !== 6) log.warn(`${digits.length}자리입니다. 네이버페이 간편결제 비밀번호는 보통 6자리입니다.`);
  cfg.pg_password = digits;
  saveConfig(cfg);
  sayOk(`간편결제 비밀번호를 저장했습니다 (${digits.length}자리).`);
  if (String(cfg.order_action).toLowerCase() === "submit") {
    log.warn("order_action 이 submit 입니다 — 이제 재고가 열리면 **사람 손 없이 결제까지** 합니다.");
  } else {
    log.info("order_action 이 open 이라 아직 쓰이지 않습니다. 쓰려면 submit 으로 두세요.");
  }
  if (value === "-clip-") log.info("클립보드에 비밀번호가 남아 있습니다. 다른 것을 복사해 덮어 두세요.");
}

/**
 * 지켜보는 중인 상태. SIGINT 로 끊길 때 적어 두려고 붙잡아 둔다.
 * 담긴 기록을 잃으면 다음 실행에서 같은 것을 또 산다.
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

  // 이번 실행에서만 바꾼다. 설정 파일에는 쓰지 않는다 — 한 번 시험해 본 것이 켜 놓고
  // 잊어버리는 설정으로 남으면 안 된다.
  if (args.action !== null) {
    const asked = args.action.toLowerCase() as OrderAction;
    if (!ACTIONS.includes(asked)) {
      throw new Error(`--action 은 ${ACTIONS.join(" / ")} 중 하나입니다: ${args.action}`);
    }
    overrideForRun(cfg, "order_action", asked);
  }

  if (args.cookie !== null) {
    await saveCookie(cfg, args.cookie);
    return;
  }

  if (args.pin !== null) {
    savePin(cfg, args.pin);
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
    log.debug(`어디까지 가는가: ${actionOf(cfg)}`);
    try {
      await cmdBuy(cfg, session, state, buying || targetFor(cfg, "").url, args.dumpPay !== null);
    } finally {
      // 창에서 산 경우 기록이 남는다. 저장해 둬야 감시가 같은 걸 또 사지 않는다.
      saveState(state);
    }
    return;
  }

  try {
    if (args.watchBrowser !== null) {
      // 주소를 직접 줬으면 그 주소를 본다. 안 줬으면 설정을 따라간다 — 켜 놓은 채로
      // targets 의 주소를 바꾸면 창이 새 상품으로 옮겨 간다.
      await watchInBrowser(cfg, state, targetFor(cfg, args.watchBrowser), args.once,
        args.watchBrowser === "");
    } else {
      try {
        await watch(cfg, session, state, args.once);
      } catch (e) {
        if (!(e instanceof NeedsWindow)) throw e;
        // HTTP 로 못 보는 상품이다. 같은 상품을 크롬 창에서 이어서 본다.
        saveState(state);
        await watchInBrowser(cfg, state, e.target, args.once, true);
      }
    }
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
    // 세션이 끊긴 것과 창이 닫힌 것은 고장이 아니다. 무슨 일인지만 적고 조용히 끝낸다.
    if (e instanceof SessionDead || e instanceof WindowClosed) {
      log.error(e.message);
      process.exit(1);
    }
    if (e instanceof Quit) process.exit(1);
    log.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
