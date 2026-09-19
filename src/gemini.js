/**
 * Gemini APIを呼び出し、スケジュールテキストを解析して複数月対応のJSON（構造化データ）を返します。
 * 返却されたJSONはCode.js側でLINE Flex Message（Carousel）に変換されます。
 */

/**
 * システムプロンプト（AIへの指示）を取得します。
 * Geminiに対してマークダウンではなく、複数月対応の構造化JSONのみを返すよう指示します。
 * @return {string} システムプロンプトの文字列
 */
function getSystemPrompt(referenceYear, referenceMonth) {
  var yearHint = [
    '### ⚠️ 年の補完ルール（重要）',
    '現在の日付（GASシステム日時）: ' + referenceYear + '年' + referenceMonth + '月',
    'スケジュールメッセージに西暦年が明記されていない場合は、以下のルールで年を補完してください：',
    '- 言及されている月 >= 現在の月 → ' + referenceYear + '年として扱う',
    '- 言及されている月 < 現在の月  → ' + (referenceYear + 1) + '年として扱う（翌年の予定）',
    '絶対に過去の年（例: 2020年）を使用しないでください。'
  ].join('\n');

  return [
    '# 依頼：スケジュールを解析し、指定のJSONフォーマットで出力してください',
    '',
    '以下の【スケジュール】から日付ごとの予定を月別に抽出し、指定の【JSONフォーマット】のみを出力してください。',
    'マークダウンのコードブロック（```json ... ```）などの装飾は一切不要です。純粋なJSON文字列のみを返してください。',
    '',
    '---',
    '',
    yearHint,
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
 * 利用可能なGeminiモデル一覧を動的に取得し、スケジュール解析・JSON生成に適したFlash系モデルを優先順にソートして返却する
 * @param {string} apiKey - Gemini APIキー
 * @returns {string[]} 利用可能なモデル名（ID）のリスト
 */
function getAvailableGeminiModels(apiKey) {
  var DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  var MAX_CANDIDATE_MODELS = 3;
  if (!apiKey) return DEFAULT_MODELS;

  try {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models?key=' + apiKey;
    var response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    
    if (response.getResponseCode() !== 200) {
      console.warn('Geminiモデル一覧取得失敗 (HTTP ' + response.getResponseCode() + '): ', response.getContentText());
      return DEFAULT_MODELS;
    }

    var data = JSON.parse(response.getContentText());
    if (!data.models || !Array.isArray(data.models)) {
      return DEFAULT_MODELS;
    }

    // 1. generateContent をサポートしているモデルを抽出
    var candidates = data.models.filter(function(m) {
      if (!m.name) return false;
      var methods = m.supportedGenerationMethods || [];
      return methods.indexOf('generateContent') !== -1;
    }).map(function(m) {
      return m.name.replace(/^models\//, '');
    });

    // 2. 特殊用途モデル（画像生成、TTS、ネイティブオーディオプレビューなど）を除外
    var validModels = candidates.filter(function(name) {
      var lower = name.toLowerCase();
      if (lower.indexOf('image') !== -1 || lower.indexOf('tts') !== -1 || lower.indexOf('audio') !== -1 || lower.indexOf('realtime') !== -1 || lower.indexOf('embedding') !== -1) {
        return false;
      }
      return true;
    });

    // 3. Flash系モデルを優先し、バージョン降順でソート
    var flashModels = validModels.filter(function(m) {
      return m.toLowerCase().indexOf('flash') !== -1;
    });
    var otherModels = validModels.filter(function(m) {
      return m.toLowerCase().indexOf('flash') === -1 && m.toLowerCase().indexOf('gemini-') === 0;
    });

    var sortFn = function(a, b) {
      // プレビュー・実験用より安定版を優先
      var isPreviewA = a.indexOf('preview') !== -1 || a.indexOf('exp') !== -1;
      var isPreviewB = b.indexOf('preview') !== -1 || b.indexOf('exp') !== -1;
      if (isPreviewA !== isPreviewB) {
        return isPreviewA ? 1 : -1;
      }
      // バージョン番号の抽出比較 (例: gemini-2.5-flash -> 2.5)
      var vA = (a.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
      var vB = (b.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
      var numA = parseFloat(vA);
      var numB = parseFloat(vB);
      if (numA !== numB) {
        return numB - numA; // 降順
      }
      // -lite は標準版の後に配置
      var isLiteA = a.indexOf('lite') !== -1;
      var isLiteB = b.indexOf('lite') !== -1;
      if (isLiteA !== isLiteB) {
        return isLiteA ? 1 : -1;
      }
      return a.localeCompare(b);
    };

    flashModels.sort(sortFn);
    otherModels.sort(sortFn);

    var result = flashModels.concat(otherModels);
    if (result.length > 0) {
      return result.slice(0, MAX_CANDIDATE_MODELS);
    }

    return DEFAULT_MODELS;
  } catch (e) {
    console.warn('Geminiモデル一覧取得中に例外が発生しました: ', e);
    return DEFAULT_MODELS;
  }
}

/**
 * Gemini API を呼び出してカレンダー形式のJSONテキストを生成します。
 * models.list APIから利用可能なモデル一覧を動的に取得し、優先順に試行します。
 * 一時的エラー（503等）発生時は指数バックオフでリトライし、モデル未検出（404）やリトライ上限超過時は次候補モデルへ自動フォールバックします。
 * @param {string} text 結合されたメッセージテキスト
 * @return {string} 生成されたカレンダーのJSONテキスト
 */
function callGemini(text) {
  var properties = PropertiesService.getScriptProperties();
  var apiKey = properties.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません。');
  }

  // 利用可能なモデル一覧を動的に取得
  var dynamicModels = getAvailableGeminiModels(apiKey);
  var customModel = properties.getProperty('GEMINI_MODEL');
  var modelList = dynamicModels.slice();
  if (customModel) {
    // カスタム指定モデルがある場合は先頭に配置（重複排除）
    modelList = [customModel].concat(modelList.filter(function(m) { return m !== customModel; }));
  }

  // GASシステム日付から現在の年・月を取得し、年補完ヒントとしてプロンプトに渡す
  var now = new Date();
  var currentYear = now.getFullYear();
  var currentMonth = now.getMonth() + 1; // 0-indexed → 1-indexed

  var systemInstruction = getSystemPrompt(currentYear, currentMonth);
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

  var lastError = null;
  for (var m = 0; m < modelList.length; m++) {
    var currentModel = modelList[m];
    var result = callGeminiWithRetry_(apiKey, currentModel, payload);
    if (result.success) {
      return result.text;
    }

    lastError = result.lastError;

    // 429（レート制限）や400（不正リクエスト）などの恒常的・キー単位エラーは即時スロー（無駄な探索を防止）
    if (result.isFatalError) {
      throw lastError;
    }

    // 次のモデルへフォールバック
    if (m < modelList.length - 1) {
      console.warn('モデル ' + currentModel + ' での呼び出しに失敗したため、次候補モデル ' + modelList[m + 1] + ' へフォールバックします。');
    }
  }

  throw lastError || new Error('すべてのGeminiモデル候補でリクエストが失敗しました。');
}

/**
 * 指定モデルに対してリトライ付きでGemini APIを呼び出します。
 * @param {string} apiKey APIキー
 * @param {string} model モデル名
 * @param {Object} payload リクエストボディ
 * @return {Object} { success: boolean, text?: string, lastError?: Error, isTransientError: boolean, isFatalError: boolean }
 */
function callGeminiWithRetry_(apiKey, model, payload) {
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey;

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var maxRetries = 3;      // 最大リトライ回数
  var baseDelay = 1500;    // 初回待機時間（1.5秒）
  var lastError = null;

  for (var attempt = 0; attempt < maxRetries; attempt++) {
    var response;
    try {
      response = UrlFetchApp.fetch(url, options);
    } catch (networkErr) {
      // ネットワークレベルの例外（タイムアウト等）
      lastError = networkErr;
      console.warn('モデル ' + model + ': API呼び出し中にネットワーク例外が発生しました（' + (attempt + 1) + '/' + maxRetries + '回目）: ' + networkErr.toString());

      if (attempt < maxRetries - 1) {
        var networkDelay = baseDelay * Math.pow(2, attempt);
        Utilities.sleep(networkDelay);
      }
      continue;
    }

    var responseCode = response.getResponseCode();
    var responseText = response.getContentText();

    // 正常レスポンス (200)
    if (responseCode === 200) {
      try {
        var json = JSON.parse(responseText);
        if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0]) {
          return { success: true, text: json.candidates[0].content.parts[0].text, isTransientError: false, isFatalError: false };
        } else if (json.candidates && json.candidates[0] && json.candidates[0].finishReason) {
          return {
            success: false,
            lastError: new Error('Gemini API 判定ブロック (finishReason: ' + json.candidates[0].finishReason + ')'),
            isTransientError: false,
            isFatalError: true
          };
        } else {
          return {
            success: false,
            lastError: new Error('Gemini APIのレスポンス構造が不正です: ' + responseText),
            isTransientError: false,
            isFatalError: false
          };
        }
      } catch (parseE) {
        return {
          success: false,
          lastError: new Error('Gemini APIレスポンスJSONパース失敗: ' + parseE.toString()),
          isTransientError: false,
          isFatalError: false
        };
      }
    }

    // エラーオブジェクトを生成
    lastError = new Error('Gemini API エラー (ステータスコード: ' + responseCode + '): ' + responseText);

    // 429 (クォータ超過・レートリミット) または 400 (不正リクエスト)
    if (responseCode === 429 || responseCode === 400) {
      console.warn('モデル ' + model + ': APIエラー (' + responseCode + '): ' + responseText);
      return { success: false, lastError: lastError, isTransientError: false, isFatalError: true };
    }

    // 404 (モデルが存在しない / 廃止された)
    if (responseCode === 404) {
      console.warn('モデル ' + model + ' が見つかりません (HTTP 404)。フォールバックを試行します。');
      return { success: false, lastError: lastError, isTransientError: false, isFatalError: false };
    }

    // 503 (一時的な高負荷) などの一時的エラーはリトライ
    var isTransient = (responseCode === 503 || responseCode === 500 || responseCode === 504);
    if (isTransient) {
      if (attempt < maxRetries - 1) {
        console.warn('モデル ' + model + ': 一時的エラー ' + responseCode + '（' + (attempt + 1) + '/' + maxRetries + '回目）。リトライします...');
        var delay = baseDelay * Math.pow(2, attempt);
        Utilities.sleep(delay);
      } else {
        console.warn('モデル ' + model + ': 一時的エラー ' + responseCode + '（' + (attempt + 1) + '/' + maxRetries + '回目）。リトライ上限に達しました。');
      }
    } else {
      // その他の恒常的エラー
      return { success: false, lastError: lastError, isTransientError: false, isFatalError: false };
    }
  }

  // すべてのリトライが失敗（次候補モデルへフォールバック可能）
  return { success: false, lastError: lastError, isTransientError: true, isFatalError: false };
}

// ----------------------------------------------------
// Jest テスト用エクスポート (GAS本番環境では無視される)
// ----------------------------------------------------
if (typeof module !== 'undefined') {
  module.exports = {
    getSystemPrompt: getSystemPrompt,
    getAvailableGeminiModels: getAvailableGeminiModels,
    callGemini: callGemini,
    callGeminiWithRetry_: callGeminiWithRetry_
  };
}
