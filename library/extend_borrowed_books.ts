import { DOMParser, Element } from "jsr:@b-fuze/deno-dom@0.1.56";
import {
  Array as A,
  Duration,
  Effect as E,
  Option as O,
  pipe,
  Ref,
  Schedule,
} from "npm:effect@3.19.16";

// --- 設定情報 ---
const BASE_URL = Deno.env.get("LIBRARY_BASE_URL");
const USER_CARD_NO = Deno.env.get("LIBRARY_USER_CARD_NO");
const USER_PASSWD = Deno.env.get("LIBRARY_USER_PASSWD");
const DISCORD_WEBHOOK_URL = Deno.env.get("LIBRARY_DISCORD_WEBHOOK_URL");

if (!BASE_URL || !USER_CARD_NO || !USER_PASSWD) {
  console.error("エラー: ログイン情報が設定されていません。");
  Deno.exit(1);
}

// --- リトライ・スケジュール定義 ---
const retryPolicy = Schedule.fixed(Duration.millis(1000)).pipe(
  Schedule.compose(Schedule.recurs(5)),
);

// --- 状態管理 (Cookies) ---
const createCookieJar = Ref.make<Record<string, string>>({});

const parseSetCookie = (
  setCookieHeader: string | null,
  currentCookies: Record<string, string>,
): Record<string, string> =>
  pipe(
    O.fromNullable(setCookieHeader),
    O.map((header) =>
      pipe(
        header.split(","),
        A.filterMap((part) => {
          const [pair] = part.split(";");
          const [key, value] = pair.trim().split("=");
          return key && value
            ? O.some([key, value] as [string, string])
            : O.none();
        }),
        (entries) => ({
          ...currentCookies,
          ...Object.fromEntries(entries),
        }),
      )
    ),
    O.getOrElse(() => currentCookies),
  );

const getCookieString = (cookies: Record<string, string>) =>
  pipe(
    Object.entries(cookies),
    A.map(([k, v]) => `${k}=${v}`),
    A.join("; "),
  );

const httpRequest = (url: string, options: RequestInit) =>
  E.tryPromise({
    try: () => fetch(url, options),
    catch: (error: unknown) => new Error(`HTTP Request Failed: ${error}`),
  }).pipe(
    E.tap((res: Response) => E.logDebug(`Response: ${res.status} ${url}`)),
    E.retry(retryPolicy),
  );

const requestBase = (
  cookieJar: Ref.Ref<Record<string, string>>,
  url: string,
  options: RequestInit,
  shouldUpdate: boolean,
) =>
  E.gen(function* () {
    const currentCookies = yield* Ref.get(cookieJar);
    const res = yield* httpRequest(url, {
      headers: {
        ...options.headers,
        Cookie: getCookieString(currentCookies),
      },
      redirect: "manual",
      ...options,
    });

    if (shouldUpdate) {
      const setCookie = res.headers.get("set-cookie");
      yield* Ref.update(cookieJar, (prev) => parseSetCookie(setCookie, prev));
    }

    return res;
  });

const requestAndSave = (
  cookieJar: Ref.Ref<Record<string, string>>,
  url: string,
  options: RequestInit,
) => requestBase(cookieJar, url, options, true);

const requestOnly = (
  cookieJar: Ref.Ref<Record<string, string>>,
  url: string,
  options: RequestInit,
) => requestBase(cookieJar, url, options, false);

const sendDiscordNotification = (message: string) =>
  E.gen(function* () {
    if (!DISCORD_WEBHOOK_URL) return;
    yield* httpRequest(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  }).pipe(E.catchAll(() => E.succeed(undefined)));

const login = (cookieJar: Ref.Ref<Record<string, string>>) =>
  E.gen(function* () {
    const loginUrl = `${BASE_URL}/opw/OPW/OPWUSERLOGIN.CSP`;
    const params = new URLSearchParams({
      usercardno: USER_CARD_NO!,
      userpasswd: USER_PASSWD!,
    });

    yield* requestAndSave(cookieJar, loginUrl, {});

    const loginOptions = {
      method: "POST",
      body: params,
    };
    yield* requestOnly(cookieJar, loginUrl, loginOptions);
    yield* requestAndSave(cookieJar, loginUrl, loginOptions);
  });

const getLoanBooks = (cookieJar: Ref.Ref<Record<string, string>>) =>
  E.gen(function* () {
    const res = yield* requestOnly(
      cookieJar,
      `${BASE_URL}/opw/OPW/OPWUSERINFO.CSP`,
      {},
    );
    const html = yield* E.tryPromise(() => res.text());

    const doc = new DOMParser().parseFromString(html, "text/html");
    if (!doc) yield* E.fail(new Error("HTMLのパースに失敗しました。"));

    const tokenMatch = html.match(
      /var ret=cspHttpServerMethod\(['"]([^'"]+)['"]/m,
    );
    const serverMethodToken = tokenMatch ? tokenMatch[1] : null;

    const books = Array.from(
      doc!.querySelectorAll("tr.lightcolor, tr.basecolor"),
    ).flatMap((row) => {
      const tds = (row as Element).querySelectorAll("td");
      if (tds.length < 8) return [];
      const noText = tds[0].textContent.trim();
      if (!/^\d+$/.test(noText)) return [];

      const hasExtendBtn =
        tds[1].querySelector('button[value="再貸出"]') !== null;
      return [{
        title: tds[2].textContent.trim(),
        barcode: tds[4].textContent.trim(),
        canExtend: hasExtendBtn,
        returnDate: tds[7].textContent.trim(),
      }];
    });

    return { books, serverMethodToken };
  });

const extendBook = (
  cookieJar: Ref.Ref<Record<string, string>>,
  token: string,
  barcode: string,
) =>
  E.gen(function* () {
    const cookies = yield* Ref.get(cookieJar);
    const params = new URLSearchParams({
      WARGC: "8",
      WEVENT: token,
      WARG_1: cookies["SID"] || "",
      WARG_2: "OPWUSERINFO",
      WARG_3: "LIB",
      WARG_4: "1",
      WARG_5: barcode,
      WARG_6: "chkLKOUSIN",
      WARG_7: "",
      WARG_8: "",
    });

    const res = yield* requestOnly(
      cookieJar,
      `${BASE_URL}/opw/OPW/%25CSP.Broker.cls`,
      {
        method: "POST",
        body: params,
      },
    );

    yield* E.sleep(Duration.millis(1000));

    return res.ok;
  });

const program = E.gen(function* () {
  const cookieJar = yield* createCookieJar;
  let report = "📚 **図書館自動延長 実行結果**\n";

  try {
    yield* login(cookieJar);
    const { books, serverMethodToken } = yield* getLoanBooks(cookieJar);

    const targetBooks = books.filter((
      b: {
        title: string;
        barcode: string;
        canExtend: boolean;
        returnDate: string;
      },
    ) => b.canExtend);

    if (targetBooks.length === 0) {
      report += "延長可能な書籍はありません。";
    } else {
      for (const book of targetBooks) {
        const success = yield* extendBook(
          cookieJar,
          serverMethodToken!,
          book.barcode,
        );
        report += `${
          success ? "✅" : "❌"
        } ${book.title} (期限: ${book.returnDate})\n`;
      }
    }
  } catch (e) {
    report += `⚠️ エラー: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    console.log(report);
    yield* sendDiscordNotification(report);
  }
}).pipe(
  E.catchAll(() => E.succeed(undefined)),
  E.orDie,
);

E.runPromise(program);
