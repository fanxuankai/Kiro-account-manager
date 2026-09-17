var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main/loginPool/fingerprint.ts
var fingerprint_exports = {};
__export(fingerprint_exports, {
  CHROME_UA: () => CHROME_UA,
  applyWindowFingerprint: () => applyWindowFingerprint,
  describeFingerprint: () => describeFingerprint,
  hardenSessionHeaders: () => hardenSessionHeaders,
  resolveFingerprintEnv: () => resolveFingerprintEnv
});
module.exports = __toCommonJS(fingerprint_exports);
var import_electron = require("electron");
var import_node_os = require("node:os");
var import_undici = require("undici");
var CHROME_MAJOR = process.versions.chrome.split(".")[0] || "134";
var CHROME_GREASE = "Not=A?Brand";
function platformToken() {
  if (process.platform === "win32") return "Windows NT 10.0; Win64; x64";
  if (process.platform === "linux") return "X11; Linux x86_64";
  return "Macintosh; Intel Mac OS X 10_15_7";
}
function platformBrand() {
  if (process.platform === "win32") return "Windows";
  if (process.platform === "linux") return "Linux";
  return "macOS";
}
var CHROME_UA = `Mozilla/5.0 (${platformToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
var SEC_CH_UA = `"Chromium";v="${CHROME_MAJOR}", "${CHROME_GREASE}";v="24", "Google Chrome";v="${CHROME_MAJOR}"`;
function localTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";
  } catch {
    return "Etc/UTC";
  }
}
function acceptLanguageFor(locale) {
  return locale === "zh-CN" ? "zh-CN,zh;q=0.9,en;q=0.8" : "en-US,en;q=0.9";
}
function navigatorLanguageFor(locale) {
  return locale === "zh-CN" ? "zh-CN,zh" : "en-US,en";
}
function localeForCountry(country) {
  return country === "CN" ? "zh-CN" : "en-US";
}
function isValidTimezone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format(0);
    return true;
  } catch {
    return false;
  }
}
async function lookupExitGeo(exitIp, timeoutMs = 5e3) {
  const attempts = [
    async () => {
      const r = await (0, import_undici.fetch)(`https://ipwho.is/${encodeURIComponent(exitIp)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.success || !d.country_code || !isValidTimezone(d.timezone?.id || "")) return null;
      return { country: d.country_code.toUpperCase(), timezone: d.timezone.id };
    },
    async () => {
      const r = await (0, import_undici.fetch)(
        `https://get.geojs.io/v1/ip/geo/${encodeURIComponent(exitIp)}.json`,
        {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs)
        }
      );
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.country_code || !isValidTimezone(d.timezone || "")) return null;
      return { country: d.country_code.toUpperCase(), timezone: d.timezone };
    }
  ];
  for (const attempt of attempts) {
    try {
      const hit = await attempt();
      if (hit) return hit;
    } catch {
    }
  }
  return null;
}
async function resolveFingerprintEnv(exitIp) {
  if (exitIp) {
    const geo = await lookupExitGeo(exitIp);
    if (geo) {
      return {
        source: "exit-geo",
        locale: localeForCountry(geo.country),
        timezone: geo.timezone,
        country: geo.country,
        exitIp
      };
    }
    return { source: "geo-fallback", locale: "en-US", timezone: localTimezone(), exitIp };
  }
  return { source: "direct", locale: import_electron.app.getLocale() || "en-US", timezone: localTimezone() };
}
function describeFingerprint(env) {
  const where = env.source === "direct" ? "\u76F4\u8FDE\uFF08\u672C\u673A\u73AF\u5883\uFF09" : env.source === "geo-fallback" ? `\u51FA\u53E3 ${env.exitIp || "?"}\uFF08geo \u672A\u77E5\uFF0C\u65F6\u533A\u9000\u672C\u673A\uFF09` : `\u51FA\u53E3 ${env.exitIp || "?"}\uFF08${env.country}\uFF09`;
  return `${where} \xB7 \u65F6\u533A ${env.timezone} \xB7 \u8BED\u8A00 ${env.locale} \xB7 UA Chrome/${CHROME_MAJOR}\uFF08${platformBrand()}\uFF09 \xB7 WebRTC \u5DF2\u7981`;
}
function hardenSessionHeaders(ses, env) {
  const acceptLanguage = acceptLanguageFor(env.locale);
  ses.setUserAgent(CHROME_UA, navigatorLanguageFor(env.locale));
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === "notifications") return callback(false);
    callback(true);
  });
  try {
    ses.setPermissionCheckHandler((_wc, _mediaType, permission) => permission !== "notifications");
  } catch {
  }
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = { ...details.requestHeaders };
    headers["User-Agent"] = CHROME_UA;
    headers["Accept-Language"] = acceptLanguage;
    headers["sec-ch-ua"] = SEC_CH_UA;
    headers["sec-ch-ua-mobile"] = "?0";
    headers["sec-ch-ua-platform"] = `"${platformBrand()}"`;
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string" && value.includes("Electron")) delete headers[name];
    }
    callback({ requestHeaders: headers });
  });
}
function withTimeout(p, ms, label) {
  return Promise.race([
    p,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} \u8D85\u65F6`)), ms);
    })
  ]);
}
function deviceMemoryGB() {
  const gb = Math.floor((0, import_node_os.totalmem)() / 1024 ** 3);
  return 2 ** Math.floor(Math.log2(Math.max(1, gb)));
}
function buildInitScript(fullVersion) {
  const fullVersionList = [
    `{ brand: 'Chromium', version: '${fullVersion}' }`,
    `{ brand: '${CHROME_GREASE}', version: '24.0.0.0' }`,
    `{ brand: 'Google Chrome', version: '${fullVersion}' }`
  ].join(", ");
  return `;(function () {
  var FULL_VERSION_LIST = [${fullVersionList}]
  // 1) window.chrome\uFF1AUAO \u4F1A\u6E05\u6389 Electron \u539F\u751F\u7684 app/csi/loadTimes \u6CE8\u5165\uFF0C\u8865\u56DE\u771F Chrome \u5F62\u72B6
  try {
    if (window.chrome && !window.chrome.app) {
      window.chrome.app = {
        isInstalled: false,
        InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function () { return null },
        getIsInstalled: function () { return false },
        installState: function () { return 'not_installed' },
        runningState: function () { return 'running' }
      }
      window.chrome.csi = function () { return {} }
      window.chrome.loadTimes = function () { return {} }
    }
  } catch (e) { /* \u9875\u9762\u73AF\u5883\u5F02\u5E38\u65F6\u9759\u9ED8 */ }
  // 2) deviceMemory\uFF1A\u6309\u771F\u673A\u5185\u5B58\u5BF9\u9F50\uFF08Electron \u5199\u6B7B 8\uFF09
  try {
    Object.defineProperty(navigator, 'deviceMemory', {
      get: function () { return ${deviceMemoryGB()} }, configurable: true, enumerable: true
    })
  } catch (e) { /* \u5DF2\u88AB\u9875\u9762\u6539\u5199\u5219\u4E0D\u52A8 */ }
  // 3) getHighEntropyValues\uFF1AChromium \u5B9E\u73B0\u4E0D\u8D70 UAO \u7684 userAgentMetadata\uFF08\u5B9E\u6D4B
  //    fullVersionList \u4ECD\u62A5\u539F\u751F\u54C1\u724C\u8868\uFF0C\u4E0E\u58F0\u79F0\u7684 Google Chrome \u77DB\u76FE\uFF09\uFF0C\u8BFB\u53D6\u4FA7\u5F52\u4E00
  try {
    if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
      var uad = navigator.userAgentData
      var orig = uad.getHighEntropyValues.bind(uad)
      uad.getHighEntropyValues = function (hints) {
        return orig(hints).then(function (out) {
          if (out && typeof out === 'object' && Array.isArray(hints)) {
            if (hints.indexOf('fullVersionList') >= 0) out.fullVersionList = FULL_VERSION_LIST.slice()
            if (hints.indexOf('brands') >= 0) out.brands = FULL_VERSION_LIST.slice()
          }
          return out
        })
      }
    }
  } catch (e) { /* \u4E0D\u652F\u6301\u5219\u4FDD\u6301\u539F\u6837 */ }
  // 4) Notification.permission\uFF1AElectron \u6052 granted\uFF0C\u771F\u65E0\u75D5 Chrome \u662F default
  //    \uFF08permissions.query \u7684\u670D\u52A1\u7AEF\u72B6\u6001\u65E0\u6CD5\u5728\u9875\u9762\u4FA7\u6539\u5199\uFF0C\u5C5E\u5DF2\u77E5\u6B8B\u4F59\uFF09
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      Object.defineProperty(Notification, 'permission', {
        get: function () { return 'default' }, configurable: true
      })
    }
  } catch (e) { /* \u5FFD\u7565 */ }
})()`;
}
async function applyWindowFingerprint(win, env) {
  const contents = win.webContents;
  try {
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    contents.setUserAgent(CHROME_UA);
    await withTimeout(
      (async () => {
        await win.loadURL("about:blank");
        contents.debugger.attach("1.3");
        await contents.debugger.sendCommand("Emulation.setUserAgentOverride", {
          userAgent: CHROME_UA,
          // 这里同样只给纯标签：q 值会污染 navigator.languages（HTTP 头由 session 层改写）
          acceptLanguage: navigatorLanguageFor(env.locale),
          userAgentMetadata: {
            brands: [
              { brand: "Chromium", version: CHROME_MAJOR },
              { brand: CHROME_GREASE, version: "24" },
              { brand: "Google Chrome", version: CHROME_MAJOR }
            ],
            fullVersion: process.versions.chrome,
            platform: platformBrand(),
            platformVersion: "",
            architecture: process.arch === "arm64" ? "arm" : "x86",
            model: "",
            mobile: false
          }
        });
        await contents.debugger.sendCommand("Page.enable");
        await contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
          source: buildInitScript(process.versions.chrome)
        });
        await contents.debugger.sendCommand("Emulation.setLocaleOverride", { locale: env.locale });
        await contents.debugger.sendCommand("Emulation.setTimezoneOverride", {
          timezoneId: env.timezone
        });
        win.once("close", () => {
          try {
            contents.debugger.detach();
          } catch {
          }
        });
      })(),
      8e3,
      "\u6307\u7EB9\u5BF9\u9F50 CDP"
    );
    return { ok: true };
  } catch (e) {
    try {
      contents.setUserAgent(CHROME_UA);
    } catch {
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHROME_UA,
  applyWindowFingerprint,
  describeFingerprint,
  hardenSessionHeaders,
  resolveFingerprintEnv
});
