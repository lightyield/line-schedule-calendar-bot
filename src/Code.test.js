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
  buildCarouselFlexMessage,
  buildMonthBubble,
  containsDate_
} = require('./Code');

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

describe('Flex Message 構築 (buildCarouselFlexMessage / buildMonthBubble)', () => {
  test('単月データからBubble Flex Messageを構築できること', () => {
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

    const flex = buildCarouselFlexMessage(data);
    expect(flex.altText).toBe('2026年7月のカレンダー');
    expect(flex.contents.type).toBe('bubble');
    expect(flex.contents.body).toBeDefined();
    expect(flex.contents.footer).toBeDefined(); // ⚠️があるためfooterが生成される
  });

  test('複数月データからCarousel Flex Messageを構築できること', () => {
    const data = {
      months: [
        {
          target_month: '2026-08',
          is_main: false,
          events: [{ date: '2026-08-01', status: '🟣', note: '' }]
        },
        {
          target_month: '2026-07',
          is_main: true,
          events: [{ date: '2026-07-05', status: '🟣', note: '' }]
        }
      ]
    };

    const flex = buildCarouselFlexMessage(data);
    expect(flex.altText).toBe('2026年7月・2026年8月のカレンダー'); // ソートされて7月・8月順
    expect(flex.contents.type).toBe('carousel');
    expect(flex.contents.contents.length).toBe(2);
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
