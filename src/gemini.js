/**
 * Gemini APIを呼び出し、スケジュールテキストを月別カレンダー（マークダウン）に変換します。
 */

/**
 * システムプロンプト（AIへの指示）を取得します。
 * @return {string} システムプロンプトの文字列
 */
function getSystemPrompt() {
  return [
    '# 依頼：スケジュールを月別カレンダー（表）に変換してください',
    '',
    '以下の【スケジュール】を、指定の【ルール】に従って、マークダウン形式の月別カレンダー（表）に変換してください。',
    '',
    '---',
    '',
    '### 📅 基本ルール',
    '1. **日曜日始まり**：曜日の見出しは、必ず【日 | 月 | 火 | 水 | 木 | 金 | 土】で固定してください。',
    '2. **コンパクト表示**：カレンダーの表示期間は、スケジュール内の【最小の日（開始日）から最大の日（終了日）まで】に絞り、不要な週の行や空白期間はカットしてください（週の途中から始まってもOKです）。',
    '3. **日付の網羅**：カレンダーの各マスには、必ず【日付】を漏れなく記載してください。',
    '',
    '### 🟣・❌の表記ルール（※重要：対象月のみ適用）',
    '1. **メイン対象月の判定**：「〇月〇月のスケジュール」とタイトルにあるような、その案内がメインとして扱っている月（以下、メイン対象月）のみ、すべての曜日で🟣❌の判定を行います。',
    '2. **メイン対象月外の扱い**：メイン対象月以外の月（例：前後の月のレッスンが一部含まれる場合など）については、明示的に「休み」と記載のない限り、勘違いを防ぐため【❌】は記載せず、日付のみ（または🟣や⚠️のみ）をシンプルに記載してください。',
    '3. **記号の基準**：メイン対象月において、レッスン（通常・コンクール等含む）の記載がある日は【🟣】、記載がない（休み）日は【❌】を日付の下に記載してください。',
    '4. **シンプルの徹底**：曜日の文字（例：【月】）や、「○月○回目」といった回数表記は一切不要です。（例：「27<br>🟣」のようにシンプルにすること）',
    '5. **クラスの統合**：「コンクールクラス」も通常レッスンと同じ扱いとし、表記は【🟣】に統一してください。',
    '',
    '### ⚠️ 特別イベント・変更のルール',
    '1. **カレンダー内の表記**：「時間変更」や「特別クラス（コンテンポラリーなど）」、「合宿」などの特殊な予定がある日は、カレンダー内には【⚠️】のアイコンのみを記載し、マスの幅を広げないようにしてください。',
    '2. **表記の優先順位**：通常レッスンと特別予定（⚠️）が重複する日の場合、【⚠️】のみを優先して記載し、アイコンが1種類だけになるようにしてください（「🟣<br>⚠️」のように併記してはいけません）。',
    '3. **補足の記載位置**：詳細な時間や場所、内容などの補足情報は、すべて【各月のカレンダーのすぐ下（月毎 of 欄外）】にまとめて記載してください。全体の最下部にまとめていけません。'
  ].join('\n');
}

/**
 * Gemini API を呼び出してカレンダー形式のテキストを生成します。
 * @param {string} text 結合されたメッセージテキスト
 * @return {string} 生成されたカレンダーのマークダウンテキスト
 */
function callGemini(text) {
  var properties = PropertiesService.getScriptProperties();
  var apiKey = properties.getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません。');
  }

  var model = properties.getProperty('GEMINI_MODEL') || 'gemini-3.5-flash';
  var url = 'https://generativelanguage.googleapis.com/v1/models/' + model + ':generateContent?key=' + apiKey;

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

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (responseCode !== 200) {
    throw new Error('Gemini API エラー (ステータスコード: ' + responseCode + '): ' + responseText);
  }

  var json = JSON.parse(responseText);
  if (json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts && json.candidates[0].content.parts[0]) {
    return json.candidates[0].content.parts[0].text;
  } else {
    throw new Error('Gemini APIのレスポンス構造が不正です: ' + responseText);
  }
}
