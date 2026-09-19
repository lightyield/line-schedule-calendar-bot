'use strict';

// ============================================================
// GASグローバルオブジェクトのモック定義
// ============================================================

const mockProps = {
  GEMINI_API_KEY: 'test-gemini-key',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token',
  SPREADSHEET_ID: 'test-ss-id'
};

global.PropertiesService = {
  getScriptProperties: jest.fn(() => ({
    getProperties: jest.fn(() => ({ ...mockProps })),
    getProperty: jest.fn((key) => mockProps[key] || null),
    setProperty: jest.fn()
  }))
};

const mockTextOutput = {
  setMimeType: jest.fn().mockReturnThis()
};

global.ContentService = {
  createTextOutput: jest.fn(() => mockTextOutput),
  MimeType: { JSON: 'application/json' }
};

global.UrlFetchApp = {
  fetch: jest.fn()
};

const mockSheet = {
  getLastRow: jest.fn(() => 0),
  getRange: jest.fn(() => ({
    getValues: jest.fn(() => []),
    setValue: jest.fn()
  })),
  appendRow: jest.fn(),
  deleteRows: jest.fn(),
  insertSheet: jest.fn()
};

const mockSpreadsheet = {
  getSheetByName: jest.fn(() => mockSheet),
  insertSheet: jest.fn(() => mockSheet),
  getId: jest.fn(() => 'test-ss-id')
};

global.SpreadsheetApp = {
  getActiveSpreadsheet: jest.fn(() => mockSpreadsheet),
  openById: jest.fn(() => mockSpreadsheet)
};

const mockTriggerBuilder = {
  timeBased: jest.fn().mockReturnThis(),
  after: jest.fn().mockReturnThis(),
  create: jest.fn()
};

global.ScriptApp = {
  getProjectTriggers: jest.fn(() => []),
  deleteTrigger: jest.fn(),
  newTrigger: jest.fn(() => mockTriggerBuilder)
};

global.Utilities = {
  sleep: jest.fn()
};

// ============================================================
// テスト対象モジュールのロード
// ============================================================
const {
  doPost,
  getSourceId,
  setupDebounceTrigger,
  cleanupTriggers,
  correctYears_,
  buildCalendarFlexMessages,
  buildCarouselFlexMessage,
  buildMonthBubble,
  pushFlexToLine,
  containsDate_
} = require('../src/Code');

// ============================================================
// テストスイート
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();

  global.PropertiesService.getScriptProperties.mockReturnValue({
    getProperties: jest.fn(() => ({ ...mockProps })),
    getProperty: jest.fn((key) => mockProps[key] || null),
    setProperty: jest.fn()
  });

  global.ContentService.createTextOutput.mockReturnValue(mockTextOutput);
  mockTextOutput.setMimeType.mockReturnThis();

  global.SpreadsheetApp.getActiveSpreadsheet.mockReturnValue(mockSpreadsheet);
  mockSpreadsheet.getSheetByName.mockReturnValue(mockSheet);
  mockSpreadsheet.insertSheet.mockReturnValue(mockSheet);

  global.ScriptApp.getProjectTriggers.mockReturnValue([]);
  global.ScriptApp.newTrigger.mockReturnValue(mockTriggerBuilder);
});

describe('日付判定ロジック (containsDate_)', () => {
  test('日本語の日付表現を検出できること', () => {
    expect(containsDate_('7月5日 レッスン')).toBe(true);
    expect(containsDate_('7月のスケジュール')).toBe(true);
    expect(containsDate_('明日の予定')).toBe(true);
    expect(containsDate_('来週月曜日')).toBe(true);
  });

  test('スラッシュやハイフン区切りの日付を検出できること', () => {
    expect(containsDate_('7/5 10:00')).toBe(true);
    expect(containsDate_('2026-07-05 練習')).toBe(true);
    expect(containsDate_('07-05 合宿')).toBe(true);
    expect(containsDate_('7.5 発表会')).toBe(true);
  });

  test('日付が含まれていないテキストでfalseを返すこと', () => {
    expect(containsDate_('こんにちは、よろしくお願いします。')).toBe(false);
    expect(containsDate_('お疲れ様です！')).toBe(false);
  });
});

describe('年補正ロジック (correctYears_)', () => {
  test('現在月以上の予定は現在年、過去月（翌年予定）は翌年に補正されること', () => {
    const input = {
      months: [
        {
          target_month: '2020-07',
          is_main: true,
          events: [
            { date: '2020-07-05', status: '🟣', note: '' }
          ]
        }
      ]
    };

    const result = correctYears_(input);
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;

    const expectedYear = (7 >= currentMonth) ? currentYear : (currentYear + 1);
    expect(result.months[0].target_month).toBe(`${expectedYear}-07`);
    expect(result.months[0].events[0].date).toBe(`${expectedYear}-07-05`);
  });
});

describe('Flex Message 構築 (buildCalendarFlexMessages / buildMonthBubble)', () => {
  test('単月データから単一のFlex Message配列を構築できること', () => {
    const data = {
      months: [
        {
          target_month: '2026-07',
          is_main: true,
          events: [
            { date: '2026-07-05', status: '🟣', note: '' },
            { date: '2026-07-12', status: '⚠️', note: '14:00〜 時間変更' }
          ]
        }
      ]
    };

    const flexMessages = buildCalendarFlexMessages(data);
    expect(flexMessages.length).toBe(1);
    expect(flexMessages[0].type).toBe('flex');
    expect(flexMessages[0].altText).toBe('2026年7月のカレンダー');
    expect(flexMessages[0].contents.type).toBe('bubble');
    expect(flexMessages[0].contents.body).toBeDefined();
    expect(flexMessages[0].contents.footer).toBeDefined(); // ⚠️があるためfooterが生成される
  });

  test('複数月データから各月独立したFlex Message配列（縦並び用）を構築できること', () => {
    const data = {
      months: [
        {
          target_month: '2026-10',
          is_main: false,
          events: [{ date: '2026-10-04', status: '⚠️', note: '10:30' }]
        },
        {
          target_month: '2026-09',
          is_main: true,
          events: [{ date: '2026-09-29', status: '🟣', note: '' }]
        }
      ]
    };

    const flexMessages = buildCalendarFlexMessages(data);
    expect(flexMessages.length).toBe(2);
    // target_month 昇順（9月 → 10月）にソートされていること
    expect(flexMessages[0].altText).toBe('2026年9月のカレンダー');
    expect(flexMessages[0].contents.type).toBe('bubble');
    expect(flexMessages[1].altText).toBe('2026年10月のカレンダー');
    expect(flexMessages[1].contents.type).toBe('bubble');
  });

  test('後方互換性エイリアス buildCarouselFlexMessage が動作すること', () => {
    const data = {
      months: [
        {
          target_month: '2026-07',
          is_main: true,
          events: [{ date: '2026-07-05', status: '🟣', note: '' }]
        },
        {
          target_month: '2026-08',
          is_main: false,
          events: [{ date: '2026-08-01', status: '🟣', note: '' }]
        }
      ]
    };

    const flex = buildCarouselFlexMessage(data);
    expect(flex.contents.type).toBe('carousel');
    expect(flex.contents.contents.length).toBe(2);
  });
});

describe('LINE プッシュ送信処理 (pushFlexToLine)', () => {
  test('複数のFlex Messageを1回のリクエストで送信できること', () => {
    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: () => 200,
      getContentText: () => '{"status":"ok"}'
    });

    const messages = [
      { type: 'flex', altText: '9月', contents: { type: 'bubble' } },
      { type: 'flex', altText: '10月', contents: { type: 'bubble' } }
    ];

    pushFlexToLine('group-123', messages);

    expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(1);
    const callArgs = global.UrlFetchApp.fetch.mock.calls[0];
    const payload = JSON.parse(callArgs[1].payload);
    expect(payload.to).toBe('group-123');
    expect(payload.messages.length).toBe(2);
    expect(payload.messages[0].altText).toBe('9月');
    expect(payload.messages[1].altText).toBe('10月');
  });

  test('6件以上のメッセージがある場合は5件ずつチャンク分割して送信すること', () => {
    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: () => 200,
      getContentText: () => '{"status":"ok"}'
    });

    const messages = [
      { type: 'flex', altText: '1月', contents: { type: 'bubble' } },
      { type: 'flex', altText: '2月', contents: { type: 'bubble' } },
      { type: 'flex', altText: '3月', contents: { type: 'bubble' } },
      { type: 'flex', altText: '4月', contents: { type: 'bubble' } },
      { type: 'flex', altText: '5月', contents: { type: 'bubble' } },
      { type: 'flex', altText: '6月', contents: { type: 'bubble' } }
    ];

    pushFlexToLine('group-123', messages);

    expect(global.UrlFetchApp.fetch).toHaveBeenCalledTimes(2);
    const payload1 = JSON.parse(global.UrlFetchApp.fetch.mock.calls[0][1].payload);
    const payload2 = JSON.parse(global.UrlFetchApp.fetch.mock.calls[1][1].payload);
    expect(payload1.messages.length).toBe(5);
    expect(payload2.messages.length).toBe(1);
  });
});

describe('Webhook 受信処理 (doPost)', () => {
  test('ペイロードがない場合はエラーを返すこと', () => {
    const res = doPost(null);
    expect(global.ContentService.createTextOutput).toHaveBeenCalled();
  });

  test('テキストメッセージを受信した場合にバッファシートに追加してデバウンストリガーをセットすること', () => {
    const event = {
      postData: {
        contents: JSON.stringify({
          events: [
            {
              type: 'message',
              message: { type: 'text', text: '7月5日 レッスン' },
              source: { userId: 'user-123' },
              timestamp: Date.now(),
              replyToken: 'reply-token-123'
            }
          ]
        })
      }
    };

    const res = doPost(event);
    expect(mockSheet.appendRow).toHaveBeenCalled();
    expect(global.ScriptApp.newTrigger).toHaveBeenCalled();
  });
});
