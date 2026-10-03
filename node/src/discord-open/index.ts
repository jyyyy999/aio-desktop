/**
 * 디스코드 알림 → 크롬 창.
 *
 *   우리 웹훅이 채널에 알림을 보낸다 → 봇이 그 메시지를 받는다 → 속에 든 링크를 크롬 새 창으로 띄운다
 *
 * waitwhile·bnkr·naver 판이 보내는 알림은 링크를 임베드의 url 에 싣는다. 그래서 그 자리를 먼저
 * 보고, 없으면 본문·필드에 적힌 주소를 찾는다.
 *
 * 봇은 읽기만 한다. 채널에 아무것도 쓰지 않는다.
 *
 *   node dist/discord-open/index.js                지켜본다
 *   node dist/discord-open/index.js --token TOKEN  봇 토큰을 저장한다
 *   node dist/discord-open/index.js --open URL     크롬이 제대로 뜨는지 한 번 열어 본다
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { log, sayOk, sayStar, sayStep } from "../log.js";
import { UI } from "../ui.js";
import { CONFIG_PATH, loadConfig, saveConfig, tokenOf, type Config } from "./config.js";
import { Gateway, type Embed, type Message } from "./gateway.js";

const HELP = `디스코드 알림이 오면 속에 든 링크를 크롬 창으로 띄웁니다

  --token 토큰        봇 토큰을 저장한다
  --channel 아이디 …   볼 채널을 정한다 (값 없이 부르면 모든 채널)
  --open 주소          크롬이 제대로 뜨는지 한 번 열어 본다
  --dry-run           열지 않고 무엇을 열지만 화면에 찍는다
`;

interface Args {
  token: string | null;
  channels: string[] | null;
  open: string | null;
  dryRun: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { token: null, channels: null, open: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} 뒤에 값이 필요합니다.\n\n${HELP}`);
      i++;
      return v;
    };
    switch (arg) {
      case "--token": args.token = next(); break;
      case "--open": args.open = next(); break;
      case "--dry-run": args.dryRun = true; break;
      case "--help": case "-h": args.help = true; break;
      case "--channel": case "--channels": {
        const list: string[] = [];
        while (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) list.push(argv[++i]!);
        args.channels = list;
        break;
      }
      default:
        throw new Error(`모르는 옵션: ${arg}\n\n${HELP}`);
    }
  }
  return args;
}

// ── 링크 고르기 ─────────────────────────────────────────────

const URL_RE = /https?:\/\/[^\s<>()"'`\]]+/g;

/** 알림에 딸려 오지만 열 것은 아닌 주소들. 썸네일·디스코드 자신. */
function worthOpening(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return !/(^|\.)(discord\.com|discordapp\.com|discordapp\.net|discord\.gg)$/i.test(host);
}

function urlsIn(text: string | undefined): string[] {
  // 마크다운 링크 [글](주소) 의 닫는 괄호나 문장 끝 마침표가 주소에 붙지 않게 뗀다.
  return (text?.match(URL_RE) ?? []).map((u) => u.replace(/[.,;:!?]+$/, ""));
}

/** 임베드의 url 이 먼저다. 우리 알림은 전부 거기에 상품·매장 주소를 싣는다. */
export function linkOf(msg: Message): string | null {
  const found: string[] = [];
  for (const e of msg.embeds ?? []) if (e.url) found.push(e.url);
  found.push(...urlsIn(msg.content));
  for (const e of msg.embeds ?? []) {
    found.push(...urlsIn(e.description));
    for (const f of e.fields ?? []) found.push(...urlsIn(f.value));
    if (e.author?.url) found.push(e.author.url);
  }
  return found.find(worthOpening) ?? null;
}

/** 키워드를 맞춰 볼 글. 제목·본문·필드·꼬리말을 모두 합친다. */
function textOf(msg: Message): string {
  const parts: string[] = [msg.content ?? ""];
  for (const e of msg.embeds ?? ([] as Embed[])) {
    parts.push(e.title ?? "", e.description ?? "", e.footer?.text ?? "", e.author?.name ?? "");
    for (const f of e.fields ?? []) parts.push(f.name ?? "", f.value ?? "");
  }
  return parts.join("\n").toLowerCase();
}

function titleOf(msg: Message): string {
  const e = msg.embeds?.[0];
  return (e?.title || msg.content || "(제목 없음)").replace(/\s+/g, " ").slice(0, 60);
}

// ── 크롬 ─────────────────────────────────────────────────

function findChrome(cfg: Config): string | null {
  if (cfg.chrome_path && existsSync(cfg.chrome_path)) return cfg.chrome_path;
  const spots = [
    process.env["PROGRAMFILES"],
    process.env["PROGRAMFILES(X86)"],
    process.env["LOCALAPPDATA"],
  ].filter(Boolean).map((root) => join(root!, "Google", "Chrome", "Application", "chrome.exe"));
  return spots.find((p) => existsSync(p)) ?? null;
}

function openInChrome(cfg: Config, url: string): boolean {
  const chrome = findChrome(cfg);
  if (!chrome) {
    log.error("크롬을 찾지 못했습니다. discord_open_config.json 의 chrome_path 에 chrome.exe 경로를 적어 주세요.");
    return false;
  }
  try {
    // 이미 켜진 크롬이 있으면 그 크롬에 새 창을 띄우고 이 프로세스는 곧 끝난다.
    const child = spawn(chrome, [...(cfg.chrome_args ?? []), url], { detached: true, stdio: "ignore" });
    child.on("error", (e) => log.error(`크롬을 띄우지 못했습니다: ${e.message}`));
    child.unref();
    return true;
  } catch (e) {
    log.error(`크롬을 띄우지 못했습니다: ${(e as Error).message}`);
    return false;
  }
}

// ── 지켜보기 ────────────────────────────────────────────────

function watch(cfg: Config, token: string, dryRun: boolean): void {
  const channels = new Set((cfg.channel_ids ?? []).map(String));
  const keywords = (cfg.keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const skips = (cfg.skip_keywords ?? []).map((k) => k.toLowerCase()).filter(Boolean);
  const opened = new Map<string, number>();
  const guilds = new Map<string, string>();

  const gateway = new Gateway(token, {
    onReady(ready) {
      sayOk(`디스코드에 붙었습니다 — 봇 ${ready.user.username}`);
      if (!ready.guilds.length) {
        const invite =
          `https://discord.com/oauth2/authorize?client_id=${ready.user.id}&scope=bot&permissions=66560`;
        log.warn(`봇이 들어가 있는 서버가 없습니다. 이 주소로 알림 받는 서버에 초대해 주세요:\n  ${invite}`);
      }
      sayStep(channels.size ? `채널 ${channels.size}곳만 봅니다: ${[...channels].join(", ")}` : "봇이 볼 수 있는 모든 채널을 봅니다.");
      sayStep(cfg.webhook_only ? "웹훅이 보낸 알림만 엽니다." : "사람이 쓴 메시지의 링크도 엽니다.");
      if (dryRun) sayStep("[dry-run] 열지 않고 무엇을 열지만 찍습니다.");
      UI.status("알림을 기다리는 중…");
    },
    onGuild(g) {
      if (!guilds.has(g.id)) log.info(`서버: ${g.name} (${g.id})`);
      guilds.set(g.id, g.name);
    },
    onMessage(msg) {
      if (channels.size && !channels.has(msg.channel_id)) return;
      if (cfg.webhook_only && !msg.webhook_id) return;

      const where = `${guilds.get(msg.guild_id ?? "") ?? "?"} #${msg.channel_id}`;
      const title = titleOf(msg);
      const text = textOf(msg);

      if (keywords.length && !keywords.some((k) => text.includes(k))) {
        log.debug(`키워드가 없어 건너뜀: ${title}`);
        return;
      }
      const skip = skips.find((k) => text.includes(k));
      if (skip) {
        log.info(`'${skip}' 이 들어 있어 열지 않음: ${title}`);
        return;
      }

      const url = linkOf(msg);
      if (!url) {
        // 임베드가 통째로 비어 있으면 MESSAGE CONTENT INTENT 가 안 먹은 것이다.
        const empty = !msg.content && !(msg.embeds ?? []).length;
        log.warn(
          empty
            ? `메시지가 비어서 왔습니다 (${where}). 개발자 포털에서 MESSAGE CONTENT INTENT 가 켜져 있는지 확인해 주세요.`
            : `링크가 없는 알림이라 건너뜀: ${title}`,
        );
        return;
      }

      const now = Date.now();
      const last = opened.get(url);
      if (last && now - last < (cfg.reopen_after_seconds ?? 60) * 1000) {
        log.info(`방금 연 주소라 다시 열지 않음: ${url}`);
        return;
      }
      opened.set(url, now);

      if (dryRun) {
        sayStar(`[dry-run] 열 것: ${url}  ← ${title}`);
      } else if (openInChrome(cfg, url)) {
        sayStar(`크롬으로 열었습니다: ${url}  ← ${title}`);
      }
      UI.status("알림을 기다리는 중…");
    },
  });

  process.on("SIGINT", () => {
    gateway.stop();
    process.exit(0);
  });
  gateway.start();
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }

  if (args.token !== null || args.channels !== null) {
    let cfg: Config;
    try {
      cfg = loadConfig();
    } catch {
      cfg = loadConfig(); // 처음이면 위에서 파일만 만들고 던진다. 만든 것을 다시 읽는다.
    }
    if (args.token !== null) cfg.bot_token = args.token.trim().replace(/^Bot\s+/i, "");
    if (args.channels !== null) cfg.channel_ids = args.channels;
    saveConfig(cfg);
    sayOk(`저장했습니다: ${CONFIG_PATH}`);
    if (args.token !== null) log.info("봇 토큰 저장 (값은 적지 않음)");
    return;
  }

  const cfg = loadConfig();

  if (args.open) {
    if (openInChrome(cfg, args.open)) sayOk(`크롬으로 열었습니다: ${args.open}`);
    return;
  }

  const token = tokenOf(cfg);
  if (!token) {
    throw new Error(
      "봇 토큰이 없습니다. 이렇게 넣어 주세요:\n  npm run discord -- --token 봇토큰\n  (만드는 법은 node/README-discord-open.md)",
    );
  }
  watch(cfg, token, args.dryRun);
}

try {
  main();
} catch (e) {
  log.error((e as Error).message);
  process.exitCode = 1;
}
