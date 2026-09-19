'use strict';

// ============================================================
// GASグローバルオブジェクトのモック定義
// ============================================================

const mockProps = {
  GEMINI_API_KEY: 'test-gemini-key',
  LINE_CHANNEL_ACCESS_TOKEN: 'test-line-token'
};

global.PropertiesService = {
  getScriptProperties: jest.fn(() => ({
    getProperties: jest.fn(() => ({ ...mockProps })),
    getProperty: jest.fn((key) => mockProps[key] || null)
  }))
};

global.UrlFetchApp = {
  fetch: jest.fn()
};

global.Utilities = {
  sleep: jest.fn()
};

// ============================================================
// テスト対象モジュールのロード
// ============================================================
const {
  getSystemPrompt,
  getAvailableGeminiModels,
  callGemini,
  callGeminiWithRetry_
} = require('../src/gemini');

// ============================================================
// テストスイート
// ============================================================

beforeEach(() => {
  jest.clearAllMocks();

  global.PropertiesService.getScriptProperties.mockReturnValue({
    getProperties: jest.fn(() => ({ ...mockProps })),
    getProperty: jest.fn((key) => mockProps[key] || null)
  });
});

describe('Gemini 動的モデル選定 (getAvailableGeminiModels)', () => {
  test('APIキーがない場合はデフォルトモデルを返却すること', () => {
    const models = getAvailableGeminiModels('');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });

  test('利用可能モデル一覧からgenerateContent対応・Flash優先・バージョン降順でソートして最大3件返却すること', () => {
    const mockApiResponse = {
      models: [
        { name: 'models/gemini-1.5-pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.0-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-1.5-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/imagen-3.0-generate-002', supportedGenerationMethods: ['generateImages'] },
        { name: 'models/gemini-2.0-flash-exp', supportedGenerationMethods: ['generateContent'] }
      ]
    };

    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify(mockApiResponse)
    });

    const models = getAvailableGeminiModels('test-key');

    // gemini-2.5-flash -> gemini-2.5-flash-lite -> gemini-2.0-flash (上位3件)
    expect(models).toEqual([
      'gemini-2.5-flash',
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash'
    ]);
  });

  test('画像生成やTTS、音声、realtimeなどの特殊用途モデルが除外されること', () => {
    const mockApiResponse = {
      models: [
        { name: 'models/gemini-2.5-flash-image-preview', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-tts', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-audio', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-realtime', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
      ]
    };

    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify(mockApiResponse)
    });

    const models = getAvailableGeminiModels('test-key');
    expect(models).toEqual(['gemini-2.5-flash']);
  });

  test('API呼び出しでエラー（HTTP 500等）が発生した場合はデフォルトモデルへ安全にフォールバックすること', () => {
    global.UrlFetchApp.fetch.mockReturnValue({
      getResponseCode: () => 500,
      getContentText: () => 'Internal Server Error'
    });

    const models = getAvailableGeminiModels('test-key');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });

  test('ネットワーク例外が発生した場合はデフォルトモデルへ安全にフォールバックすること', () => {
    global.UrlFetchApp.fetch.mockImplementation(() => {
      throw new Error('Network error');
    });

    const models = getAvailableGeminiModels('test-key');
    expect(models).toEqual(['gemini-2.5-flash', 'gemini-2.5-flash-lite']);
  });
});

describe('callGemini API呼び出し・フォールバック・リトライ', () => {
  const sampleScheduleText = '7月5日 10:00 レッスン\n7月12日 10:00 レッスン';
  const expectedJsonString = JSON.stringify({
    months: [
      {
        target_month: '2026-07',
        is_main: true,
        events: [
          { date: '2026-07-05', status: '🟣', note: '' },
          { date: '2026-07-12', status: '🟣', note: '' }
        ]
      }
    ]
  });

  test('第1候補モデルで正常にJSONが生成された場合、テキストが返却されること', () => {
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('/models?')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      if (url.includes('gemini-2.5-flash:generateContent')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: expectedJsonString }]
                }
              }
            ]
          })
        };
      }
      return { getResponseCode: () => 404, getContentText: () => 'Not Found' };
    });

    const result = callGemini(sampleScheduleText);
    expect(result).toBe(expectedJsonString);
  });

  test('第1候補モデルで404エラー発生時、第2候補モデルへ自動フォールバックすること', () => {
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('/models?')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      if (url.includes('gemini-2.5-flash:generateContent')) {
        return {
          getResponseCode: () => 404,
          getContentText: () => 'Model not found'
        };
      }
      if (url.includes('gemini-2.5-flash-lite:generateContent')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: expectedJsonString }]
                }
              }
            ]
          })
        };
      }
      return { getResponseCode: () => 404, getContentText: () => 'Not Found' };
    });

    const result = callGemini(sampleScheduleText);
    expect(result).toBe(expectedJsonString);
  });

  test('レートリミット（429）発生時は即座に例外をスローすること（サーキットブレーカー）', () => {
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('/models?')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      if (url.includes(':generateContent')) {
        return {
          getResponseCode: () => 429,
          getContentText: () => 'RESOURCE_EXHAUSTED: Quota exceeded'
        };
      }
      return { getResponseCode: () => 404, getContentText: () => 'Not Found' };
    });

    expect(() => {
      callGemini(sampleScheduleText);
    }).toThrow(/Gemini API エラー \(ステータスコード: 429\)/);
  });

  test('一時的エラー（503）発生時にリトライを実行し、成功すること', () => {
    let callCount = 0;
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('/models?')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      if (url.includes(':generateContent')) {
        callCount++;
        if (callCount === 1) {
          return {
            getResponseCode: () => 503,
            getContentText: () => 'Service Unavailable'
          };
        }
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: expectedJsonString }]
                }
              }
            ]
          })
        };
      }
      return { getResponseCode: () => 404, getContentText: () => 'Not Found' };
    });

    const result = callGemini(sampleScheduleText);
    expect(result).toBe(expectedJsonString);
    expect(callCount).toBe(2);
    expect(global.Utilities.sleep).toHaveBeenCalledTimes(1);
  });

  test('GEMINI_MODEL がプロパティに設定されている場合は最優先で試行されること', () => {
    global.PropertiesService.getScriptProperties.mockReturnValue({
      getProperties: jest.fn(() => ({
        ...mockProps,
        GEMINI_MODEL: 'custom-gemini-model'
      })),
      getProperty: jest.fn((key) => {
        if (key === 'GEMINI_MODEL') return 'custom-gemini-model';
        return mockProps[key] || null;
      })
    });

    const requestedModels = [];
    global.UrlFetchApp.fetch.mockImplementation((url) => {
      if (url.includes('/models?')) {
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            models: [
              { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }
            ]
          })
        };
      }
      const modelMatch = url.match(/models\/([^:]+):generateContent/);
      if (modelMatch) {
        requestedModels.push(modelMatch[1]);
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: expectedJsonString }]
                }
              }
            ]
          })
        };
      }
      return { getResponseCode: () => 404, getContentText: () => 'Not Found' };
    });

    const result = callGemini(sampleScheduleText);
    expect(result).toBe(expectedJsonString);
    expect(requestedModels[0]).toBe('custom-gemini-model');
  });
});
