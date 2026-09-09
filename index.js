import { http } from '@google-cloud/functions-framework';
import { GoogleGenAI } from '@google/genai';

http('helloHttp', async (req, res) => {
  if (req.method === 'GET') {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`
      <!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <title>AI文章レビュー</title>
        <style>
          body {
            font-family: sans-serif;
            max-width: 800px;
            margin: 40px auto;
            padding: 20px;
          }

          textarea {
            width: 100%;
            height: 200px;
            font-size: 16px;
          }

          button {
            margin-top: 15px;
            padding: 12px 24px;
            font-size: 16px;
          }

          .result {
            margin-top: 30px;
            white-space: pre-wrap;
            background: #f5f5f5;
            padding: 20px;
          }
        </style>
      </head>

      <body>
        <h1>AI文章レビュー</h1>

        <form method="POST">
          <textarea
            name="text"
            placeholder="評価したい文章を入力してください"
            required
          ></textarea>

          <br>

          <button type="submit">
            AIで評価する
          </button>
        </form>
      </body>
      </html>
    `);

    return;
  }

  if (req.method === 'POST') {
    try {
      const text = req.body?.text;

      if (!text) {
        res.status(400).send('文章を入力してください。');
        return;
      }

      const ai = new GoogleGenAI({
        vertexai: true,
        project: 'eco-diode-508102-q7',
        location: 'global'
      });

      const prompt = `
あなたは文章レビューの専門家です。

以下の文章を100点満点で評価してください。

評価基準：
- 分かりやすさ
- 具体性
- 説得力
- 読みやすさ

必ず次の形式で日本語で回答してください。

評価：XX点

良い点：
・
・

改善点：
・
・

評価する文章：
${text}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      res.set('Content-Type', 'text/html; charset=utf-8');

      res.send(`
        <!DOCTYPE html>
        <html lang="ja">
        <head>
          <meta charset="UTF-8">
          <title>AI文章レビュー結果</title>
          <style>
            body {
              font-family: sans-serif;
              max-width: 800px;
              margin: 40px auto;
              padding: 20px;
            }

            .result {
              white-space: pre-wrap;
              background: #f5f5f5;
              padding: 20px;
              border-radius: 8px;
            }

            a {
              display: inline-block;
              margin-top: 20px;
            }
          </style>
        </head>

        <body>
          <h1>AI文章レビュー結果</h1>

          <div class="result">
${response.text}
          </div>

          <a href="/">もう一度評価する</a>
        </body>
        </html>
      `);

    } catch (error) {
      console.error(error);

      res.status(500).send(
        `Gemini呼び出しエラー: ${error.message}`
      );
    }

    return;
  }

  res.status(405).send('Method Not Allowed');
});
