/**
 * EMP-PORTAL 員工自助查詢 — 前端純函式核心（Phase I-P3；二期 Y-P3 擴充薪資／出勤）
 *
 * 用途：把「後端回應 → 畫面決策 → 文案鍵」這段邏輯抽成純函式，
 *       讓 Node 可在無瀏覽器、無網路的情況下逐路徑驗證（驗收錨點 GATE-G3）。
 *
 * 二期（Y-P3）加法式擴充，一期函式語義一字未改：
 *   新增頁籤狀態機（特休／薪資單／出勤）、query_pay 回應之視圖組裝（零值過濾、
 *   出勤過濾與後綴、月份選單）與 NO_DATA 路徑；一期 query／bind 決策路徑完全沿用。
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
  var VERSION = 'Y3-1.2.0';

  /** 未知狀況的 fallback 文案鍵。 */
  var FALLBACK_KEY = 'UNKNOWN';

  /**
   * 後端錯誤碼全集：逐字取自 work\p2\code.gs 的 ERR_（實測對照，非推測）。
   * 一期七碼＋二期第八碼 NO_DATA（查無該月薪資資料，Y-P2 新增）。
   */
  var BACKEND_CODES = [
    'INVALID_TOKEN',
    'NOT_BOUND',
    'ALREADY_BOUND',
    'BIND_FAILED',
    'LOCKED',
    'UNAUTHORIZED',
    'SERVER_ERROR',
    'NO_DATA'
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
   * 特休查詢回傳之八個欄位（欄名逐字取自 work\p1\schema.json 的 leave 表，
   * 與 work\p2\code.gs 的 LEAVE_DATA_FIELDS_ 為同一集合）。
   * 語意（I-P3.5）：entitled／used／remaining 為時數（小時），payout 為折算工資（元）；
   * 語意（v1.1／D-I7）：period_start／period_end 為本年度行使期間起迄（YYYY/MM/DD，
   * 無進行中年度時為空字串）；payout_period 為折算所屬年度之行使期間（起～迄，無則空字串）；
   * synced_at 為地端同步上雲的時間（ISO 8601 含 +08:00）。
   * 顯示用的標籤與單位文字一律放在 index.html 的靜態 HTML，本檔不得出現中文字串常值。
   */
  var LEAVE_FIELDS = ['entitled', 'used', 'remaining', 'payout',
    'period_start', 'period_end', 'payout_period', 'synced_at'];

  /** 需要千分位的欄位（金額欄）。時數欄與日期欄不加千分位。 */
  var THOUSANDS_FIELDS = ['payout'];

  /**
   * 無值時的顯示佔位符（破折號 U+2014）。
   * 這是**符號**不是文字，故不受「本檔不得出現中文字串常值」之限制；
   * 之所以放在這裡而非 errors.json，是因為它屬於資料畫面的空值呈現，不是錯誤文案。
   */
  var EMPTY_MARK = '\u2014';   // U+2014 EM DASH

  /** 期間起迄之連接符（全形波浪號 U+FF5E），與後端 payout_period 的連接符一致。 */
  var PERIOD_JOINER = '\uFF5E'; // U+FF5E FULLWIDTH TILDE

  /** LOCKED 文案中的等待時刻佔位符（errors.json 內寫成 {RETRY_TIME}）。 */
  var PLACEHOLDER_RETRY_TIME = 'RETRY_TIME';

  /** 台北時區位移（毫秒）。後端 toIsoTaipei_ 亦採固定 +08:00，不依賴執行環境時區。 */
  var TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

  // ===== 二期（Y-P3）常數 =====
  //
  // 頁籤代號一律為 ASCII 識別字；頁籤上的中文標籤與所有可見文字只存在於 index.html
  // 靜態 HTML 或 errors.json（本檔不得出現中文字串常值，由 a1 靜態掃描把關）。

  /** 頁籤代號：特休（一期畫面）／薪資單／出勤。 */
  var TAB_LEAVE = 'leave';
  var TAB_PAY = 'pay';
  var TAB_ATTEND = 'attend';

  /** 頁籤順序＝畫面上的左至右順序；第一個即預設頁籤。 */
  var TABS = [TAB_LEAVE, TAB_PAY, TAB_ATTEND];

  /**
   * 三期（Y-P7）直達頁籤：LIFF 網址查詢參數名。
   * 圖文選單每鍵各帶 ?tab=leave|pay|attend，開頁即停在該頁籤；缺參數或值不合法一律回到特休頁。
   * 讀取時機必須在 SDK 初始化完成之後——轉址期間參數被 SDK 暫存，初始化前讀到的是空值。
   */
  var TAB_PARAM = 'tab';

  /**
   * query_pay 成功回應之 data 鍵集合（恰五鍵）。
   * 逐字取自 work\p2\code.gs 的 buildPayView_ 回傳（實測對照，非推測）。
   */
  var PAY_DATA_KEYS = ['months', 'month', 'companies', 'net_total', 'attend'];

  /**
   * 逐對資料的對數：pay 21（24 欄去 emp_id／month／company）、attend 23（25 欄去 emp_id／month）。
   * 數字派生自 work_pay\y1\schema_pay.json 之欄數，由檢核腳本與該正本交叉比對（禁手抄漂移）。
   */
  var PAY_ITEM_COUNT = 21;
  var ATTEND_ITEM_COUNT = 23;

  /** 薪資明細的零值判定值：後端金額一律整數字串，值恰為此者即該項無發放。 */
  var PAY_ZERO_TEXT = '0';

  /** 薪資明細的空值判定值：非金額欄（如薪別）在來源可能無值，後端以空字串原樣透傳（契約 PAY-1.0.1）。 */
  var PAY_EMPTY_TEXT = '';

  /**
   * 薪資明細的隱藏值集合（判定以「值」為準，不看欄名——薪別不是金額，不得被當成金額判讀）：
   * "0"＝該項無發放；""＝該欄來源無值。兩者一律不列在卡片上，避免版面被無意義的列灌滿。
   */
  var PAY_HIDDEN_VALUES = [PAY_ZERO_TEXT, PAY_EMPTY_TEXT];

  /**
   * 金額字串樣態（可選負號＋整數）。**一律以 [0-9] 明寫、禁用 \d**——
   * Y-P1 實測教訓：\d 在部分執行環境會收下全形數字，令 numeric-string 契約被穿透。
   */
  var AMOUNT_TEXT_PATTERN = /^-?[0-9]+$/;

  /** 出勤時數值樣態（HH:MM，時可為 1~3 位）。同樣禁用 \d。 */
  var HOURS_TEXT_PATTERN = /^[0-9]{1,3}:[0-9]{2}$/;

  /** errors.json 中薪資／出勤顯示設定的區塊名稱與必填字串欄位。 */
  var PAY_CONFIG_KEY = 'payView';
  var PAY_CONFIG_FIELDS = ['rateField', 'countMarker', 'unitRate', 'unitCount', 'unitHours'];

  /**
   * 三期（Y-P9）薪資卡加減分組設定：位於 payView.payGroups，欄名一律來自設定（本檔零寫死欄名）。
   * 分組依據＝work_pay\y8\audit_pay_groups.py 對真實資料之實證（2026-09-05，四檔恆等式全成立）。
   *   addFields／deductFields／subtotalFields／formulaFields：欄名清單；
   *   netField／payTypeField／deductSubtotalField：單一欄名；formulaTemplate：算式文案，{0}..{n} 對應 formulaFields。
   * 五群（加項、減項、小計、實發、薪別）必須兩兩不重疊且聯集恰為 PAY_ITEM_COUNT 個欄名——少一欄或多一欄皆判設定不合格。
   */
  var PAY_GROUP_KEY = 'payGroups';
  var PAY_GROUP_LIST_FIELDS = ['addFields', 'deductFields', 'subtotalFields', 'formulaFields'];
  var PAY_GROUP_TEXT_FIELDS = ['deductSubtotalField', 'netField', 'payTypeField', 'formulaTemplate'];

  /** 減項金額的顯示包裝（會計慣例：括號＝扣除）。 */
  var PAY_DEDUCT_OPEN = '(';
  var PAY_DEDUCT_CLOSE = ')';

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
   * 用途：把 synced_at（ISO 8601 含時區位移）轉成畫面上的「資料更新時間」顯示字串
   *       YYYY/MM/DD HH:mm（固定台北時間，不看本機時區）。
   *       非字串、空字串、無法解析者一律回破折號——寧可顯示「不知道」，
   *       也不顯示一個看起來像時間、實際上是錯的值。
   * @param {*} value synced_at 值。
   * @return {string} 例 "2026/08/22 15:30"；無法解析時為 "—"。
   */
  function formatSyncedAt(value) {
    if (typeof value !== 'string' || value.trim() === '') { return EMPTY_MARK; }
    var ms = Date.parse(value.trim());
    if (isNaN(ms)) { return EMPTY_MARK; }
    // 重用既有的台北時刻格式化（產出 "YYYY-MM-DD HH:mm"），只把日期分隔符換成斜線；
    // 時分之間的冒號不受影響（replace 對象只有連字號）。
    return toTaipeiMinuteText(ms).split('-').join('/');
  }

  /**
   * 用途：把行使期間起迄兩欄組成一行顯示字串「起～迄」。
   *       兩欄**皆有值**才顯示範圍；任一為空（含只有半邊的異常資料）一律回破折號——
   *       半個期間對使用者沒有意義，且會讓人誤以為期間到某日就結束。
   * @param {*} start 起日字串。
   * @param {*} end 迄日字串。
   * @return {string} 例 "2025/03/01～2026/02/28"；無法組成時為 "—"。
   */
  function formatPeriod(start, end) {
    var s = (typeof start === 'string') ? start.trim() : '';
    var e = (typeof end === 'string') ? end.trim() : '';
    if (s === '' || e === '') { return EMPTY_MARK; }
    return s + PERIOD_JOINER + e;
  }

  /**
   * 用途：驗證並格式化查詢回傳的八欄資料。契約＝恰八鍵、值全字串（work\p2\code.gs handleQuery_）。
   *       任一條件不符即視為異常回應，交由呼叫端顯示 BAD_RESPONSE，不硬湊畫面。
   *       回傳的 fields 除八個原欄位外，另含兩個**顯示衍生值**：
   *         period_text     ＝行使期間一行字（空值時為破折號）
   *         synced_at_text  ＝資料更新時間顯示字（空值或無法解析時為破折號）
   *       衍生值放這裡而不放 index.html，是為了讓「空值怎麼顯示」這條規則可被 G3 逐路徑驗證。
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
    fields.period_text = formatPeriod(fields.period_start, fields.period_end);
    fields.synced_at_text = formatSyncedAt(fields.synced_at);
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

  // ===== 二期（Y-P3）頁籤狀態機（純函式；不碰 DOM、不做任何初始化）=====

  /**
   * 用途：把外來的頁籤狀態正規化為合法值，避免壞狀態擴散（未知頁籤一律回到特休頁）。
   * @param {*} state 頁籤狀態物件。
   * @return {{active:string, payLoaded:boolean}} 正規化後的狀態。
   */
  function normalizeTabState(state) {
    var raw = (state && typeof state === 'object' && !Array.isArray(state)) ? state : {};
    var active = (typeof raw.active === 'string' && TABS.indexOf(raw.active) >= 0) ? raw.active : TABS[0];
    return { active: active, payLoaded: raw.payLoaded === true };
  }

  /**
   * 用途：建立頁籤初始狀態——預設停在特休頁（一期畫面），薪資資料尚未載入。
   * @return {{active:string, payLoaded:boolean}} 初始狀態。
   */
  function createTabState() {
    return { active: TABS[0], payLoaded: false };
  }

  /**
   * 用途：判斷某頁籤是否吃 query_pay 的資料（薪資單與出勤共用同一次查詢結果）。
   * @param {string} tab 頁籤代號。
   * @return {boolean} 是否為薪資／出勤頁。
   */
  function isPayTab(tab) {
    return tab === TAB_PAY || tab === TAB_ATTEND;
  }

  /**
   * 用途：切換頁籤。回傳**新的**狀態物件（不改動傳入者）與兩個旗標：
   *       changed＝畫面是否需要重繪；needsPayQuery＝是否需要發出 query_pay。
   *       切換本身**不觸發任何初始化**——LIFF 初始化與登入憑證只在頁面啟動時做一次，
   *       薪資與出勤兩頁共用同一份查詢結果，故僅在尚未載入時才需要查詢。
   * @param {Object} state 目前狀態。
   * @param {string} target 目標頁籤代號。
   * @return {{state:Object, changed:boolean, needsPayQuery:boolean}} 切換結果。
   */
  function selectTab(state, target) {
    var current = normalizeTabState(state);
    if (typeof target !== 'string' || TABS.indexOf(target) < 0) {
      // 未知頁籤：忽略，畫面維持原狀（不清空、不重查）
      return { state: current, changed: false, needsPayQuery: false };
    }
    return {
      state: { active: target, payLoaded: current.payLoaded },
      changed: target !== current.active,
      needsPayQuery: isPayTab(target) && !current.payLoaded
    };
  }

  /**
   * 用途：記錄薪資資料是否已載入（查詢成功才標記，失敗保持未載入以便下次切換時重試）。
   * @param {Object} state 目前狀態。
   * @param {boolean} loaded 是否已載入。
   * @return {{active:string, payLoaded:boolean}} 新狀態。
   */
  function markPayLoaded(state, loaded) {
    var current = normalizeTabState(state);
    return { active: current.active, payLoaded: loaded === true };
  }

  // ===== 三期（Y-P7）直達頁籤（純函式；不碰 DOM、不碰 liff 物件）=====

  /**
   * 用途：把查詢字串拆成鍵值表（只取第一個同名鍵；解碼失敗的值以原文保留，不丟例外）。
   * @param {string} search 查詢字串，可含開頭的 ? 或 #。
   * @return {Object} 鍵值表。
   */
  function parseQuery(search) {
    var table = {};
    if (typeof search !== 'string' || search === '') { return table; }
    var text = search.replace(/^[?#]/, '');
    var parts = text.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '') { continue; }
      var at = parts[i].indexOf('=');
      var key = at < 0 ? parts[i] : parts[i].slice(0, at);
      var value = at < 0 ? '' : parts[i].slice(at + 1);
      try { key = decodeURIComponent(key); } catch (keyError) { /* 保留原文 */ }
      try { value = decodeURIComponent(value.replace(/\+/g, ' ')); } catch (valueError) { /* 保留原文 */ }
      if (!Object.prototype.hasOwnProperty.call(table, key)) { table[key] = value; }
    }
    return table;
  }

  /**
   * 用途：由開頁網址的查詢字串決定初始頁籤。
   *       規則：tab 參數值（去空白、轉小寫）在 TABS 內即採用；否則回到預設頁籤（特休）。
   *       未知值一律靜默回預設，不顯示任何訊息——網址是選單設定的，不是使用者打的，沒有人需要被糾正。
   *       本函式不讀 SDK 轉址暫存參數：呼叫端負責在 SDK 初始化完成後才傳入還原後的查詢字串。
   * @param {string} search window.location.search（須於 SDK 初始化完成後讀取）。
   * @return {string} 頁籤代號。
   */
  function resolveInitialTab(search) {
    var raw = parseQuery(search)[TAB_PARAM];
    if (typeof raw !== 'string') { return TABS[0]; }
    var wanted = raw.trim().toLowerCase();
    return TABS.indexOf(wanted) >= 0 ? wanted : TABS[0];
  }

  // ===== 二期（Y-P3）薪資／出勤視圖組裝（純函式）=====

  /**
   * 用途：判斷月份陣列是否符合契約——非空、全為非空字串、嚴格降冪（隱含無重複）。
   * @param {*} months 月份陣列。
   * @return {boolean} 是否合格。
   */
  function isMonthsDesc(months) {
    if (!Array.isArray(months) || months.length === 0) { return false; }
    for (var i = 0; i < months.length; i++) {
      if (typeof months[i] !== 'string' || months[i] === '') { return false; }
      if (i > 0 && !(months[i - 1] > months[i])) { return false; }
    }
    return true;
  }

  /**
   * 用途：組月份選單資料。順序照後端 months 原序（降冪），不重新排序、不改寫顯示格式。
   * @param {Array<string>} months 可查月份。
   * @param {string} month 目前所在月份。
   * @return {Array<{month:string, selected:boolean}>} 選單項目。
   */
  function buildMonthOptions(months, month) {
    var out = [];
    if (!Array.isArray(months)) { return out; }
    for (var i = 0; i < months.length; i++) {
      out.push({ month: months[i], selected: months[i] === month });
    }
    return out;
  }

  /**
   * 用途：決定要送給後端的月份——想查的月在可查清單內就用它，否則退回最新月（months[0]）；
   *       清單為空時回空字串（＝不指定月份，由後端取最新月）。
   * @param {Array<string>} months 可查月份。
   * @param {*} wanted 想查的月份。
   * @return {string} 要送出的月份。
   */
  function pickMonth(months, wanted) {
    if (!Array.isArray(months) || months.length === 0) { return ''; }
    return months.indexOf(wanted) >= 0 ? wanted : months[0];
  }

  /**
   * 用途：自文案表取出薪資／出勤的顯示設定（恆顯欄名、後綴單位等）。
   *       這些值必須是**資料**而非程式常數——欄名與單位屬使用者可見文字，
   *       集中在 errors.json 才能改字不動程式，也才不會違反「本檔零中文字串常值」。
   * @param {Object} table errors.json 解析後的物件。
   * @return {{ok:boolean, config:Object}} 設定與是否可用。
   */
  function readPayConfig(table) {
    var raw = (table && typeof table === 'object') ? table[PAY_CONFIG_KEY] : null;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return { ok: false, config: null }; }
    var config = {};
    for (var i = 0; i < PAY_CONFIG_FIELDS.length; i++) {
      var name = PAY_CONFIG_FIELDS[i];
      if (typeof raw[name] !== 'string' || raw[name] === '') { return { ok: false, config: null }; }
      config[name] = raw[name];
    }
    if (!Array.isArray(raw.alwaysShowFields) || raw.alwaysShowFields.length === 0) {
      return { ok: false, config: null };
    }
    var always = [];
    for (var j = 0; j < raw.alwaysShowFields.length; j++) {
      if (typeof raw.alwaysShowFields[j] !== 'string' || raw.alwaysShowFields[j] === '') {
        return { ok: false, config: null };
      }
      always.push(raw.alwaysShowFields[j]);
    }
    config.alwaysShowFields = always;
    var groups = readPayGroups(raw[PAY_GROUP_KEY]);
    if (groups === null) { return { ok: false, config: null }; }
    config.groups = groups;
    return { ok: true, config: config };
  }

  /**
   * 用途：讀取並驗證薪資卡加減分組設定（三期 Y-P9）。任一條件不符即回 null，由呼叫端落 fallback。
   *       驗證：四個清單皆為非空字串陣列；四個文字欄皆為非空字串；
   *       加項／減項／小計／實發／薪別五群兩兩不重疊且聯集恰為 PAY_ITEM_COUNT 個欄名；
   *       deductSubtotalField 在 subtotalFields 內；formulaFields 皆在小計或實發內；
   *       formulaTemplate 含每一個 {i} 佔位。
   * @param {*} raw payView.payGroups 原始物件。
   * @return {Object|null} 正規化後的分組設定。
   */
  function readPayGroups(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return null; }
    var groups = {};
    var i, j;
    for (i = 0; i < PAY_GROUP_LIST_FIELDS.length; i++) {
      var list = raw[PAY_GROUP_LIST_FIELDS[i]];
      if (!Array.isArray(list) || list.length === 0) { return null; }
      var copy = [];
      for (j = 0; j < list.length; j++) {
        if (typeof list[j] !== 'string' || list[j] === '') { return null; }
        copy.push(list[j]);
      }
      groups[PAY_GROUP_LIST_FIELDS[i]] = copy;
    }
    for (i = 0; i < PAY_GROUP_TEXT_FIELDS.length; i++) {
      var text = raw[PAY_GROUP_TEXT_FIELDS[i]];
      if (typeof text !== 'string' || text === '') { return null; }
      groups[PAY_GROUP_TEXT_FIELDS[i]] = text;
    }
    var all = groups.addFields.concat(groups.deductFields, groups.subtotalFields, [groups.netField, groups.payTypeField]);
    if (all.length !== PAY_ITEM_COUNT) { return null; }
    for (i = 0; i < all.length; i++) {
      if (all.indexOf(all[i]) !== i) { return null; }   // 重複＝同一欄被分到兩群
    }
    if (groups.subtotalFields.indexOf(groups.deductSubtotalField) < 0) { return null; }
    for (i = 0; i < groups.formulaFields.length; i++) {
      var name = groups.formulaFields[i];
      if (groups.subtotalFields.indexOf(name) < 0 && name !== groups.netField) { return null; }
      if (groups.formulaTemplate.indexOf('{' + i + '}') < 0) { return null; }
    }
    return groups;
  }

  /**
   * 用途：驗證並攤平 [[欄名, 值], ...] 逐對陣列。對數不符、非兩元素、非字串一律判不合格——
   *       契約全等，寧可整頁不顯示，也不顯示半套明細（沿一期八鍵全等之精神）。
   * @param {*} items 逐對陣列。
   * @param {number} expectedCount 期望對數。
   * @return {Array<{label:string, value:string}>|null} 攤平結果；不合格回 null。
   */
  function readItemPairs(items, expectedCount) {
    if (!Array.isArray(items) || items.length !== expectedCount) { return null; }
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var pair = items[i];
      if (!Array.isArray(pair) || pair.length !== 2) { return null; }
      if (typeof pair[0] !== 'string' || pair[0] === '') { return null; }
      if (typeof pair[1] !== 'string') { return null; }
      out.push({ label: pair[0], value: pair[1] });
    }
    return out;
  }

  /**
   * 用途：判定薪資明細某一項是否隱藏——以「值集合」判定（"0" 或空字串），不看欄名。
   * @param {string} value 明細值。
   * @return {boolean} true＝隱藏。
   */
  function isHiddenPayValue(value) {
    return PAY_HIDDEN_VALUES.indexOf(value) >= 0;
  }

  /**
   * 用途：把一家公司的 21 對明細依設定分成加項／減項／小計／實發／薪別（三期 Y-P9，A 案）。
   *       規則：加項與減項沿用隱藏規則（"0" 與空字串不列）、順序照後端原序；減項值以括號包裝；
   *       小計三列與實發恆顯（即使為 0，算式才完整）；算式文案由 formulaTemplate 帶入四個已格式化的值，
   *       **本函式不做任何金額運算**（不加不減不比較大小），只做分組、排序、格式化與字串填空。
   *       任一標籤不在任何一群、或設定要求的欄名不在明細內＝契約與設定漂移，回 null（整筆判不合格）。
   * @param {Array<{label:string,value:string}>} pairs readItemPairs 的結果。
   * @param {Object} groups readPayGroups 的結果。
   * @return {Object|null} {payType, add, deduct, subtotals, net, formula, empty}。
   */
  function groupPayCard(pairs, groups) {
    var index = {};
    var i;
    for (i = 0; i < pairs.length; i++) {
      var label = pairs[i].label;
      var known = groups.addFields.indexOf(label) >= 0 || groups.deductFields.indexOf(label) >= 0
        || groups.subtotalFields.indexOf(label) >= 0 || label === groups.netField || label === groups.payTypeField;
      if (!known) { return null; }
      index[label] = pairs[i].value;
    }
    var required = groups.subtotalFields.concat(groups.formulaFields, [groups.netField, groups.payTypeField]);
    for (i = 0; i < required.length; i++) {
      if (typeof index[required[i]] !== 'string') { return null; }
    }
    var add = [], deduct = [];
    for (i = 0; i < pairs.length; i++) {
      if (isHiddenPayValue(pairs[i].value)) { continue; }
      if (groups.addFields.indexOf(pairs[i].label) >= 0) {
        add.push({ label: pairs[i].label, value: formatThousands(pairs[i].value) });
      } else if (groups.deductFields.indexOf(pairs[i].label) >= 0) {
        deduct.push({ label: pairs[i].label, value: PAY_DEDUCT_OPEN + formatThousands(pairs[i].value) + PAY_DEDUCT_CLOSE });
      }
    }
    var subtotals = [];
    for (i = 0; i < groups.subtotalFields.length; i++) {
      var name = groups.subtotalFields[i];
      var isDeduct = (name === groups.deductSubtotalField);
      var shown = formatThousands(index[name]);
      subtotals.push({ label: name, value: isDeduct ? PAY_DEDUCT_OPEN + shown + PAY_DEDUCT_CLOSE : shown, deduct: isDeduct });
    }
    var vars = {};
    for (i = 0; i < groups.formulaFields.length; i++) {
      vars[String(i)] = formatThousands(index[groups.formulaFields[i]]);
    }
    return {
      payType: index[groups.payTypeField],
      add: add,
      deduct: deduct,
      subtotals: subtotals,
      net: { label: groups.netField, value: formatThousands(index[groups.netField]) },
      formula: fillTemplate(groups.formulaTemplate, vars),
      empty: add.length === 0 && deduct.length === 0
    };
  }

  /**
   * 用途：把各公司的 21 項明細組成卡片資料——值恰為 "0"（該項無發放）或空字串
   *       （該欄來源無值，例：薪別）者隱藏，其餘以千分位顯示；整張卡片全被隱藏時標記 empty，
   *       由畫面顯示「本月無發放明細」。空的薪別本身不構成「有發放」，因為判定看的是值不是欄名。
   *       公司名稱與順序一律照後端給的，前端不寫死任何公司清單。
   * @param {*} companies query_pay 回傳的 companies 陣列。
   * @return {Array<{company:string, items:Array, empty:boolean}>|null} 卡片資料；不合格回 null。
   */
  function buildPayCards(companies, groups) {
    if (!Array.isArray(companies) || companies.length === 0) { return null; }
    var cards = [];
    for (var i = 0; i < companies.length; i++) {
      var entry = companies[i];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { return null; }
      if (Object.keys(entry).length !== 2) { return null; }
      if (typeof entry.company !== 'string' || entry.company === '') { return null; }
      var pairs = readItemPairs(entry.items, PAY_ITEM_COUNT);
      if (pairs === null) { return null; }
      var visible = [];
      for (var j = 0; j < pairs.length; j++) {
        if (isHiddenPayValue(pairs[j].value)) { continue; }
        visible.push({ label: pairs[j].label, value: formatThousands(pairs[j].value) });
      }
      var card = { company: entry.company, items: visible, empty: visible.length === 0 };
      if (groups) {
        // 三期：加減分組（設定缺席時維持一期／二期的平鋪結果，供既有檢核與回復路徑使用）
        card.groups = groupPayCard(pairs, groups);
        if (card.groups === null) { return null; }
      }
      cards.push(card);
    }
    return cards;
  }

  /**
   * 用途：決定出勤某一項的後綴單位。判定順序＝出勤率→次數（欄名含「次」字者）→時數（值為 HH:MM）。
   *       其餘（如日數欄）不加後綴——寧可不標單位，也不標一個錯的單位。
   * @param {string} label 欄名。
   * @param {string} value 值。
   * @param {Object} config readPayConfig 的設定。
   * @return {string} 後綴（可能為空字串）。
   */
  function attendUnit(label, value, config) {
    if (label === config.rateField) { return config.unitRate; }
    if (label.indexOf(config.countMarker) >= 0) { return config.unitCount; }
    if (HOURS_TEXT_PATTERN.test(value)) { return config.unitHours; }
    return '';
  }

  /**
   * 用途：把出勤 23 項組成顯示列——空字串與 "0" 隱藏（該項無），
   *       但設定中的恆顯欄（正工日、出勤率）不論值為何一律顯示；值一律原樣不換算。
   *       attend 為 null（該月無出勤列）時回 empty，由畫面顯示「本月無出勤資料」。
   * @param {*} attend query_pay 回傳的 attend（物件或 null）。
   * @param {Object} config readPayConfig 的設定。
   * @return {{ok:boolean, empty:boolean, items:Array}} 出勤視圖。
   */
  function buildAttendItems(attend, config) {
    var fail = { ok: false, empty: true, items: [] };
    if (attend === null) { return { ok: true, empty: true, items: [] }; }
    if (!attend || typeof attend !== 'object' || Array.isArray(attend)) { return fail; }
    if (Object.keys(attend).length !== 1) { return fail; }
    var pairs = readItemPairs(attend.items, ATTEND_ITEM_COUNT);
    if (pairs === null) { return fail; }
    var visible = [];
    for (var i = 0; i < pairs.length; i++) {
      var label = pairs[i].label;
      var value = pairs[i].value;
      var always = config.alwaysShowFields.indexOf(label) >= 0;
      if (!always && (value === '' || value === PAY_ZERO_TEXT)) { continue; }
      visible.push({ label: label, value: value, unit: attendUnit(label, value, config) });
    }
    return { ok: true, empty: false, items: visible };
  }

  /**
   * 用途：驗證並格式化 query_pay 的 data（恰五鍵、months 降冪、month 在清單內、
   *       net_total 為整數字串、companies 與 attend 逐對合格）。任一條件不符即整筆判不合格，
   *       由呼叫端顯示 BAD_RESPONSE，不硬湊畫面。
   * @param {*} data query_pay 回傳的 data。
   * @param {Object} config readPayConfig 的設定。
   * @return {Object} {ok, months, month, monthOptions, cards, netTotalText, attend}。
   */
  function formatPayView(data, config) {
    var fail = { ok: false };
    if (!data || typeof data !== 'object' || Array.isArray(data)) { return fail; }
    var keys = Object.keys(data);
    if (keys.length !== PAY_DATA_KEYS.length) { return fail; }
    for (var i = 0; i < PAY_DATA_KEYS.length; i++) {
      if (keys.indexOf(PAY_DATA_KEYS[i]) < 0) { return fail; }
    }
    if (!isMonthsDesc(data.months)) { return fail; }
    if (typeof data.month !== 'string' || data.months.indexOf(data.month) < 0) { return fail; }
    if (typeof data.net_total !== 'string' || !AMOUNT_TEXT_PATTERN.test(data.net_total)) { return fail; }
    var cards = buildPayCards(data.companies, config.groups);
    if (cards === null) { return fail; }
    var attendView = buildAttendItems(data.attend, config);
    if (!attendView.ok) { return fail; }
    return {
      ok: true,
      months: data.months.slice(),
      month: data.month,
      monthOptions: buildMonthOptions(data.months, data.month),
      cards: cards,
      netTotalText: formatThousands(data.net_total),
      attend: { empty: attendView.empty, items: attendView.items }
    };
  }

  /**
   * 用途：組出「薪資頁顯示訊息」型的決策物件（訊息顯示在薪資／出勤頁內，頁籤仍可切換）。
   * @param {string} key 文案鍵。
   * @param {boolean} canRetry 是否可按重新查詢。
   * @return {Object} 決策物件。
   */
  function payMessageView(key, canRetry) {
    return { view: 'PAY_MESSAGE', messageKey: key, vars: null, canRetryQuery: canRetry === true };
  }

  /**
   * 用途：依 query_pay 回應決定薪資／出勤頁要顯示資料還是訊息。
   *       錯誤路徑一律沿用一期 decideView 的映射（含未知碼落 fallback、LOCKED 時刻換算），
   *       只把「訊息」的落點改到薪資頁內；NOT_BOUND 仍回傳 BIND_FORM——
   *       配對表單只存在於特休頁，故由呼叫端切回特休頁完成配對，
   *       不在沒有表單的薪資頁顯示「請在下方輸入…」這種做不到的指示。
   * @param {*} resp 後端回應（或包裝層產生的 {ok:false,error:前端碼}）。
   * @param {Object} table errors.json 解析後的物件（供讀取顯示設定）。
   * @param {number} nowMs 目前時間毫秒。
   * @return {Object} {view:'PAY_DATA'|'PAY_MESSAGE'|'BIND_FORM', messageKey, pay, canRetryQuery}
   */
  function decidePayView(resp, table, nowMs) {
    var cfg = readPayConfig(table);
    if (!cfg.ok) {
      // 文案表缺少薪資顯示設定：畫面仍要有話可說，落 fallback 文案而非硬湊版面
      return payMessageView(FALLBACK_KEY, false);
    }
    if (!resp || typeof resp !== 'object' || Array.isArray(resp)) {
      return payMessageView('BAD_RESPONSE', true);
    }
    if (resp.ok === true) {
      var view = formatPayView(resp.data, cfg.config);
      if (!view.ok) { return payMessageView('BAD_RESPONSE', true); }
      return { view: 'PAY_DATA', messageKey: null, vars: null, canRetryQuery: false, pay: view };
    }
    if (resp.ok === false) {
      var base = decideView(resp, 'query', nowMs);
      if (base.view === 'MESSAGE') { base.view = 'PAY_MESSAGE'; }
      return base;
    }
    return payMessageView('BAD_RESPONSE', true);
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
    EMPTY_MARK: EMPTY_MARK,
    PERIOD_JOINER: PERIOD_JOINER,
    PLACEHOLDER_RETRY_TIME: PLACEHOLDER_RETRY_TIME,
    // 二期（Y-P3）
    TAB_LEAVE: TAB_LEAVE,
    TAB_PAY: TAB_PAY,
    TAB_ATTEND: TAB_ATTEND,
    TABS: TABS.slice(),
    PAY_DATA_KEYS: PAY_DATA_KEYS.slice(),
    PAY_ITEM_COUNT: PAY_ITEM_COUNT,
    ATTEND_ITEM_COUNT: ATTEND_ITEM_COUNT,
    PAY_ZERO_TEXT: PAY_ZERO_TEXT,
    PAY_HIDDEN_VALUES: PAY_HIDDEN_VALUES.slice(),
    isHiddenPayValue: isHiddenPayValue,
    PAY_CONFIG_KEY: PAY_CONFIG_KEY,
    PAY_CONFIG_FIELDS: PAY_CONFIG_FIELDS.slice(),
    TAB_PARAM: TAB_PARAM,
    resolveInitialTab: resolveInitialTab,
    createTabState: createTabState,
    selectTab: selectTab,
    markPayLoaded: markPayLoaded,
    isPayTab: isPayTab,
    isMonthsDesc: isMonthsDesc,
    buildMonthOptions: buildMonthOptions,
    pickMonth: pickMonth,
    readPayConfig: readPayConfig,
    PAY_GROUP_KEY: PAY_GROUP_KEY,
    PAY_GROUP_LIST_FIELDS: PAY_GROUP_LIST_FIELDS.slice(),
    PAY_GROUP_TEXT_FIELDS: PAY_GROUP_TEXT_FIELDS.slice(),
    readPayGroups: readPayGroups,
    groupPayCard: groupPayCard,
    buildPayCards: buildPayCards,
    buildAttendItems: buildAttendItems,
    formatPayView: formatPayView,
    decidePayView: decidePayView,
    messageKeys: messageKeys,
    formatThousands: formatThousands,
    formatRetryAfter: formatRetryAfter,
    formatSyncedAt: formatSyncedAt,
    formatPeriod: formatPeriod,
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
