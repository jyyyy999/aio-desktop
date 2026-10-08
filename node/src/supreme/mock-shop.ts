/**
 * 검증용 **모의 슈프림 스토어**. 진짜 사이트를 두드리지 않고 흐름 전체를 시험한다.
 *
 * 진짜와 같은 모양으로 흉내 내는 것
 *   /collections/all/products.json   Shopify 표준 목록 (variant 재고 포함)
 *   /collections/all                 HTML 폴백용 목록
 *   /products/<handle>.js            variant 해석
 *   POST /cart/add.js · GET /cart.js 장바구니
 *   /checkout → /checkout/payment   2단계 체크아웃 (배송정보 → 카드)
 *   /hcaptcha-frame                  **cross-origin iframe + postMessage 토큰** 흐름 재현
 *   /checkpoint?return_to=/checkout  (checkpoint 옵션) Shopify 체크포인트 — 캡차를 풀고 **버튼을 눌러야** 넘어간다
 *   /thank_you                       주문 완료
 *
 * hCaptcha 재현이 핵심이다: iframe 안에서 사람이 체크하면 postMessage 로 부모에 토큰이 가고,
 * 부모가 숨은 textarea[name="h-captcha-response"] 에 적는다 — 진짜와 같은 경로다.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockShop {
  origin: string;
  close(): Promise<void>;
  /** 지금까지 들어온 요청 (사람이 눈으로 확인) */
  hits: string[];
  cart: { id: string; variantId: string; quantity: number; handle: string }[];
}

const PRODUCTS = [
  {
    id: 9001,
    handle: "box-logo-tee",
    title: "Box Logo Tee",
    product_type: "T-Shirts",
    vendor: "Supreme",
    tags: "tee, box logo",
    published_at: "2026-01-01T00:00:00-05:00",
    images: [{ src: "/img/tee.png" }],
    options: ["Color", "Size"],
    variants: [
      { id: 50011, title: "Black / Medium", option1: "Black", option2: "Medium", available: true, price: 4800, sku: "TEE-BLK-M" },
      { id: 50012, title: "Black / Large", option1: "Black", option2: "Large", available: false, price: 4800, sku: "TEE-BLK-L" },
      { id: 50013, title: "White / Large", option1: "White", option2: "Large", available: true, price: 4800, sku: "TEE-WHT-L" },
    ],
  },
  {
    id: 9002,
    handle: "camp-cap",
    title: "Camp Cap",
    product_type: "Hats",
    vendor: "Supreme",
    tags: "hat",
    published_at: "2026-01-01T00:00:00-05:00",
    images: [{ src: "/img/cap.png" }],
    options: ["Color"],
    variants: [{ id: 50021, title: "Navy", option1: "Navy", available: false, price: 5400, sku: "CAP-NVY" }],
  },
];

const html = (title: string, body: string): string => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body{font:14px/1.6 system-ui,'Malgun Gothic',sans-serif;margin:0;padding:24px;background:#f6f6f6;color:#111}
  header{padding:12px 24px;background:#111;color:#fff;margin:-24px -24px 20px}
  .grid{display:flex;gap:16px;flex-wrap:wrap}
  .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px;width:200px}
  .sold{color:#b00;font-weight:700}
  form{background:#fff;border:1px solid #ddd;border-radius:8px;padding:16px;max-width:560px}
  label{display:block;margin:10px 0 4px;font-weight:600}
  input,select{width:100%;padding:8px;border:1px solid #bbb;border-radius:6px;font-size:14px}
  button{margin-top:16px;padding:10px 18px;background:#111;color:#fff;border:0;border-radius:6px;font-size:15px;cursor:pointer}
  button:disabled{background:#999}
  #cap{margin-top:16px}
  .rate{display:block;margin:6px 0}
  iframe{border:1px solid #ccc;border-radius:6px;background:#fff}
  .err{color:#b00}
</style></head><body>
<header><b>SUPREME</b> <span style="opacity:.7">mock store</span></header>
${body}
</body></html>`;

function listingHtml(): string {
  const cards = PRODUCTS.map((p) => {
    const sold = !p.variants.some((v) => v.available);
    return `<div class="card">
      <a href="/products/${p.handle}" title="${p.title}"><b>${p.title}</b></a>
      <div>${p.variants[0] ? `$${(p.variants[0].price / 100).toFixed(2)}` : ""}</div>
      ${sold ? '<div class="sold">Sold Out</div>' : '<div>In Stock</div>'}
    </div>`;
  }).join("");
  return html("All - Shop - Supreme", `<h2>All</h2><div class="grid">${cards}</div>`);
}

function checkoutHtml(): string {
  return html(
    "Checkout - Supreme",
    `<h2>Checkout</h2>
<form id="checkout" onsubmit="return false">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" />
  <label for="firstName">First name</label>
  <input id="firstName" name="firstName" autocomplete="given-name" />
  <label for="lastName">Last name</label>
  <input id="lastName" name="lastName" autocomplete="family-name" />
  <label for="address1">Address</label>
  <input id="address1" name="address1" autocomplete="address-line1" />
  <label for="city">City</label>
  <input id="city" name="city" autocomplete="address-level2" />
  <label for="postalCode">ZIP</label>
  <input id="postalCode" name="postalCode" autocomplete="postal-code" />
  <label for="phone">Phone</label>
  <input id="phone" name="phone" type="tel" autocomplete="tel" />
  <label for="countryCode">Country</label>
  <select id="countryCode" name="countryCode" autocomplete="country">
    <option value="KR">대한민국</option>
    <option value="US">United States</option>
    <option value="JP">日本</option>
  </select>
  <div id="cap">
    <div style="font-weight:600;margin-bottom:6px">사람 확인</div>
    <iframe id="capframe" src="/hcaptcha-frame" width="320" height="90" title="hCaptcha"></iframe>
  </div>
  <textarea name="h-captcha-response" style="display:none"></textarea>
  <div id="msg" class="err"></div>
  <button id="continue_button" type="submit">Continue to payment</button>
</form>
<script>
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "hcaptcha-token") {
      document.querySelector('textarea[name="h-captcha-response"]').value = e.data.token;
    }
  });
  document.getElementById("continue_button").addEventListener("click", () => {
    const token = document.querySelector('textarea[name="h-captcha-response"]').value;
    if (token.length < 20) { document.getElementById("msg").textContent = "캡차를 먼저 풀어 주세요"; return; }
    location.href = "/checkout/payment";
  });
</script>`
  );
}

/** Shopify 체크포인트 — 진짜처럼 캡차 + 버튼. 토큰 없이 누르면 같은 화면이 다시 나온다. */
function checkpointHtml(returnTo: string, error = ""): string {
  return html(
    "Checkpoint - Supreme",
    `<h2>Checkpoint</h2>
<p>Please confirm you are human to continue to checkout.</p>
<form id="checkpoint" method="post" action="/checkpoint">
  <input type="hidden" name="return_to" value="${returnTo.replace(/"/g, "&quot;")}" />
  <div id="cap">
    <iframe src="/hcaptcha-frame" width="320" height="90" title="hCaptcha"></iframe>
  </div>
  <textarea name="h-captcha-response" style="display:none"></textarea>
  <div class="err">${error}</div>
  <button type="submit">Submit</button>
</form>
<script>
  window.addEventListener("message", (e) => {
    if (e.data && e.data.type === "hcaptcha-token") {
      document.querySelector('textarea[name="h-captcha-response"]').value = e.data.token;
    }
  });
</script>`,
  );
}

function paymentHtml(): string {
  return html(
    "Payment - Supreme",
    `<h2>Payment</h2>
<form id="pay" onsubmit="return false">
  <div style="font-weight:600;margin:8px 0">배송 방법</div>
  <label class="rate"><input type="radio" name="shipping_method" data-price="0" checked /> 무료 배송 (7-14일)</label>
  <label class="rate"><input type="radio" name="shipping_method" data-price="2500" /> 특급 배송 (2-3일)</label>
  <div style="font-weight:600;margin:14px 0 6px">카드</div>
  <iframe name="card-fields-number" src="/card-field?f=number" width="320" height="46" title="Card number"></iframe>
  <iframe name="card-fields-expiry" src="/card-field?f=expiry" width="150" height="46" title="Expiration date"></iframe>
  <iframe name="card-fields-verification_value" src="/card-field?f=cvv" width="150" height="46" title="Security code"></iframe>
  <label><input type="checkbox" name="billingSameAsShipping" checked /> 청구지 = 배송지</label>
  <div id="msg" class="err"></div>
  <button id="checkout-pay-button" type="submit">Pay now</button>
</form>
<script>
  document.getElementById("checkout-pay-button").addEventListener("click", () => {
    const num = document.querySelector('iframe[name="card-fields-number"]');
    document.getElementById("msg").textContent = "";
    location.href = "/thank_you";
  });
</script>`
  );
}

function cardFieldHtml(field: string): string {
  const map: Record<string, { id: string; name: string; ac: string; ph: string }> = {
    number: { id: "number", name: "number", ac: "cc-number", ph: "1234 5678 9012 3456" },
    expiry: { id: "expiry", name: "expiry", ac: "cc-exp", ph: "MM / YY" },
    cvv: { id: "verification_value", name: "verification_value", ac: "cc-csc", ph: "CVC" },
  };
  const f = map[field] ?? map["number"]!;
  return html(
    `Card ${field}`,
    `<input id="${f.id}" name="${f.name}" autocomplete="${f.ac}" placeholder="${f.ph}" style="width:100%;padding:10px;border:1px solid #bbb;border-radius:6px" />`
  );
}

function hcaptchaFrameHtml(): string {
  return html(
    "hCaptcha",
    `<div style="display:flex;align-items:center;gap:12px;margin:-16px;padding:16px;background:#fafafa;border-radius:6px">
      <input type="checkbox" id="cb" style="width:22px;height:22px" />
      <label for="cb" style="margin:0">I am human</label>
      <span style="margin-left:auto;font-size:11px;color:#888">hCaptcha(mock)</span>
    </div>
    <script>
      document.getElementById("cb").addEventListener("change", (e) => {
        if (!e.target.checked) return;
        setTimeout(() => {
          parent.postMessage({ type: "hcaptcha-token", token: "P0_MOCK_TOKEN_" + Date.now() + "_" + "x".repeat(30) }, "*");
        }, 300);
      });
    </script>`
  );
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf-8");
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(text);
}

/** 모의 스토어를 띄운다. origin 을 돌려준다 (예: http://127.0.0.1:53123). */
export async function startMockShop(
  options: { blockedProductsJson?: boolean; blockedProductJson?: boolean; checkpoint?: boolean } = {},
): Promise<MockShop> {
  const hits: string[] = [];
  const cart: MockShop["cart"] = [];

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    hits.push(`${req.method} ${path}`);

    if (path === "/collections/all/products.json") {
      if (options.blockedProductsJson) {
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<h1>Access denied</h1><p>You do not have permission to access this website</p>");
        return;
      }
      json(res, 200, { products: PRODUCTS });
      return;
    }
    if (path === "/collections/all") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(listingHtml());
      return;
    }
    if (path.startsWith("/products/") && path.endsWith(".js")) {
      if (options.blockedProductJson) {
        // 진짜 슈프림이 이렇다 (2026-10-08 확인: 403 + 사람 확인 HTML).
        res.writeHead(403, { "content-type": "text/html" });
        res.end("<!DOCTYPE html><html><head><title>Access denied</title></head><body>You do not have permission to access this website</body></html>");
        return;
      }
      const handle = path.slice("/products/".length, -".js".length);
      const product = PRODUCTS.find((p) => p.handle === handle);
      if (!product) {
        json(res, 404, { message: "not found" });
        return;
      }
      json(res, 200, {
        id: product.id,
        title: product.title,
        handle: product.handle,
        type: product.product_type,
        vendor: product.vendor,
        tags: product.tags,
        options: product.options,
        variants: product.variants.map((v) => {
          const option2 = (v as { option2?: string }).option2;
          return {
            id: v.id, title: v.title, price: v.price, available: v.available, sku: v.sku,
            option1: v.option1, option2,
            options: [v.option1, option2].filter((x): x is string => !!x),
          };
        }),
      });
      return;
    }
    if (path === "/cart/add.js" && req.method === "POST") {
      const body = await readBody(req);
      let wanted: { id?: number; quantity?: number } | null = null;
      try {
        const parsed = JSON.parse(body) as { items?: { id?: number; quantity?: number }[] };
        wanted = parsed.items?.[0] ?? null;
      } catch {
        wanted = null;
      }
      const variantId = String(wanted?.id ?? "");
      const product = PRODUCTS.find((p) => p.variants.some((v) => String(v.id) === variantId));
      const variant = product?.variants.find((v) => String(v.id) === variantId);
      if (!variant || !variant.available) {
        json(res, 422, { status: 422, message: "Cart Error", description: "품절이거나 없는 상품입니다" });
        return;
      }
      cart.push({ id: `${variant.id}-${cart.length + 1}`, variantId, quantity: Number(wanted?.quantity ?? 1), handle: product?.handle ?? "" });
      json(res, 200, { id: variantId, quantity: Number(wanted?.quantity ?? 1), title: `${product?.title} - ${variant.title}` });
      return;
    }
    if (path === "/cart.js") {
      json(res, 200, {
        item_count: cart.reduce((n, i) => n + i.quantity, 0),
        total_price: cart.length * 4800,
        items: cart.map((i) => ({ product_title: i.handle, variant_title: i.variantId, quantity: i.quantity })),
      });
      return;
    }
    // 상품 **페이지** — 진짜 슈프림처럼 variant JSON 을 통째로 박아 둔다 (이게 실제로 쓰는 길이다).
    if (/^\/products\/[A-Za-z0-9_-]+$/.test(path)) {
      const handle = path.slice("/products/".length);
      const product = PRODUCTS.find((p) => p.handle === handle);
      if (!product) {
        res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
        res.end(html("404", `<h2>404</h2><p>${handle}</p>`));
        return;
      }
      const payload = {
        id: product.id,
        title: product.title,
        handle: product.handle,
        type: product.product_type,
        vendor: product.vendor,
        available: product.variants.some((v) => v.available),
        options: product.options,
        variants: product.variants.map((v) => ({
          id: v.id, title: v.title, option1: v.option1, option2: (v as { option2?: string }).option2 ?? null, option3: null,
          sku: v.sku, available: v.available, price: v.price, options: [v.option1, (v as { option2?: string }).option2].filter(Boolean),
        })),
      };
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        html(
          `${product.title} - Supreme`,
          `<h2>${product.title}</h2>
<div class="grid">${product.variants.map((v) => `<button>${v.title}</button>`).join("")}</div>
<button id="add-to-cart">Add to cart</button>
<script type="application/json" id="product-${handle}-json">${JSON.stringify(payload)}</script>`,
        ),
      );
      return;
    }
    // 체크포인트 — 통과 쿠키가 없으면 /checkout 을 /checkpoint 로 돌린다 (진짜 Shopify 처럼).
    if (path === "/checkpoint" && req.method === "POST") {
      const form = new URLSearchParams(await readBody(req));
      const back = form.get("return_to") || "/checkout";
      if ((form.get("h-captcha-response") ?? "").length > 20) {
        res.writeHead(302, { location: back, "set-cookie": "mock_checkpoint=ok; Path=/" });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(checkpointHtml(back, "캡차를 먼저 풀어 주세요"));
      }
      return;
    }
    if (path === "/checkpoint") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(checkpointHtml(url.searchParams.get("return_to") || "/checkout"));
      return;
    }
    if (path === "/checkout" && options.checkpoint && !/mock_checkpoint=ok/.test(req.headers.cookie ?? "")) {
      res.writeHead(302, { location: "/checkpoint?return_to=%2Fcheckout" });
      res.end();
      return;
    }
    if (path === "/checkout") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(checkoutHtml());
      return;
    }
    if (path === "/checkout/payment") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(paymentHtml());
      return;
    }
    if (path === "/card-field") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(cardFieldHtml(url.searchParams.get("f") ?? "number"));
      return;
    }
    if (path === "/hcaptcha-frame") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(hcaptchaFrameHtml());
      return;
    }
    if (path === "/thank_you") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(html("Thank you - Supreme", `<h2>Thank you</h2><p>Order number: MOCK-123456</p>`));
      return;
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end(html("404", `<h2>404</h2><p>${path}</p>`));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    hits,
    cart,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
