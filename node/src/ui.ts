/**
 * 터미널에 진행 상황을 보여 준다. bnkr_console.py 를 그대로 옮긴 것이다.
 *
 * 로그 파일은 전부 적는 데 쓰고, 화면은 지금 무슨 일이 벌어지는지 한눈에 보는 데 쓴다.
 * 둘은 목적이 다르다 — 파일에는 나중에 따질 것이 남아야 하고, 화면에는 지금 볼 것만
 * 있으면 된다.
 *
 * 기다리는 동안 찍히는 줄은 한 줄만 쓰고 제자리에서 고쳐 쓴다. 15초마다 "아직 품절" 을
 * 새 줄로 쌓으면 정작 봐야 할 것이 위로 밀려 올라간다.
 *
 * **태스크 표 모드.** 통합 러너(src/task/)가 setTaskTable() 로 켜면, 화면은 매 초
 * 통째로 다시 그려진다 — 위는 태스크 표, 아래는 지나간 로그의 꼬리. 사이트 루프들이
 * 찍는 줄은 파일에는 그대로 적히고, 화면에는 이 표가 대신 보여 준다.
 */

export type Kind = "ok" | "info" | "step" | "warn" | "err" | "star" | "status";

// 종류마다 기호와 색. 기호는 한 칸짜리로 골랐다 — 줄이 밀리면 읽기 나빠진다.
const MARKS: Record<string, [string, string]> = {
  ok: ["✔", "32"],   // 초록 — 된 일
  info: ["·", "37"], // 회색 — 그냥 지나가는 말
  step: ["▸", "36"], // 청록 — 단계가 넘어감
  warn: ["!", "33"], // 노랑 — 어긋났지만 계속 감
  err: ["✖", "31"],  // 빨강 — 멈춤
  star: ["★", "35"], // 자홍 — 사람이 손댈 차례 (QR·결제완료)
};

/** 한글은 두 칸을 먹는다. 상자 테두리를 맞추려면 세어 줘야 한다. */
export function width(text: string): number {
  let total = 0;
  for (const ch of text) {
    total += (ch.codePointAt(0) ?? 0) > 0x1100 ? 2 : 1;
  }
  return total;
}

/**
 * 표의 한 칸. 넘치면 자르고 모자라면 채워, 어느 글자가 들어와도 폭이 size 로 같다.
 *
 * 자를 때 폭으로 세는 것이 요점이다. 글자 수로 자르면 한글이 섞인 칸만 두 배로 삐져나가
 * 세로줄이 어긋난다.
 */
export function cell(text: string, size: number): string {
  // 딱 맞게 들어가면 자르지 않는다. … 자리를 늘 비워 두면 size 칸에 size 칸짜리 글자가
  // 안 들어가는 꼴이 된다 — "DIRECT" 가 6칸 칸에서 "DIREC…" 로 잘리는 식이다.
  const full = width(text);
  if (full <= size) return text + " ".repeat(size - full);

  let out = "";
  let used = 0;
  for (const ch of text) {
    const w = (ch.codePointAt(0) ?? 0) > 0x1100 ? 2 : 1;
    // 잘렸다는 표시(…)에도 한 칸이 든다. 그 자리를 남겨 두고 센다.
    if (used + w > size - 1) break;
    out += ch;
    used += w;
  }
  return out + "…" + " ".repeat(Math.max(0, size - used - 1));
}

function stamp(): string {
  const now = new Date();
  const two = (n: number) => String(n).padStart(2, "0");
  return `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
}

export class Console_ {
  /** 제자리에서 고쳐 쓰는 중인 줄. */
  private pending = "";
  /**
   * 화면인가, 아니면 파일·파이프인가.
   *
   * 제자리에서 고쳐 쓰는 줄(status)은 **화면일 때만** 뜻이 있다. 파일로 넘어가면
   * \r 는 개행이 아니라서 하루치 카운트다운이 통째로 한 줄에 쌓인다 — 서비스로
   * 띄워 두고 journald 로 받을 때 특히 그렇다.
   */
  private tty = process.stdout.isTTY === true;
  // 색을 낼 수 있는가. 윈도우 터미널은 요즘 다 되지만, 파일로 넘길 때는 끈다.
  private color = process.stdout.isTTY === true && !process.env["NO_COLOR"];

  // --- 태스크 표 모드 -----------------------------------------------------
  // 표를 그려 주는 함수. null 이면 평범한 줄 모드다. 통합 러너만 이걸 켠다.
  private table: (() => string[]) | null = null;
  /** 표 모드에서 쌓이는 지나간 로그 줄. 화면에는 꼬리만 보여 준다. */
  private scroll: string[] = [];
  private tableTimer: ReturnType<typeof setInterval> | null = null;
  /** 마지막으로 화면을 다시 그린 시각. 줄마다 다시 그리면 훑기(50개) 중에 번쩍인다. */
  private lastDraw = 0;

  private paint(text: string, code: string): string {
    return this.color ? `\u001b[${code}m${text}\u001b[0m` : text;
  }

  private write(text: string): void {
    try {
      process.stdout.write(text);
    } catch {
      // 화면에 못 찍는다고 하던 일을 멈출 이유는 없다.
    }
  }

  /**
   * 태스크 표 모드를 켜고 끈다. fn 은 표를 그려 줄 함수 — 매 초 그리고,
   * 로그 줄이 들어올 때마다 다시 그린다.
   *
   * 켜져 있는 동안 banner·status 는 무시된다. 표가 대신 말해 준다.
   * 파일로 넘길 때(TTY 아님)는 표를 그리지 않고 원래 줄 모드로 돌아간다.
   */
  setTaskTable(fn: (() => string[]) | null): void {
    this.table = fn;
    if (fn && this.color) {
      this.scroll = [];
      this.tableTimer ??= setInterval(() => this.redraw(), 1000);
      this.redraw();
    } else if (this.tableTimer) {
      clearInterval(this.tableTimer);
      this.tableTimer = null;
    }
  }

  /**
   * 표 모드용 다시 그리기. 화면을 지우고 표 + 로그 꼬리를 처음부터 그린다.
   *
   * **모든 로그 줄마다 다시 그리지 않는다.** 훑기 한 바퀴가 50개면 50번 다시
   * 그려져 번쩍인다. 150ms 안에 온 줄은 한 번으로 합친다. 1초 타이머가 끝에
   * 한 번 더 그려 남는 것을 지운다.
   */
  private redraw(): void {
    if (!this.table || !this.color) return;
    const now = Date.now();
    if (now - this.lastDraw < 150) return;
    this.lastDraw = now;

    const rows = this.table();
    const tail = this.scroll.slice(-24);
    let out = "\u001b[2J\u001b[H";
    for (const line of rows) out += line + "\n";
    if (tail.length) out += "\n" + tail.join("\n") + "\n";
    this.write(out);
  }

  /** 고쳐 쓰던 줄을 지운다. 새 줄을 앉히기 전에 부른다. */
  clear(): void {
    if (this.table && this.color) return;
    if (!this.pending) return;
    if (this.color) this.write("\r\u001b[K");
    else this.write("\r" + " ".repeat(width(this.pending) + 2) + "\r");
    this.pending = "";
  }

  banner(title: string, lines: string[]): void {
    if (this.table && this.color) {
      // 표가 위에서 말해 주므로 배너는 로그 꼬리로만 남긴다.
      const box = Math.max(...lines.map((l) => width(l) + 3), title.length + 6, 46);
      this.scroll.push(this.paint(`┌ ${title} ` + "─".repeat(box - title.length - 3), "36"));
      for (const line of lines) this.scroll.push(this.paint("│", "36") + ` ${line}`);
      this.scroll.push(this.paint("└" + "─".repeat(box - 1), "36"));
      this.redraw();
      return;
    }
    this.clear();
    const box = Math.max(...lines.map((l) => width(l) + 3), title.length + 6, 46);
    this.write(this.paint(`┌ ${title} ` + "─".repeat(box - title.length - 3), "36") + "\n");
    for (const line of lines) this.write(this.paint("│", "36") + ` ${line}\n`);
    this.write(this.paint("└" + "─".repeat(box - 1), "36") + "\n");
  }

  /** 화면에 남는 줄. 지나간 일은 여기 쌓인다. */
  line(text: string, kind: Kind = "info"): void {
    if (this.table && this.color) {
      const [mark, code] = MARKS[kind] ?? MARKS["info"]!;
      const head = this.paint(stamp(), "90") + "  " + this.paint(mark, code) + "  ";
      const body = kind === "err" || kind === "star" ? this.paint(text, code) : text;
      this.scroll.push(head + body);
      if (this.scroll.length > 60) this.scroll.splice(0, this.scroll.length - 60);
      this.redraw();
      return;
    }
    this.clear();
    const [mark, code] = MARKS[kind] ?? MARKS["info"]!;
    const head = this.paint(stamp(), "90") + "  " + this.paint(mark, code) + "  ";
    const body = kind === "err" || kind === "star" ? this.paint(text, code) : text;
    this.write(head + body + "\n");
  }

  /** 제자리에서 고쳐 쓰는 줄. 기다리는 동안 쓰는 자리다. */
  status(text: string): void {
    if (this.table && this.color) return; // 표가 대신 보여 준다.
    // 화면이 아니면 아무것도 안 적는다. 지나간 일은 로그 파일에 이미 다 있다.
    if (!this.tty) return;
    const plain = " ".repeat(10) + text;
    if (plain.length < this.pending.length) {
      this.write("\r" + " ".repeat(this.pending.length + 2));
    }
    this.write("\r" + " ".repeat(10) + this.paint(text, "90"));
    this.pending = plain;
  }
}

export const UI = new Console_();
