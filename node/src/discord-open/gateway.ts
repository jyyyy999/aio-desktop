/**
 * 디스코드 게이트웨이에 붙어 메시지를 받는다.
 *
 * discord.js 를 들이지 않았다. 필요한 것은 "새 메시지가 왔다" 하나뿐이고, 그만큼은
 * Node 22 에 들어 있는 WebSocket 으로 백 줄이면 된다 — 의존성을 하나 늘려 수십 MB 를
 * 받는 것보다 낫다.
 *
 * 하는 일:
 *   HELLO 를 받으면 심장박동을 시작하고 IDENTIFY (처음) 또는 RESUME (끊겼다 다시) 를 보낸다.
 *   끊기면 몇 초 쉬었다 다시 붙는다. 이어 붙일 수 있으면 그동안 놓친 메시지도 다시 받는다.
 */
import { log, sayOk } from "../log.js";

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";

// GUILDS · GUILD_MESSAGES · MESSAGE_CONTENT.
// MESSAGE_CONTENT 가 없으면 웹훅 임베드(링크가 든 곳)가 빈 채로 온다.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

/** 다시 붙어 봐야 똑같이 거절당할 끊김. 사람이 고쳐야 한다. */
const FATAL: Record<number, string> = {
  4004: "봇 토큰이 틀렸습니다. discord_open_config.json 의 bot_token 을 확인해 주세요.",
  4010: "샤드 설정이 잘못되었습니다.",
  4011: "샤드가 필요합니다 (서버가 너무 많습니다).",
  4012: "게이트웨이 버전이 잘못되었습니다.",
  4013: "인텐트 값이 잘못되었습니다.",
  4014:
    "MESSAGE CONTENT INTENT 가 꺼져 있습니다.\n" +
    "  개발자 포털 → 내 앱 → Bot → Privileged Gateway Intents 에서\n" +
    "  'MESSAGE CONTENT INTENT' 를 켜고 저장한 다음 다시 실행해 주세요.",
};

export interface Embed {
  title?: string;
  description?: string;
  url?: string;
  fields?: { name?: string; value?: string }[];
  footer?: { text?: string };
  author?: { name?: string; url?: string };
}

export interface Message {
  id: string;
  channel_id: string;
  guild_id?: string;
  webhook_id?: string;
  content?: string;
  embeds?: Embed[];
  author?: { id: string; username?: string; bot?: boolean };
}

export interface Ready {
  user: { id: string; username: string };
  guilds: { id: string }[];
}

interface Packet {
  op: number;
  d: any;
  s?: number | null;
  t?: string | null;
}

export interface Handlers {
  onReady(ready: Ready): void;
  onGuild?(guild: { id: string; name: string }): void;
  onMessage(msg: Message): void;
}

export class Gateway {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private beat: NodeJS.Timeout | null = null;
  private acked = true;
  private stopped = false;
  private retries = 0;

  constructor(private token: string, private on: Handlers) {}

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.stopBeat();
    this.ws?.close(1000);
  }

  private connect(): void {
    const resuming = !!(this.sessionId && this.resumeUrl);
    const url = resuming ? `${this.resumeUrl}/?v=10&encoding=json` : GATEWAY;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      let packet: Packet;
      try {
        packet = JSON.parse(String(ev.data)) as Packet;
      } catch {
        return;
      }
      this.handle(packet, resuming);
    };
    ws.onerror = () => {
      // 이유는 onclose 가 코드로 알려 준다. 여기서 따로 적으면 같은 말이 두 번 찍힌다.
    };
    ws.onclose = (ev) => {
      if (ws !== this.ws) return;
      this.stopBeat();
      if (this.stopped) return;
      const fatal = FATAL[ev.code];
      if (fatal) {
        log.error(fatal);
        process.exit(1);
      }
      // 이 둘은 이어 붙일 수 없다는 뜻이다. 처음부터 다시 들어간다.
      if (ev.code === 4007 || ev.code === 4009) this.forget();
      this.retries++;
      const wait = Math.min(60, 2 ** Math.min(this.retries, 6));
      log.warn(`연결이 끊겼습니다 (${ev.code}${ev.reason ? ` ${ev.reason}` : ""}). ${wait}초 뒤 다시 붙습니다.`);
      setTimeout(() => this.connect(), wait * 1000);
    };
  }

  private handle(p: Packet, resuming: boolean): void {
    if (p.s != null) this.seq = p.s;
    switch (p.op) {
      case 10: // HELLO
        this.startBeat(p.d.heartbeat_interval as number);
        if (resuming) {
          this.send(6, { token: this.token, session_id: this.sessionId, seq: this.seq });
        } else {
          this.send(2, {
            token: this.token,
            intents: INTENTS,
            properties: { os: "windows", browser: "aio-discord-open", device: "aio-discord-open" },
          });
        }
        break;
      case 11: // 심장박동 받았음
        this.acked = true;
        break;
      case 1: // 지금 한 번 뛰어 달라
        this.send(1, this.seq);
        break;
      case 7: // 다시 붙어 달라
        this.reconnect();
        break;
      case 9: // 세션이 틀렸다. d 가 true 면 이어 붙일 수 있다
        if (!p.d) this.forget();
        setTimeout(() => this.reconnect(), 1000 + Math.random() * 4000);
        break;
      case 0:
        this.dispatch(p.t ?? "", p.d);
        break;
    }
  }

  private dispatch(type: string, d: any): void {
    switch (type) {
      case "READY":
        this.sessionId = d.session_id;
        this.resumeUrl = d.resume_gateway_url;
        this.retries = 0;
        this.on.onReady(d as Ready);
        break;
      case "RESUMED":
        this.retries = 0;
        sayOk("다시 붙었습니다. 그동안 온 알림도 이어 받습니다.");
        break;
      case "GUILD_CREATE":
        this.on.onGuild?.({ id: d.id, name: d.name });
        break;
      case "MESSAGE_CREATE":
        this.on.onMessage(d as Message);
        break;
    }
  }

  private send(op: number, d: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ op, d }));
  }

  private startBeat(interval: number): void {
    this.stopBeat();
    this.acked = true;
    const tick = () => {
      // 지난 박동에 답이 없었으면 연결이 죽은 것이다. 붙잡고 있어 봐야 알림이 안 온다.
      if (!this.acked) {
        log.warn("디스코드가 대답이 없습니다. 다시 붙습니다.");
        this.reconnect();
        return;
      }
      this.acked = false;
      this.send(1, this.seq);
    };
    // 첫 박동은 간격 안의 아무 때나. 디스코드가 그렇게 해 달라고 한다.
    this.beat = setTimeout(() => {
      tick();
      this.beat = setInterval(tick, interval);
    }, interval * Math.random());
  }

  private stopBeat(): void {
    if (this.beat) {
      clearTimeout(this.beat);
      clearInterval(this.beat);
    }
    this.beat = null;
  }

  /** 이어 붙일 수 있게 1000 이 아닌 코드로 닫는다. 닫히면 onclose 가 다시 붙인다. */
  private reconnect(): void {
    this.stopBeat();
    try {
      this.ws?.close(4000);
    } catch {
      // 이미 닫혀 있으면 onclose 가 곧 온다.
    }
  }

  private forget(): void {
    this.sessionId = null;
    this.resumeUrl = null;
    this.seq = null;
  }
}
