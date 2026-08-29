/**
 * EMP-PORTAL 員工特休自助查詢 — 前端純函式核心（Phase I-P3）
 *
 * 用途：把「後端回應 → 畫面決策 → 文案鍵」這段邏輯抽成純函式，
 *       讓 Node 可在無瀏覽器、無網路的情況下逐路徑驗證（驗收錨點 GATE-G3）。
 *
 * 設計原則（與 index.html 的分工）：
 *   1. 本檔零 DOM、零網路、零計時器；所有 I/O（fetch、liff、document）只留在 index.html 包裝層。
 *   2. 本檔**不得出現任何中文字串常值**——所有使用者可見文字只能來自 errors.json
 *      或 index.html 的靜態 HTML，違反者由 run_front_tests.js 的靜態掃描判 FAIL。
 *   3. 金額（payout）一律以字串處理，全程不經 Number 轉換，
 *      避免 IEEE754 浮點破壞金額精度（Chair 技術底線：金額不用浮點概算）。
 *   4. 錯誤碼→文案鍵採白名單映射，不在白名單者一律落到 fallback 鍵，不直接顯示原始碼。
 *
 * 雙載入：Node 走 module.exports；瀏覽器掛 window.EmpPortalLogic。
 */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;          // Node（run_front_tests.js）
  } else {
    root.EmpPortalLogic = api;     // 瀏覽器（index.html）
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ===== 常數 =====

  /** 本檔版本；與 errors.json 的 schemaVersion 各自獨立。 */
  var VERSION = 'P3-1.0.0';

  /** 未知狀況的 fallback 文案鍵。 */
  var FALLBACK_KEY = 'UNKNOWN';

  /** 後端錯誤碼全集：逐字取自 work\p2\code.gs 的 ERR_（實測對照，非推測）。 */
  var BACKEND_CODES = [
    'INVALID_TOKEN',
    'NOT_BOUND',
    'ALREADY_BOUND',
    'BIND_FAILED',
    'LOCKED',
    'UNAUTHORIZED',
    'SERVER_ERROR'
  ];

  /** 前端自產狀況碼（後端不會回這些；由 index.html 包裝層在對應失敗點產生）。 */
  var FRONTEND_CODES = [
    'LIFF_INIT_FAILED',   // 服務頁啟動失敗
    'LIFF_NO_ID_TOKEN',   // 啟動成功但取不到登入憑證
    'NETWORK_FAILED',     // 連線失敗
    'BAD_RESPONSE'        // 回應非預期（非 JSON、欄位數不符）
  ];

  /** LOCKED 但等待時刻無法解析時改用的鍵。 */
  var LOCKED_NO_TIME_KEY = 'LOCKED_NO_TIME';

  /** 文案鍵全集＝後端碼＋前端碼＋LOCKED_NO_TIME＋fallback。errors.json 必須恰好涵蓋這些鍵。 */
  var MESSAGE_KEYS = BACKEND_CODES
    .concat(FRONTEND_CODES)
    .concat([LOCKED_NO_TIME_KEY, FALLBACK_KEY]);

  /**
   * 特休四欄（順序＝顯示順序；欄名逐字取自 work\p1\schema.json 的 leave 表）。
   * 語意（I-P3.5）：entitled／used／remaining 為時數（小時），payout 為折算工資（元，上年度結算）；
   * 顯示用的標籤與單位文字一律放在 index.html 的靜態 HTML，本檔不得出現中文字串常值。
   */
  var LEAVE_FIELDS = ['entitled', 'used', 'remaining', 'payout'];

  /** 需要千分位的欄位（金額欄）。時數欄不加千分位。 */
  var THOUSANDS_FIELDS = ['payout'];

  /** LOCKED 文案中的等待時刻佔位符（errors.json 內寫成 {RETRY_TIME}）。 */
  var PLACEHOLDER_RETRY_TIME = 'RETRY_TIME';

  /** 台北時區位移（毫秒）。後端 toIsoTaipei_ 亦採固定 +08:00，不依賴執行環境時區。 */
  var TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

  // ===== 顯示層格式化（純函式）=====

  /**
   * 用途：把數值字串加上千分位，全程以字串運算，不經 Number（防浮點誤差）。
   *       無法解析為數值字串者原樣回傳，不做猜測；非字串型別只轉字串、不加千分位。
   * @param {*} value 數值字串，例 "0.00"、"99999999.99"、"-1234567.89"。
   * @return {string} 加千分位後的字串。
   */
  function formatThousands(value) {
    if (typeof value !== 'string') {
      return (value === null || value === undefined) ? '' : String(value);
    }
    var matched = /^(-?)(\d+)(\.\d+)?$/.exec(value.trim());
    if (!matched) { return value; }
    var sign = matched[1];
    var intPart = matched[2];
    var fracPart = matched[3] || '';
    // 由右往左每三位插逗號；\B 確保不會在字串開頭插入
    var grouped = intPart.replace(/\B(?=(\d{3})+$)/g, ',');
    return sign + grouped + fracPart;
  }

  /**
   * 用途：把毫秒時間戳轉為台北時間的「年-月-日 時:分」顯示字串（固定 +08:00，不看本機時區）。
   * @param {number} ms 毫秒時間戳。
   * @return {string} 例 "2026-08-22 15:30"。
   */
  function toTaipeiMinuteText(ms) {
    return new Date(ms + TAIPEI_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
  }

  /**
   * 用途：把後端的 retryAfter 轉成可讀時刻文字。相容兩種形態——
   *       ①ISO 8601 含時區位移之時刻字串；②剩餘秒數（數字或純數字字串，需搭配 nowMs 換算）。
   *       兩種形態皆無法解析時回 {ok:false}，由呼叫端改用不含時刻的文案鍵。
   * @param {*} value 後端回傳的 retryAfter。
   * @param {number} nowMs 目前時間毫秒（由呼叫端注入，保持本函式純粹可測）。
   * @return {{ok:boolean, text:string}} 解析結果。
   */
  function formatRetryAfter(value, nowMs) {
    var candidate = value;
    if (typeof candidate === 'string' && /^\s*-?\d+\s*$/.test(candidate)) {
      candidate = Number(candidate.trim());   // 純數字字串視為秒數
    }
    var ms = null;
    if (typeof candidate === 'number' && isFinite(candidate)) {
      if (typeof nowMs !== 'number' || !isFinite(nowMs)) { return { ok: false, text: '' }; }
      var seconds = candidate > 0 ? Math.round(candidate) : 0;   // 負秒數視為 0（已可重試）
      ms = nowMs + seconds * 1000;
    } else if (typeof candidate === 'string') {
      var parsed = Date.parse(candidate.trim());
      if (!isNaN(parsed)) { ms = parsed; }
    }
    if (ms === null) { return { ok: false, text: '' }; }
    return { ok: true, text: toTaipeiMinuteText(ms) };
  }

  /**
   * 用途：驗證並格式化查詢回傳的四欄資料。契約＝恰四鍵、值全字串（work\p2\code.gs handleQuery_）。
   *       任一條件不符即視為異常回應，交由呼叫端顯示 BAD_RESPONSE，不硬湊畫面。
   * @param {*} data 後端 data 物件。
   * @return {{ok:boolean, fields:Object}} 格式化後的顯示值（payout 已加千分位）。
   */
  function formatLeaveData(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) { return { ok: false, fields: {} }; }
    var keys = Object.keys(data);
    if (keys.length !== LEAVE_FIELDS.length) { return { ok: false, fields: {} }; }
    var fields = {};
    for (var i = 0; i < LEAVE_FIELDS.length; i++) {
      var field = LEAVE_FIELDS[i];
      if (typeof data[field] !== 'string') { return { ok: false, fields: {} }; }
      fields[field] = THOUSANDS_FIELDS.indexOf(field) >= 0
        ? formatThousands(data[field])
        : data[field];
    }
    return { ok: true, fields: fields };
  }

  // ===== 錯誤碼→文案鍵映射 =====

  /**
   * 用途：把任意錯誤碼映射為文案鍵；不在白名單者一律回 fallback 鍵，
   *       確保畫面永遠有話可說，且不會把原始碼直接曝給使用者。
   * @param {*} code 錯誤碼。
   * @return {string} 文案鍵。
   */
  function mapErrorKey(code) {
    if (typeof code === 'string' && MESSAGE_KEYS.indexOf(code) >= 0) { return code; }
    return FALLBACK_KEY;
  }

  /**
   * 用途：取出文案鍵對應的文字；查無鍵時退回文案表宣告的 fallback 鍵。
   *       兩者皆取不到時回空字串，由 index.html 的靜態備援區塊接手（不硬編碼文字）。
   * @param {Object} table errors.json 解析後的物件。
   * @param {string} key 文案鍵。
   * @return {string} 文案（未填佔位符）。
   */
  function lookupMessage(table, key) {
    var messages = (table && table.messages && typeof table.messages === 'object') ? table.messages : {};
    var fallbackKey = (table && typeof table.fallbackKey === 'string') ? table.fallbackKey : FALLBACK_KEY;
    if (typeof key === 'string' && typeof messages[key] === 'string') { return messages[key]; }
    if (typeof messages[fallbackKey] === 'string') { return messages[fallbackKey]; }
    return '';
  }

  /**
   * 用途：把文案中的 {鍵名} 佔位符換成實際值。
   * @param {string} text 含佔位符的文案。
   * @param {Object} vars 佔位符名稱→值。
   * @return {string} 填值後文案。
   */
  function fillTemplate(text, vars) {
    if (typeof text !== 'string') { return ''; }
    if (!vars || typeof vars !== 'object') { return text; }
    var out = text;
    var names = Object.keys(vars);
    for (var i = 0; i < names.length; i++) {
      out = out.split('{' + names[i] + '}').join(String(vars[names[i]]));
    }
    return out;
  }

  /**
   * 用途：由畫面決策物件組出最終顯示文字（查表＋填佔位符），是顯示層取文案的唯一入口。
   * @param {Object} table errors.json 解析後的物件。
   * @param {Object} decision decideView() 的結果。
   * @return {string} 可直接顯示的文字。
   */
  function composeMessage(table, decision) {
    var key = (decision && typeof decision.messageKey === 'string') ? decision.messageKey : FALLBACK_KEY;
    return fillTemplate(lookupMessage(table, key), decision ? decision.vars : null);
  }

  // ===== 回應→畫面決策（狀態機）=====

  /**
   * 用途：組出「顯示訊息」型的決策物件。
   * @param {string} key 文案鍵。
   * @param {Object} extra 額外旗標（canRetryQuery、vars 等）。
   * @return {Object} 決策物件。
   */
  function messageView(key, extra) {
    var view = { view: 'MESSAGE', messageKey: key, vars: null, canRetryQuery: false };
    if (extra) {
      var names = Object.keys(extra);
      for (var i = 0; i < names.length; i++) { view[names[i]] = extra[names[i]]; }
    }
    return view;
  }

  /**
   * 用途：依後端回應與當前動作，決定畫面要顯示四欄、綁定表單，還是訊息。
   *       這是前端唯一的顯示決策點；index.html 只負責照決策渲染，不自行判斷錯誤碼。
   * @param {*} resp 後端回應物件（或包裝層產生的 {ok:false,error:前端碼}）。
   * @param {string} action 'query' 或 'bind'。
   * @param {number} nowMs 目前時間毫秒（供 LOCKED 秒數換算）。
   * @return {Object} {view:'DATA'|'BIND_FORM'|'BIND_DONE'|'MESSAGE', messageKey, fields, vars, canRetryQuery}
   */
  function decideView(resp, action, nowMs) {
    var act = (action === 'bind') ? 'bind' : 'query';
    if (!resp || typeof resp !== 'object' || Array.isArray(resp)) {
      return messageView('BAD_RESPONSE', { canRetryQuery: true });
    }

    if (resp.ok === true) {
      if (act === 'bind') {
        // 綁定成功契約：data.bound === '1'（work\p2\code.gs handleBind_）
        var bound = resp.data && typeof resp.data === 'object' ? resp.data.bound : null;
        if (bound === '1') { return { view: 'BIND_DONE', messageKey: null, vars: null, canRetryQuery: false }; }
        return messageView('BAD_RESPONSE', { canRetryQuery: true });
      }
      var formatted = formatLeaveData(resp.data);
      if (!formatted.ok) { return messageView('BAD_RESPONSE', { canRetryQuery: true }); }
      return { view: 'DATA', messageKey: null, vars: null, fields: formatted.fields, canRetryQuery: false };
    }

    if (resp.ok === false) {
      var key = mapErrorKey(resp.error);
      if (key === 'NOT_BOUND' && act === 'query') {
        // 未綁定不是錯誤，是流程的第一步：直接把使用者帶到綁定表單，訊息當說明
        return { view: 'BIND_FORM', messageKey: 'NOT_BOUND', vars: null, canRetryQuery: false };
      }
      if (key === 'BIND_FAILED') {
        // 停在表單上讓使用者重打，不把人趕回空白畫面
        return { view: 'BIND_FORM', messageKey: 'BIND_FAILED', vars: null, canRetryQuery: false };
      }
      if (key === 'LOCKED') {
        var retry = formatRetryAfter(resp.retryAfter, nowMs);
        if (!retry.ok) { return messageView(LOCKED_NO_TIME_KEY, {}); }
        var vars = {};
        vars[PLACEHOLDER_RETRY_TIME] = retry.text;
        return messageView('LOCKED', { vars: vars });
      }
      if (key === 'ALREADY_BOUND') {
        return messageView('ALREADY_BOUND', { canRetryQuery: true });
      }
      if (key === 'SERVER_ERROR' || key === 'NETWORK_FAILED' || key === 'BAD_RESPONSE') {
        return messageView(key, { canRetryQuery: true });
      }
      return messageView(key, {});
    }

    return messageView('BAD_RESPONSE', { canRetryQuery: true });
  }

  // ===== 請求組裝（純函式；不含任何網路呼叫）=====

  /**
   * 用途：組出送給後端的 JSON 字串（Content-Type: text/plain 簡單請求避 preflight，
   *       實際送出由 index.html 的 fetch 包裝層負責）。
   *       undefined／null 參數一律略去，避免送出無意義欄位。
   * @param {string} action 'query' 或 'bind'。
   * @param {Object} params 其餘參數（idToken、empId、bindCode）。
   * @return {string} JSON 字串。
   */
  function buildRequestBody(action, params) {
    var body = { action: String(action) };
    var names = params && typeof params === 'object' ? Object.keys(params) : [];
    for (var i = 0; i < names.length; i++) {
      var value = params[names[i]];
      if (value === undefined || value === null) { continue; }
      body[names[i]] = String(value);
    }
    return JSON.stringify(body);
  }

  /**
   * 用途：把使用者輸入的員工代號與核對碼正規化（去頭尾空白，兩者一律轉大寫）。
   *       只做不改變語意的整理，不做格式判斷——格式是否正確一律交後端核對（防前端洩漏名冊規則）。
   *       核對碼轉大寫屬**零損失**正規化：發碼字元集固定為 A-Z 與 2-9（且排除易混淆的
   *       0 O 1 I L），本來就不存在小寫碼，故大寫化不可能把一組有效碼變成另一組有效碼。
   *       不轉大寫的代價：手機鍵盤預設小寫，使用者其實打對了卻被判失敗，白白吃掉一次
   *       錯誤次數，連續數次即觸發 30 分鐘鎖定——這是最難自救的失敗樣態。
   * @param {*} empId 使用者輸入的員工代號。
   * @param {*} bindCode 使用者輸入的核對碼。
   * @return {{empId:string, bindCode:string}} 正規化結果。
   */
  function normalizeBindInput(empId, bindCode) {
    var id = (typeof empId === 'string') ? empId.trim().toUpperCase() : '';
    var code = (typeof bindCode === 'string') ? bindCode.trim().toUpperCase() : '';
    return { empId: id, bindCode: code };
  }

  /**
   * 用途：回傳文案鍵全集副本，供檢核腳本比對 errors.json 是否恰好涵蓋（無缺漏、無孤兒）。
   * @return {Array<string>} 文案鍵陣列。
   */
  function messageKeys() {
    return MESSAGE_KEYS.slice();
  }

  return {
    VERSION: VERSION,
    FALLBACK_KEY: FALLBACK_KEY,
    LEAVE_FIELDS: LEAVE_FIELDS.slice(),
    PLACEHOLDER_RETRY_TIME: PLACEHOLDER_RETRY_TIME,
    messageKeys: messageKeys,
    formatThousands: formatThousands,
    formatRetryAfter: formatRetryAfter,
    formatLeaveData: formatLeaveData,
    mapErrorKey: mapErrorKey,
    lookupMessage: lookupMessage,
    fillTemplate: fillTemplate,
    composeMessage: composeMessage,
    decideView: decideView,
    buildRequestBody: buildRequestBody,
    normalizeBindInput: normalizeBindInput
  };
}));
