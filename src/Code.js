/**
 * LINE Schedule Calendar Bot - Google Apps Script
 * Main logic for handling webhook events, buffering, and scheduling processing triggers.
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
      // Gemini APIを呼び出し
      var calendarMarkdown = callGemini(combinedText);

      // LINEにプッシュメッセージを送信（デバウンス処理による遅延でreplyTokenが失効するため、Push APIを使用）
      pushToLine(sourceId, calendarMarkdown);
    } catch (err) {
      console.error('Error processing buffer for source ' + sourceId + ': ' + err.toString());
      
      // エラーメッセージをLINEに送信
      try {
        pushToLine(sourceId, '【エラー】カレンダー生成中にエラーが発生しました。\n' + err.toString());
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
