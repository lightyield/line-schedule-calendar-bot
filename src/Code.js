/**
 * LINE Schedule Calendar Bot - Google Apps Script
 * Main logic for handling webhook events, buffering, and scheduling processing triggers.
 * @version 1.0.1 - Auto-deploy test
 */

/**
 * Webhook受信時の処理 (LINE Messaging APIからのPOSTリクエスト)
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: 'No payload' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    console.log('Webhook received: ' + e.postData.contents);
    var data = JSON.parse(e.postData.contents);
    
    if (!data.events || data.events.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = spreadsheet.getSheetByName('buffer');
    if (!sheet) {
      sheet = spreadsheet.insertSheet('buffer');
      sheet.appendRow(['Source ID', 'Timestamp', 'Message Text', 'Reply Token']);
    }

    var hasTextMessage = false;

    for (var i = 0; i < data.events.length; i++) {
      var event = data.events[i];
      // テキストメッセージイベントのみ対象とする
      if (event.type === 'message' && event.message.type === 'text') {
        var sourceId = getSourceId(event.source);
        var timestamp = new Date(event.timestamp);
        var text = event.message.text;
        var replyToken = event.replyToken;

        sheet.appendRow([sourceId, timestamp, text, replyToken]);
        hasTextMessage = true;
      }
    }

    // テキストメッセージを受信していた場合、バッファ処理用トリガーを予約・リフレッシュ（デバウンス）
    if (hasTextMessage) {
      setupDebounceTrigger();
    }

    return ContentService.createTextOutput(JSON.stringify({ status: 'ok' }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    console.error('Error in doPost: ' + err.toString());
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * 送信元のIDを抽出します。
 * @param {Object} source LINEイベントのsourceオブジェクト
 * @return {string} 送信元ID
 */
function getSourceId(source) {
  if (source.groupId) return source.groupId;
  if (source.roomId) return source.roomId;
  return source.userId;
}

/**
 * デバウンス用の時限トリガーをセットアップします。
 * 既存の processBuffer トリガーを削除し、最新の受信から30秒後に再設定します。
 */
function setupDebounceTrigger() {
  cleanupTriggers();
  
  // スプレッドシートIDを自動保存（時限トリガーでのgetActiveSpreadsheetのnull対策）
  try {
    var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
    if (spreadsheet) {
      PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', spreadsheet.getId());
    }
  } catch (err) {
    console.warn('Failed to save SPREADSHEET_ID in setupDebounceTrigger: ' + err.toString());
  }
  
  // 30秒後（30000ミリ秒）に実行するトリガーを新規作成
  ScriptApp.newTrigger('processBuffer')
    .timeBased()
    .after(30000)
    .create();
}

/**
 * 既存の processBuffer トリガーをすべて削除してクリーンアップします。
 */
function cleanupTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'processBuffer') {
      try {
        ScriptApp.deleteTrigger(triggers[i]);
      } catch (err) {
        console.warn('Failed to delete trigger: ' + err.toString());
      }
    }
  }
}

/**
 * バッファに蓄積されたメッセージを処理し、Geminiでカレンダーを生成してLINEに返信します。
 */
function processBuffer() {
  // トリガーの重複実行を避けるためにトリガーを初期化
  cleanupTriggers();

  var properties = PropertiesService.getScriptProperties();
  var ssId = properties.getProperty('SPREADSHEET_ID');
  var spreadsheet = null;

  if (ssId) {
    try {
      spreadsheet = SpreadsheetApp.openById(ssId);
    } catch (err) {
      console.warn('Failed to open spreadsheet by SPREADSHEET_ID: ' + err.toString());
    }
  }
  
  if (!spreadsheet) {
    spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  }

  if (!spreadsheet) {
    console.error('Spreadsheet could not be accessed.');
    return;
  }

  var sheet = spreadsheet.getSheetByName('buffer');
  if (!sheet) return;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return; // ヘッダーのみ、または空

  // 現在バッファにある行数を確定し、読み込む
  var numRows = lastRow - 1;
  var range = sheet.getRange(2, 1, numRows, 4);
  var values = range.getValues();

  // 送信元（sourceId）ごとにメッセージをグループ化
  var groups = {};
  for (var i = 0; i < values.length; i++) {
    var sourceId = values[i][0];
    var timestamp = values[i][1];
    var text = values[i][2];
    var replyToken = values[i][3];

    if (!groups[sourceId]) {
      groups[sourceId] = {
        texts: [text],
        replyToken: replyToken,
        latestTimestamp: timestamp
      };
    } else {
      groups[sourceId].texts.push(text);
      groups[sourceId].replyToken = replyToken; // 常に最新のreplyTokenで上書き
      if (new Date(timestamp) > new Date(groups[sourceId].latestTimestamp)) {
        groups[sourceId].latestTimestamp = timestamp;
      }
    }
  }

  // 読み込みが完了したバッファ行を即座に削除（API呼出しの遅延によるデータ重複処理を防ぐ）
  sheet.deleteRows(2, numRows);

  // 各送信元ごとにGemini APIを呼び出してカレンダーを生成し、LINEで返信する
  for (var sourceId in groups) {
    var group = groups[sourceId];
    var combinedText = group.texts.join('\n---\n');

    try {
      // Gemini APIを呼び出してJSON文字列を取得
      var calendarJson = callGemini(combinedText);

      // Geminiが ```json ... ``` を付けてしまうケースに備えてクリーニング
      var cleaned = calendarJson.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      var geminiResult;
      try {
        geminiResult = JSON.parse(cleaned);
      } catch (parseErr) {
        console.error('JSON parse error: ' + parseErr.toString() + '\nRaw response: ' + calendarJson);
        throw new Error('カレンダーデータの解析に失敗しました。再度スケジュールを送信してみてください。');
      }

      // Flex Message（Carousel）を組み立ててLINEにプッシュ送信
      // （デバウンス処理による遅延でreplyTokenが失効するため、Push APIを使用）
      var flexMessage = buildCarouselFlexMessage(geminiResult);
      pushFlexToLine(sourceId, flexMessage);
    } catch (err) {
      console.error('Error processing buffer for source ' + sourceId + ': ' + err.toString());
      
      // エラーメッセージをLINEに送信
      try {
        var errorMessage = '【エラー】カレンダー生成中にエラーが発生しました。\n' + err.toString();
        var errStr = err.toString();
        
        // Gemini APIの一時的なエラー（503や429など）または混雑エラーの場合
        if (errStr.indexOf('Gemini API エラー') !== -1 && (errStr.indexOf('503') !== -1 || errStr.indexOf('429') !== -1 || errStr.indexOf('UNAVAILABLE') !== -1)) {
          errorMessage = '【エラー】現在、Google側のAIサーバーが大変混雑しています。\n\n一時的な問題であるため、恐れ入りますが少し時間（数分〜数十分程度）を置いてから、再度スケジュールを送信してみてください。';
        }
        
        pushToLine(sourceId, errorMessage);
      } catch (replyErr) {
        console.error('Failed to send error reply: ' + replyErr.toString());
      }
    }
  }
}

/**
 * LINE Messaging APIを用いてプッシュメッセージを送信します。
 * 応答メッセージ (replyToken) は有効期限が非常に短いため、遅延処理を行う本Botではプッシュメッセージを使用します。
 * @param {string} toId 送信先ID（ユーザーID、グループID、またはルームID）
 * @param {string} text 送信するテキストメッセージ
 */
function pushToLine(toId, text) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN がスクリプトプロパティに設定されていません。');
  }

  // LINEのテキストメッセージ文字数上限（5000文字）を超えないようにカット
  if (text.length > 5000) {
    text = text.substring(0, 4990) + '\n...（省略されました）';
  }

  var url = 'https://api.line.me/v2/bot/message/push';
  var payload = {
    to: toId,
    messages: [
      {
        type: 'text',
        text: text
      }
    ]
  };

  var options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (responseCode !== 200) {
    throw new Error('LINE Push API エラー (ステータスコード: ' + responseCode + '): ' + responseText);
  }
}

/**
 * LINE Messaging API を用いてFlex Messageをプッシュ送信します。
 * @param {string} toId 送信先ID（ユーザーID、グループID、またはルームID）
 * @param {Object} flexMessage { altText: string, contents: Object } Flex Messageオブジェクト
 */
function pushFlexToLine(toId, flexMessage) {
  var token = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_ACCESS_TOKEN');
  if (!token) {
    throw new Error('LINE_CHANNEL_ACCESS_TOKEN がスクリプトプロパティに設定されていません。');
  }

  var url = 'https://api.line.me/v2/bot/message/push';
  var payload = {
    to: toId,
    messages: [
      {
        type: 'flex',
        altText: flexMessage.altText,
        contents: flexMessage.contents
      }
    ]
  };

  var options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url, options);
  var responseCode = response.getResponseCode();
  var responseText = response.getContentText();

  if (responseCode !== 200) {
    throw new Error('LINE Push API エラー (ステータスコード: ' + responseCode + '): ' + responseText);
  }
}

/**
 * GeminiのJSONからLINE Flex Message（単月はBubble、複数月はCarousel）を組み立てます。
 * @param {Object} geminiResult Geminiが返したパース済みJSONオブジェクト { months: Array }
 * @return {Object} { altText: string, contents: Object } LINE Flex Messageオブジェクト
 */
function buildCarouselFlexMessage(geminiResult) {
  var months = geminiResult.months || [];
  var bubbles = [];
  for (var i = 0; i < months.length; i++) {
    bubbles.push(buildMonthBubble(months[i]));
  }

  // altText生成（例: "2026年7月・8月のカレンダー"）
  var altTextParts = [];
  for (var j = 0; j < months.length; j++) {
    var parts = months[j].target_month.split('-');
    altTextParts.push(parseInt(parts[0], 10) + '年' + parseInt(parts[1], 10) + '月');
  }
  var altText = altTextParts.join('・') + 'のカレンダー';

  // バブルが1つならBubble、複数ならCarouselとして送信
  var contents;
  if (bubbles.length === 1) {
    contents = bubbles[0];
  } else {
    contents = {
      type: 'carousel',
      contents: bubbles
    };
  }

  return { altText: altText, contents: contents };
}

/**
 * 1ヶ月分のカレンダーBubble Flex Messageオブジェクトを組み立てます。
 * 日曜始まりのグリッドレイアウトで、⚠️イベントはフッターに補足テキストを追加します。
 * @param {Object} monthData { target_month: "YYYY-MM", is_main: boolean, events: Array }
 * @return {Object} Bubble Flex Messageオブジェクト
 */
function buildMonthBubble(monthData) {
  var targetMonth = monthData.target_month;
  var events = monthData.events || [];
  // is_mainが明示されていない場合はtrueとして扱う
  var isMain = (monthData.is_main !== false);

  // 年・月を文字列から安全にパース
  var monthParts = targetMonth.split('-');
  var year = parseInt(monthParts[0], 10);
  var month = parseInt(monthParts[1], 10);

  // 1日の曜日（0=日, 1=月, ..., 6=土）と月末日を計算
  var firstDayOfWeek = new Date(year, month - 1, 1).getDay();
  var lastDay = new Date(year, month, 0).getDate();

  // events配列をタイムゾーン安全な日付パース（文字列のまま処理）でマッピング
  var eventMap = {};
  for (var k = 0; k < events.length; k++) {
    var ev = events[k];
    var d = parseInt(ev.date.split('-')[2], 10);
    eventMap[d] = ev;
  }

  // カレンダーグリッドの組み立て（日曜始まり）
  var calendarRows = [];
  var currentWeek = [];

  // 月初前の空白マスを埋める
  for (var i = 0; i < firstDayOfWeek; i++) {
    currentWeek.push(buildEmptyCell_());
  }

  // 1日〜末日をループしてマスを生成
  for (var day = 1; day <= lastDay; day++) {
    var dayEvent = eventMap[day];
    // is_main: trueの月はデフォルトを❌、is_main: falseの月はデフォルト空欄
    var status = dayEvent ? dayEvent.status : (isMain ? '❌' : '');
    currentWeek.push(buildDayCell_(day, status));

    // 7マス（土曜日）到達または末日で1週間分の行を確定
    if (currentWeek.length === 7 || day === lastDay) {
      // 末週の残りマスを空白で埋める
      while (currentWeek.length < 7) {
        currentWeek.push(buildEmptyCell_());
      }
      calendarRows.push({
        type: 'box',
        layout: 'horizontal',
        margin: 'sm',
        contents: currentWeek
      });
      currentWeek = [];
    }
  }

  // ⚠️補足テキスト（特別予定の詳細）の収集
  var notesContents = [];
  for (var n = 0; n < events.length; n++) {
    var noteEv = events[n];
    if (noteEv.status === '⚠️' && noteEv.note) {
      var noteDay = parseInt(noteEv.date.split('-')[2], 10);
      notesContents.push({
        type: 'text',
        text: '・' + noteDay + '日: ' + noteEv.note,
        size: 'xs',
        color: '#666666',
        wrap: true
      });
    }
  }

  // Bubble bodyの組み立て（タイトル・区切り・曜日ヘッダー・グリッド）
  var bodyContents = [
    {
      type: 'text',
      text: year + '年 ' + month + '月 スケジュール',
      weight: 'bold',
      size: 'md',
      color: '#111111'
    },
    { type: 'separator', margin: 'md' },
    {
      type: 'box',
      layout: 'horizontal',
      margin: 'md',
      contents: [
        { type: 'text', text: '日', size: 'xs', color: '#CC0000', align: 'center', weight: 'bold', flex: 1 },
        { type: 'text', text: '月', size: 'xs', color: '#111111', align: 'center', weight: 'bold', flex: 1 },
        { type: 'text', text: '火', size: 'xs', color: '#111111', align: 'center', weight: 'bold', flex: 1 },
        { type: 'text', text: '水', size: 'xs', color: '#111111', align: 'center', weight: 'bold', flex: 1 },
        { type: 'text', text: '木', size: 'xs', color: '#111111', align: 'center', weight: 'bold', flex: 1 },
        { type: 'text', text: '金', size: 'xs', color: '#111111', align: 'center', weight: 'bold', flex: 1 },
        { type: 'text', text: '土', size: 'xs', color: '#0055CC', align: 'center', weight: 'bold', flex: 1 }
      ]
    },
    { type: 'separator', margin: 'sm' }
  ].concat(calendarRows);

  var bubble = {
    type: 'bubble',
    size: 'mega',
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: 'md',
      contents: bodyContents
    }
  };

  // ⚠️補足がある場合のみフッターセクションを追加
  if (notesContents.length > 0) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: 'md',
      contents: [
        { type: 'text', text: '【⚠️ 特別な予定・変更】', size: 'xs', weight: 'bold', color: '#333333' }
      ].concat(notesContents)
    };
  }

  return bubble;
}

/**
 * カレンダーの1マス（日付＋ステータス記号）を生成します。
 * 空白マスと型を統一するためbox要素を使用します。
 * @param {number} day 日付（1〜31）
 * @param {string} status ステータス記号（🟣/❌/⚠️/空文字）
 * @return {Object} Flex Message box要素
 */
function buildDayCell_(day, status) {
  return {
    type: 'box',
    layout: 'vertical',
    alignItems: 'center',
    flex: 1,
    contents: [
      { type: 'text', text: String(day), size: 'xs', align: 'center', color: '#555555' },
      { type: 'text', text: status || ' ', size: 'sm', align: 'center', margin: 'xs' }
    ]
  };
}

/**
 * カレンダーの空白マス（月初・月末の余白埋め用）を生成します。
 * buildDayCell_と同じbox構造に統一することでレイアウト崩れを防ぎます。
 * @return {Object} Flex Message box要素
 */
function buildEmptyCell_() {
  return {
    type: 'box',
    layout: 'vertical',
    flex: 1,
    contents: [
      { type: 'text', text: ' ', size: 'xs', align: 'center' },
      { type: 'text', text: ' ', size: 'sm', align: 'center', margin: 'xs' }
    ]
  };
}
