/**
 * Gemini APIを呼び出し、スケジュールテキストを解析して複数月対応のJSON（構造化データ）を返します。
 * 返却されたJSONはCode.js側でLINE Flex Message（Carousel）に変換されます。
 */

/**
 * システムプロンプト（AIへの指示）を取得します。
 * Geminiに対してマークダウンではなく、複数月対応の構造化JSONのみを返すよう指示します。
 * @return {string} システムプロンプトの文字列
 */
function getSystemPrompt() {
  return [
    '# 依頼：スケジュールを解析し、指定のJSONフォーマットで出力してください',
    '',
    '以下の【スケジュール】から日付ごとの予定を月別に抽出し、指定の【JSONフォーマット】のみを出力してください。',
    'マークダウンのコードブロック（```json ... ```）などの装飾は一切不要です。純粋なJSON文字列のみを返してください。',
    '',
    '---',
    '',
    '### 📅 抽出・判定ルール',
    '1. スケジュール内に含まれる全ての月を判定し、"months" 配列に追加してください。',
    '2. メイン対象月（案内がメインとして扱っている月）は "is_main": true を設定してください。**メイン対象月を必ず配列の先頭に置いてください。**',
    '3. 【is_main: true の月】メイン対象月内の全ての日付について、レッスン（通常・コンクール等含む）の記載がある日は status を "🟣"、記載がない（休み）日は "❌" と判定してください。全日付を漏れなく列挙すること。',
    '4. 【is_main: false の月】明示的なレッスン記載がある日は "🟣"、特殊予定（後述）がある日は "⚠️" のみ追加してください。❌は付けない。スケジュールに記載のない日はリストに含めないでください。',
    '5. 「コンクールクラス」も通常レッスンと同じ扱いとし、status は "🟣" に統一してください。',
    '6. 「時間変更」「特別クラス（コンテンポラリーなど）」「合宿」などの特殊な予定がある日は、status を "⚠️" とし、優先度を最優先にしてください（🟣や❌を上書きする）。その詳細（時間・内容・場所等）を "note" に記載してください。',
    '7. 通常レッスン・休みの日の "note" は空文字（""）にしてください。',
    '',
    '### 【JSONフォーマット】',
    '{',
    '  "months": [',
    '    {',
    '      "target_month": "YYYY-MM",',
    '      "is_main": true,',
    '      "events": [',
    '        { "date": "YYYY-MM-DD", "status": "🟣", "note": "" },',
    '        { "date": "YYYY-MM-DD", "status": "❌", "note": "" },',
    '        { "date": "YYYY-MM-DD", "status": "⚠️", "note": "14:00〜 時間変更" }',
    '      ]',
    '    }',
    '  ]',
    '}'
  ].join('\n');
}

/**
 * Gemini API を呼び出してカレンダー形式のテキストを生成します。
 * 一時的エラー（503/429）発生時は指数バックオフでリトライし、
 * すべて失敗した場合はフォールバックモデルで再試行します。
 * @param {string} text 結合されたメッセージテキスト
 * @return {string} 生成されたカレンダーのマークダウンテキスト
 */
function callGemini(text) {
  var properties = PropertiesService.getScriptProperties();
  var apiKey = properties.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません。');
  }

  var primaryModel = properties.getProperty('GEMINI_MODEL') || 'gemini-3.5-flash';
  var fallbackModel = properties.getProperty('GEMINI_FALLBACK_MODEL') || 'gemini-2.5-flash';

  var systemInstruction = getSystemPrompt();
  // systemInstructionがAPI v1で動作しない場合があるため、プロンプトの冒頭に指示を結合して送信します
  var combinedPrompt = systemInstruction + '\n\n【スケジュール情報】\n' + text;

  var payload = {
    contents: [
      {
        parts: [
          {
            text: combinedPrompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2
    }
  };

  // まずプライマリモデルで試行
  var result = callGeminiWithRetry_(apiKey, primaryModel, payload);
  if (result.success) {
    return result.text;
  }

  // プライマリモデルが一時的エラーで全リトライ失敗した場合、フォールバックモデルで再試行
  if (result.isTransientError && fallbackModel !== primaryModel) {
    console.info('プライマリモデル (' + primaryModel + ') が利用不可のため、フォールバックモデル (' + fallbackModel + ') で再試行します。');
    var fallbackResult = callGeminiWithRetry_(apiKey, fallbackModel, payload);
    if (fallbackResult.success) {
      return fallbackResult.text;
    }
    // フォールバックも失敗した場合は、フォールバックのエラーをスロー
    throw fallbackResult.lastError;
  }

  // 一時的エラーではない場合、またはフォールバックなしの場合
  throw result.lastError;
}

/**
 * 指定モデルに対してリトライ付きでGemini APIを呼び出します。
 * @param {string} apiKey APIキー
 * @param {string} model モデル名
 * @param {Object} payload リクエストボディ
 * @return {Object} { success: boolean, text?: string, lastError?: Error, isTransientError: boolean }
 */
function callGeminiWithRetry_(apiKey, model, payload) {
  var url = 'https://generativelanguage.googleapis.com/v1/models/' + model + ':generateContent?key=' + apiKey;

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var maxRetries = 5;      // 最大リトライ回数
  var baseDelay = 3000;    // 初回待機時間（3秒）
  var lastError = null;
  var wasTransientError = false;

  for (var attempt = 0; attempt < maxRetries; attempt++) {
    var response;
    try {
      response = UrlFetchApp.fetch(url, options);
    } catch (networkErr) {
      // ネットワークレベルの例外（タイムアウト等）
      lastError = networkErr;
      wasTransientError = true;
      console.warn('モデル ' + model + ': API呼び出し中にネットワーク例外が発生しました（' + (attempt + 1) + '/' + maxRetries + '回目）: ' + networkErr.toString());

      if (attempt < maxRetries - 1) {
        var networkDelay = baseDelay * Math.pow(2, attempt);
        Utilities.sleep(networkDelay);
      }
      continue;
    }

    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    // 正常レスポンス
    if (responseCode === 200) {
      var json = JSON.parse(responseText);
      if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0]) {
        return { success: true, text: json.candidates[0].content.parts[0].text, isTransientError: false };
      } else {
        return {
          success: false,
          lastError: new Error('Gemini APIのレスポンス構造が不正です: ' + responseText),
          isTransientError: false
        };
      }
    }

    // エラーオブジェクトを生成
    lastError = new Error('Gemini API エラー (ステータスコード: ' + responseCode + '): ' + responseText);

    // 一時的なエラー（503: サービス一時停止、429: レート制限）以外の場合はリトライせず即時返却
    var isTransientError = (responseCode === 503 || responseCode === 429);
    if (!isTransientError) {
      return { success: false, lastError: lastError, isTransientError: false };
    }

    wasTransientError = true;

    if (attempt < maxRetries - 1) {
      console.warn('モデル ' + model + ': 一時的エラー ' + responseCode + '（' + (attempt + 1) + '/' + maxRetries + '回目）。リトライします...');
      var delay = baseDelay * Math.pow(2, attempt);
      Utilities.sleep(delay);
    } else {
      console.warn('モデル ' + model + ': 一時的エラー ' + responseCode + '（' + (attempt + 1) + '/' + maxRetries + '回目）。リトライ上限に達しました。');
    }
  }

  // すべてのリトライが失敗
  return { success: false, lastError: lastError, isTransientError: wasTransientError };
}
