import { http } from '@google-cloud/functions-framework';
import { GoogleGenAI } from '@google/genai';
import { Firestore } from '@google-cloud/firestore';

const TARGET_SCORE = 80;
const MAX_IMPROVEMENTS = 2;

const GEMINI_MAX_RETRIES = 3;
const GEMINI_RETRY_BASE_MS = 1000;

const db = new Firestore({
  projectId: 'eco-diode-508102-q7',
  databaseId: 'default'
});

// -------------------------
// Logging
// -------------------------

function logEvent(event, data = {}) {
  console.log(
    JSON.stringify({
      severity: 'INFO',
      event,
      timestamp: new Date().toISOString(),
      ...data
    })
  );
}

function logError(event, error, data = {}) {
  console.error(
    JSON.stringify({
      severity: 'ERROR',
      event,
      timestamp: new Date().toISOString(),
      message: error?.message ?? String(error),
      stack: error?.stack,
      ...data
    })
  );
}

// -------------------------
// Firestore
// -------------------------

async function saveReviewHistory(data) {
  const docRef = await db.collection('reviewHistories').add({
    createdAt: new Date(),
    ...data
  });

  return docRef.id;
}

async function getReviewHistories(limit = 20) {
  const snapshot = await db
    .collection('reviewHistories')
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get();

  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

// -------------------------
// Utility
// -------------------------

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function parseJson(text) {
  const cleaned = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  return JSON.parse(cleaned);
}

function formatDate(value) {
  if (!value) {
    return '';
  }

  const date =
    typeof value.toDate === 'function'
      ? value.toDate()
      : new Date(value);

  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// -------------------------
// Gemini：429対策付き呼び出し
// -------------------------

async function generateContentWithRetry(
  ai,
  options,
  maxRetries = GEMINI_MAX_RETRIES
) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent(options);

      if (attempt > 0) {
        logEvent('gemini_retry_succeeded', {
          attempt
        });
      }

      return response;

    } catch (error) {
      lastError = error;

      const message = error?.message ?? String(error);
      const status = error?.status ?? error?.code;

      const is429 =
        status === 429 ||
        status === '429' ||
        message.includes('429') ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('Resource exhausted');

      // 429以外なら即エラー
      if (!is429) {
        logError('gemini_non_retryable_error', error, {
          attempt
        });

        throw error;
      }

      // 最大回数まで試した場合
      if (attempt === maxRetries) {
        logError('gemini_retry_exhausted', error, {
          attempts: attempt + 1
        });

        throw error;
      }

      // 指数バックオフ
      // 1秒 → 2秒 → 4秒
      const waitMs =
        GEMINI_RETRY_BASE_MS * Math.pow(2, attempt);

      // 少しだけランダムな待ち時間を追加
      const jitterMs =
        Math.floor(Math.random() * 500);

      const totalWaitMs =
        waitMs + jitterMs;

      logEvent('gemini_retry', {
        attempt: attempt + 1,
        waitMs: totalWaitMs
      });

      await sleep(totalWaitMs);
    }
  }

  throw lastError;
}

// -------------------------
// Gemini：文章評価
// -------------------------

async function reviewText(ai, text) {
  const prompt = `
あなたは文章レビューの専門家です。

以下の文章を100点満点で評価してください。

評価基準：
- 分かりやすさ
- 具体性
- 説得力
- 読みやすさ

必ずJSONだけを返してください。
Markdownのコードブロックは使わないでください。

形式：
{
  "score": 75,
  "goodPoints": [
    "良い点1",
    "良い点2"
  ],
  "improvements": [
    "改善点1",
    "改善点2"
  ]
}

評価する文章：
${text}
`;

  const response = await generateContentWithRetry(ai, {
    model: 'gemini-2.5-flash',
    contents: prompt
  });

  return parseJson(response.text);
}

// -------------------------
// Gemini：文章改善
// -------------------------

async function improveText(ai, text, review) {
  const prompt = `
あなたは優秀な文章編集者です。

次の文章は100点満点中 ${review.score} 点でした。

改善点：
${review.improvements.map(item => `- ${item}`).join('\n')}

元の文章：
${text}

元の文章の意図を変えずに、
より分かりやすく、具体的で、説得力があり、
読みやすい文章へ改善してください。

改善後の文章だけを返してください。
解説や前置きは不要です。
`;

  const response = await generateContentWithRetry(ai, {
    model: 'gemini-2.5-flash',
    contents: prompt
  });

  return response.text.trim();
}

// -------------------------
// Cloud Run Entry Point
// -------------------------

http('helloHttp', async (req, res) => {

  // -------------------------
  // GET：履歴一覧
  // -------------------------

  if (req.method === 'GET' && req.path === '/history') {
    try {
      const histories = await getReviewHistories(20);

      const historyHtml = histories.length === 0
        ? `
          <p>まだ履歴がありません。</p>
        `
        : histories.map(item => `
          <section class="history-card">

            <div class="history-date">
              ${escapeHtml(formatDate(item.createdAt))}
            </div>

            <div class="scores">

              <span class="initial-score">
                ${item.initialScore ?? '-'}点
              </span>

              <span class="arrow">
                →
              </span>

              <span class="final-score">
                ${item.finalScore ?? '-'}点
              </span>

            </div>

            <p>
              改善回数：
              <strong>
                ${item.improvementCount ?? 0}回
              </strong>
            </p>

            <p>
              目標達成：
              <strong>
                ${item.targetReached
                  ? '✅ 達成'
                  : '⚠️ 未達成'}
              </strong>
            </p>

            <h3>元の文章</h3>

            <div class="text">
              ${escapeHtml(item.originalText ?? '')}
            </div>

            <h3>最終文章</h3>

            <div class="text">
              ${escapeHtml(item.finalText ?? '')}
            </div>

          </section>
        `).join('');

      res.set(
        'Content-Type',
        'text/html; charset=utf-8'
      );

      res.send(`
        <!DOCTYPE html>
        <html lang="ja">

        <head>
          <meta charset="UTF-8">
          <title>
            AI文章レビュー履歴
          </title>

          <style>
            body {
              font-family: sans-serif;
              max-width: 900px;
              margin: 40px auto;
              padding: 20px;
              line-height: 1.6;
            }

            .history-card {
              background: #f5f5f5;
              padding: 25px;
              margin-bottom: 25px;
              border-radius: 10px;
            }

            .history-date {
              color: #666;
              margin-bottom: 10px;
            }

            .scores {
              font-size: 28px;
              font-weight: bold;
              margin-bottom: 10px;
            }

            .initial-score {
              color: #666;
            }

            .arrow {
              margin: 0 12px;
            }

            .final-score {
              color: #0b57d0;
            }

            .text {
              white-space: pre-wrap;
              background: white;
              padding: 15px;
              border-radius: 6px;
              margin-bottom: 15px;
            }

            a {
              display: inline-block;
              margin-bottom: 25px;
            }
          </style>
        </head>

        <body>

          <h1>
            AI文章レビュー履歴
          </h1>

          <a href="/">
            ← AI文章レビューに戻る
          </a>

          ${historyHtml}

        </body>

        </html>
      `);

    } catch (error) {

      logError(
        'history_load_failed',
        error
      );

      res.status(500).send(
        `履歴取得エラー: ${error.message}`
      );
    }

    return;
  }

  // -------------------------
  // GET：入力画面
  // -------------------------

  if (req.method === 'GET') {
    res.set(
      'Content-Type',
      'text/html; charset=utf-8'
    );

    res.send(`
      <!DOCTYPE html>
      <html lang="ja">

      <head>

        <meta charset="UTF-8">

        <title>
          AI文章レビュー
        </title>

        <style>

          body {
            font-family: sans-serif;
            max-width: 900px;
            margin: 40px auto;
            padding: 20px;
          }

          textarea {
            width: 100%;
            height: 220px;
            font-size: 16px;
            padding: 10px;
            box-sizing: border-box;
          }

          button {
            margin-top: 15px;
            padding: 12px 24px;
            font-size: 16px;
            cursor: pointer;
          }

          .description {
            color: #555;
            margin-bottom: 20px;
          }

          .history-link {
            display: inline-block;
            margin-top: 25px;
          }

        </style>

      </head>

      <body>

        <h1>
          AI文章レビュー
        </h1>

        <p class="description">
          Geminiが文章を評価し、
          80点未満の場合は最大2回まで自動改善します。
        </p>

        <form method="POST">

          <textarea
            name="text"
            placeholder="評価したい文章を入力してください"
            required
          ></textarea>

          <br>

          <button type="submit">
            AIで評価・改善する
          </button>

        </form>

        <a
          class="history-link"
          href="/history"
        >
          過去の履歴を見る
        </a>

      </body>

      </html>
    `);

    return;
  }

  // -------------------------
  // POST：評価＋自己改善
  // -------------------------

  if (req.method === 'POST') {

    const startedAt = Date.now();

    try {

      const originalText =
        req.body?.text;

      if (!originalText) {

        logEvent(
          'review_rejected',
          {
            reason: 'empty_text'
          }
        );

        res.status(400).send(
          '文章を入力してください。'
        );

        return;
      }

      logEvent(
        'review_started',
        {
          originalTextLength:
            originalText.length,
          targetScore:
            TARGET_SCORE,
          maxImprovements:
            MAX_IMPROVEMENTS
        }
      );

      const ai =
        new GoogleGenAI({
          vertexai: true,
          project:
            'eco-diode-508102-q7',
          location:
            'global'
        });

      let currentText =
        originalText;

      const history = [];

      // -------------------------
      // 最初の評価
      // -------------------------

      let review =
        await reviewText(
          ai,
          currentText
        );

      history.push({
        step: 0,
        text: currentText,
        review
      });

      logEvent(
        'initial_review_completed',
        {
          score:
            review.score,

          goodPointCount:
            review.goodPoints?.length ?? 0,

          improvementCount:
            review.improvements?.length ?? 0
        }
      );

      // -------------------------
      // 自己改善ループ
      // -------------------------

      for (
        let improvementCount = 1;
        improvementCount <= MAX_IMPROVEMENTS;
        improvementCount++
      ) {

        if (
          review.score >= TARGET_SCORE
        ) {

          logEvent(
            'target_score_reached',
            {
              score:
                review.score,

              improvementCount:
                improvementCount - 1
            }
          );

          break;
        }

        logEvent(
          'improvement_started',
          {
            improvementCount,
            previousScore:
              review.score
          }
        );

        currentText =
          await improveText(
            ai,
            currentText,
            review
          );

        review =
          await reviewText(
            ai,
            currentText
          );

        history.push({
          step:
            improvementCount,

          text:
            currentText,

          review
        });

        logEvent(
          'improvement_review_completed',
          {
            improvementCount,
            score:
              review.score
          }
        );
      }

      // -------------------------
      // 最終結果
      // -------------------------

      const finalScore =
        history[
          history.length - 1
        ].review.score;

      const totalImprovements =
        history.length - 1;

      const targetReached =
        finalScore >= TARGET_SCORE;

      logEvent(
        'review_completed',
        {
          finalScore,
          targetReached,
          improvementCount:
            totalImprovements,
          durationMs:
            Date.now() - startedAt
        }
      );

      // -------------------------
      // Firestoreへ保存
      // -------------------------

      const historyId =
        await saveReviewHistory({
          originalText,
          finalText:
            currentText,
          initialScore:
            history[0].review.score,
          finalScore,
          improvementCount:
            totalImprovements,
          targetReached
        });

      logEvent(
        'firestore_saved',
        {
          historyId
        }
      );

      // -------------------------
      // 結果HTML
      // -------------------------

      const historyHtml =
        history.map(
          (item, index) => {

            const title =
              index === 0
                ? '最初の評価'
                : `改善 ${index} 回目`;

            const goodPoints =
              item.review.goodPoints
                .map(
                  point =>
                    `<li>${escapeHtml(point)}</li>`
                )
                .join('');

            const improvements =
              item.review.improvements
                .map(
                  point =>
                    `<li>${escapeHtml(point)}</li>`
                )
                .join('');

            return `
              <section class="review">

                <h2>
                  ${title}
                </h2>

                <div class="score">
                  ${item.review.score}点
                </div>

                <h3>
                  文章
                </h3>

                <div class="text">
                  ${escapeHtml(item.text)}
                </div>

                <h3>
                  良い点
                </h3>

                <ul>
                  ${goodPoints}
                </ul>

                <h3>
                  改善点
                </h3>

                <ul>
                  ${improvements}
                </ul>

              </section>
            `;
          }
        ).join('');

      const status =
        targetReached
          ? `✅ 目標の${TARGET_SCORE}点を達成しました`
          : `⚠️ 最大改善回数に到達しました`;

      res.set(
        'Content-Type',
        'text/html; charset=utf-8'
      );

      res.send(`
        <!DOCTYPE html>
        <html lang="ja">

        <head>

          <meta charset="UTF-8">

          <title>
            AI文章レビュー結果
          </title>

          <style>

            body {
              font-family: sans-serif;
              max-width: 900px;
              margin: 40px auto;
              padding: 20px;
            }

            .summary {
              background: #eef6ff;
              padding: 20px;
              border-radius: 10px;
              margin-bottom: 30px;
            }

            .review {
              background: #f5f5f5;
              padding: 25px;
              margin-bottom: 25px;
              border-radius: 10px;
            }

            .score {
              font-size: 32px;
              font-weight: bold;
              margin: 15px 0;
            }

            .text {
              white-space: pre-wrap;
              background: white;
              padding: 15px;
              border-radius: 6px;
              line-height: 1.7;
            }

            a {
              display: inline-block;
              margin-top: 20px;
              margin-right: 20px;
            }

          </style>

        </head>

        <body>

          <h1>
            AI文章レビュー結果
          </h1>

          <div class="summary">

            <h2>
              ${status}
            </h2>

            <p>
              最終スコア：
              <strong>
                ${finalScore}点
              </strong>
            </p>

            <p>
              自動改善回数：
              <strong>
                ${totalImprovements}回
              </strong>
            </p>

            <p>
              履歴ID：
              <strong>
                ${historyId}
              </strong>
            </p>

          </div>

          ${historyHtml}

          <a href="/">
            もう一度評価する
          </a>

          <a href="/history">
            過去の履歴を見る
          </a>

        </body>

        </html>
      `);

    } catch (error) {

      logError(
        'review_failed',
        error,
        {
          durationMs:
            Date.now() - startedAt
        }
      );

      const message =
        error?.message ?? String(error);

      const is429 =
        message.includes('429') ||
        message.includes('RESOURCE_EXHAUSTED') ||
        message.includes('Resource exhausted');

      if (is429) {
        res.status(503).send(`
          <!DOCTYPE html>
          <html lang="ja">

          <head>
            <meta charset="UTF-8">
            <title>一時的に混雑しています</title>

            <style>
              body {
                font-family: sans-serif;
                max-width: 700px;
                margin: 60px auto;
                padding: 20px;
              }

              .error-box {
                background: #fff3e0;
                padding: 25px;
                border-radius: 10px;
              }

              a {
                display: inline-block;
                margin-top: 20px;
              }
            </style>

          </head>

          <body>

            <div class="error-box">

              <h1>
                Geminiが一時的に混雑しています
              </h1>

              <p>
                自動で複数回再試行しましたが、
                現在Geminiを利用しにくい状態です。
              </p>

              <p>
                少し時間を置いてから、
                もう一度お試しください。
              </p>

            </div>

            <a href="/">
              AI文章レビューに戻る
            </a>

          </body>

          </html>
        `);

        return;
      }

      res.status(500).send(
        `Gemini呼び出しエラー: ${escapeHtml(message)}`
      );
    }

    return;
  }

  logEvent(
    'method_not_allowed',
    {
      method:
        req.method
    }
  );

  res.status(405).send(
    'Method Not Allowed'
  );
});
